import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { loadConfig } from "../src/core/config.ts";
import { createMemoryIo } from "../src/core/io.ts";
import {
  bridgeScriptCandidates,
  buildBridgeChildEnv,
  buildStatus,
  buildSuperviseCommand,
  classifyCommandLine,
  collectStopTargets,
  formatStatusJson,
  localTimestamp,
  localTimestampSeconds,
  readBridgeState,
  resolveBridgeScript,
  resolveNodeFor,
  rotateLogIfNeeded,
  runBridgeAction,
  selfEntryCandidates,
  sortStopTargets,
  statusExitCode,
  statusLines,
  superviseExitMarker,
  superviseNodeGoneMarker,
  superviseStartMarker,
  tailLog,
  writeBridgeState,
  type BridgeStatus,
  type StopTarget,
} from "../src/commands/bridge.ts";
import type { BridgeAction } from "../src/commands/types.ts";

// 这些测试只覆盖纯逻辑：不启动 bridge、不 kill 任何进程、不碰真实运行目录。
const OPTIONS = { json: false, lines: 40, follow: false, once: false };

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── 进程分类 ────────────────────────────────────────────────────────
test("classifyCommandLine 识别 bridge-server / 旧 bat / supervise / 无关进程", () => {
  const self = "C:\\Program Files\\lceda-connect\\dist\\cli.mjs";

  // 服务本体：命令行里带 bridge-server.mjs
  expect(classifyCommandLine('"C:\\node\\node.exe" "C:\\s\\bridge-server.mjs"', self)).toEqual({
    kind: "node",
    order: 2,
  });
  // 旧封装
  expect(classifyCommandLine("cmd.exe /c start-easyeda-bridge.bat", self)).toEqual({
    kind: "wrapper",
    order: 0,
  });
  // 本 CLI 的守护进程：新写法 `bridge supervise`
  expect(classifyCommandLine(`"C:\\node\\node.exe" "${self}" bridge supervise`, self)).toEqual({
    kind: "supervisor",
    order: 1,
  });
  // 旧脚本写法 `-Action supervise`
  expect(classifyCommandLine(`powershell.exe -File "${self}" -Action supervise`, self)).toEqual({
    kind: "supervisor",
    order: 1,
  });
  // 前台调试进程：`bridge run` 也算外层（会重拉子进程）
  expect(classifyCommandLine(`"C:\\node\\node.exe" "${self}" bridge run`, self)).toEqual({
    kind: "wrapper",
    order: 0,
  });
  // selfPath 对不上、也不是旧实现的脚本时不能误判
  expect(
    classifyCommandLine('powershell.exe -File "C:\\Tools\\other-tool.ps1" -Action supervise', self),
  ).toBeNull();
  // 无关进程 / 空命令行
  expect(classifyCommandLine("explorer.exe", self)).toBeNull();
  expect(classifyCommandLine("", self)).toBeNull();
  // 大小写不敏感（Windows 路径）
  expect(
    classifyCommandLine(
      `node "C:\\PROGRAM FILES\\LCEDA-CONNECT\\DIST\\CLI.MJS" bridge supervise`,
      self,
    ),
  ).toEqual({ kind: "supervisor", order: 1 });
});

test("classifyCommandLine 支持自定义标签", () => {
  const tags = { serviceTag: "other-server.mjs", legacyTag: "old-wrapper.bat" };
  expect(classifyCommandLine('"C:\\node\\node.exe" other-server.mjs', null, tags)).toEqual({
    kind: "node",
    order: 2,
  });
  expect(classifyCommandLine('"C:\\node\\node.exe" bridge-server.mjs', null, tags)).toBeNull();
});

test("selfEntryCandidates 覆盖同目录兄弟 bin，跨入口也能认出守护进程", () => {
  expect(selfEntryCandidates("C:\\app\\dist\\cli-bridge.mjs")).toEqual([
    "C:\\app\\dist\\cli-bridge.mjs",
    "C:\\app\\dist\\cli.mjs",
    "C:\\app\\dist\\cli-cdp.mjs",
  ]);

  const candidates = selfEntryCandidates("C:\\app\\dist\\cli-bridge.mjs");
  // 用 lceda-connect 入口起的守护进程，lceda-bridge 也要能 stop
  expect(classifyCommandLine('node "C:\\app\\dist\\cli.mjs" bridge supervise', candidates)).toEqual(
    {
      kind: "supervisor",
      order: 1,
    },
  );
  // 同目录里不相干的脚本不算我们自己的进程
  expect(
    classifyCommandLine('node "C:\\app\\dist\\tools.mjs" bridge supervise', candidates),
  ).toBeNull();
});

test("迁移期还活着的旧 PowerShell 守护进程也能被认出", () => {
  const self = selfEntryCandidates("C:\\app\\dist\\cli-bridge.mjs");
  const psSupervise =
    'pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "D:\\Tools\\bin\\lceda-bridge.ps1" -Action supervise';
  expect(classifyCommandLine(psSupervise, self)).toEqual({ kind: "supervisor", order: 1 });
  expect(
    classifyCommandLine('pwsh.exe -File "D:\\Tools\\bin\\lceda-bridge.ps1" -Action run', self),
  ).toEqual({ kind: "wrapper", order: 0 });
  // 只是读脚本内容，不是 bridge 进程
  expect(
    classifyCommandLine('pwsh.exe -Command "Get-Content D:\\Tools\\bin\\lceda-bridge.ps1"', self),
  ).toBeNull();
});

// ─── 杀进程顺序 ──────────────────────────────────────────────────────
test("collectStopTargets 按 wrapper → supervisor → node 排序并跳过自身", () => {
  const self = "D:\\app\\dist\\cli.mjs";
  const processes = [
    { pid: 30, name: "node.exe", commandLine: '"C:\\node\\node.exe" "C:\\s\\bridge-server.mjs"' },
    { pid: 20, name: "node.exe", commandLine: `node "${self}" bridge supervise` },
    { pid: 10, name: "cmd.exe", commandLine: "cmd.exe /c start-easyeda-bridge.bat" },
    { pid: 40, name: "notepad.exe", commandLine: "" },
    { pid: 50, name: "node.exe", commandLine: "node something-else.mjs" },
    { pid: 99, name: "node.exe", commandLine: `node "${self}" bridge supervise` },
  ];

  const targets = collectStopTargets(processes, self, 99);
  expect(targets.map((item) => [item.order, item.pid, item.kind])).toEqual([
    [0, 10, "wrapper"],
    [1, 20, "supervisor"],
    [2, 30, "node"],
  ]);
  // 自身进程（即使命令行匹配）必须被排除
  expect(targets.some((item) => item.pid === 99)).toBe(false);
});

test("sortStopTargets 同层按 pid 升序且不改动入参", () => {
  const targets: StopTarget[] = [
    { pid: 7, name: "b", commandLine: "", kind: "node", order: 2 },
    { pid: 3, name: "a", commandLine: "", kind: "node", order: 2 },
    { pid: 9, name: "c", commandLine: "", kind: "supervisor", order: 1 },
  ];
  expect(sortStopTargets(targets).map((item) => item.pid)).toEqual([9, 3, 7]);
  expect(targets.map((item) => item.pid)).toEqual([7, 3, 9]);
});

// ─── state.json ──────────────────────────────────────────────────────
test("state.json 读写、字段名与容错", () => {
  const dir = tempDir("lceda-bridge-state-");
  try {
    const file = path.join(dir, "state.json");
    expect(readBridgeState(file)).toBeNull();

    const state = {
      supervisorPid: 4321,
      node: "C:\\node\\node.exe",
      script: "C:\\s\\bridge-server.mjs",
      startedAt: "2026-11-14T17:31:50",
      log: "C:\\l\\bridge.log",
    };
    writeBridgeState(file, state);
    expect(readBridgeState(file)).toEqual(state);
    // 字段名必须与旧脚本一致（老 state.json / 外部脚本还在读）
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(state);

    fs.writeFileSync(file, "{ 不是 json", "utf8");
    expect(readBridgeState(file)).toBeNull();

    fs.writeFileSync(file, JSON.stringify({ supervisorPid: "123", node: 1 }), "utf8");
    expect(readBridgeState(file)).toEqual({
      supervisorPid: 123,
      // 标量一律按 PowerShell 的 [string] 语义转成字符串
      node: "1",
      script: "",
      startedAt: "",
      log: "",
    });

    fs.writeFileSync(file, "[]", "utf8");
    expect(readBridgeState(file)).toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 日志滚存 / tail ─────────────────────────────────────────────────
test("日志超过上限滚存为 .1，tailLog 处理边界", () => {
  const dir = tempDir("lceda-bridge-log-");
  try {
    const logFile = path.join(dir, "bridge.log");

    // 文件不存在：不滚存，也没有内容
    expect(rotateLogIfNeeded(logFile, 10)).toBe(false);
    expect(tailLog(logFile, 5)).toEqual([]);

    fs.writeFileSync(logFile, "a\nb\nc\n", "utf8");
    expect(rotateLogIfNeeded(logFile, 10)).toBe(false);
    expect(fs.existsSync(`${logFile}.1`)).toBe(false);

    expect(tailLog(logFile, 2)).toEqual(["b", "c"]);
    expect(tailLog(logFile, 0)).toEqual([]);
    expect(tailLog(logFile, 99)).toEqual(["a", "b", "c"]);

    // 超限 → 原名消失，内容进 .1
    const big = "x".repeat(64);
    fs.writeFileSync(logFile, big, "utf8");
    expect(rotateLogIfNeeded(logFile, 10)).toBe(true);
    expect(fs.existsSync(logFile)).toBe(false);
    expect(fs.readFileSync(`${logFile}.1`, "utf8")).toBe(big);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 子进程参数 ──────────────────────────────────────────────────────
test("buildSuperviseCommand 拼装 bridge supervise 与 --once", () => {
  const self = "C:\\app\\dist\\cli.mjs";
  const node = "C:\\node\\node.exe";
  expect(buildSuperviseCommand(self, node, { once: true })).toEqual({
    file: node,
    args: [self, "bridge", "supervise", "--once"],
  });
  expect(buildSuperviseCommand(self, node, { once: false })).toEqual({
    file: node,
    args: [self, "bridge", "supervise"],
  });
});

test("buildBridgeChildEnv 固定注入 NO_PROXY 与 LCEDA_* 覆盖", () => {
  const env = buildBridgeChildEnv(
    { PATH: "C:\\bin", no_proxy: "被覆盖掉" },
    "C:\\node\\node.exe",
    "C:\\s\\bridge-server.mjs",
  );
  expect(env.PATH).toBe("C:\\bin");
  expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
  expect(env.no_proxy).toBe("127.0.0.1,localhost");
  expect(env.LCEDA_NODE).toBe("C:\\node\\node.exe");
  expect(env.LCEDA_BRIDGE_SCRIPT).toBe("C:\\s\\bridge-server.mjs");
});

// ─── bridge-server.mjs 定位 ──────────────────────────────────────────
test("bridge-server.mjs 候选顺序与解析优先级一致", () => {
  const env = {
    USERPROFILE: "C:\\Users\\tester",
    LCEDA_BRIDGE_SCRIPT: "D:\\custom\\bridge-server.mjs",
  };
  expect(bridgeScriptCandidates(env)).toEqual([
    "D:\\custom\\bridge-server.mjs",
    "C:\\Users\\tester\\.workbuddy\\skills\\easyeda-api\\scripts\\bridge-server.mjs",
    "C:\\Users\\tester\\.claude\\skills\\easyeda-api\\scripts\\bridge-server.mjs",
  ]);
  expect(bridgeScriptCandidates({ USERPROFILE: "C:\\Users\\tester" })).toHaveLength(2);
});

test("resolveBridgeScript 先 LCEDA_BRIDGE_SCRIPT，再 workbuddy / claude", () => {
  const home = tempDir("lceda-bridge-home-");
  try {
    const env = { USERPROFILE: home };
    const cfg = loadConfig({ ...env, LOCALAPPDATA: path.join(home, "AppData", "Local") }, {});
    expect(resolveBridgeScript(cfg.bridge, env)).toBeNull();

    const workbuddy = path.join(home, ".workbuddy", "skills", "easyeda-api", "scripts");
    fs.mkdirSync(workbuddy, { recursive: true });
    const workbuddyScript = path.join(workbuddy, "bridge-server.mjs");
    fs.writeFileSync(workbuddyScript, "", "utf8");
    expect(resolveBridgeScript(cfg.bridge, env)).toBe(workbuddyScript);

    // 显式指定的脚本优先（即使 workbuddy 那份也在）
    const custom = path.join(home, "custom-bridge-server.mjs");
    fs.writeFileSync(custom, "", "utf8");
    expect(resolveBridgeScript({ ...cfg.bridge, bridgeScript: custom }, env)).toBe(custom);

    // 环境变量里带 LCEDA_BRIDGE_SCRIPT 时同样优先
    expect(resolveBridgeScript(cfg.bridge, { ...env, LCEDA_BRIDGE_SCRIPT: custom })).toBe(custom);

    // 全都找不到 → null
    expect(resolveBridgeScript(cfg.bridge, { USERPROFILE: path.join(home, "nowhere") })).toBeNull();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ─── node 解析（--node / LCEDA_NODE 钉死的路径）────────────────────────
test("resolveNodeFor 优先用钉死的 node 路径，跑不起来再回落候选链", async () => {
  const probe = async (exe: string): Promise<string | null> =>
    exe === "C:\\pinned\\node.exe" ? "v26.13.1" : null;
  const fallback = async (): Promise<{ path: string; version: string }> => ({
    path: "C:\\fallback\\node.exe",
    version: "v24.22.0",
  });

  // 钉死且能跑 → 直接用
  expect(await resolveNodeFor({ nodePath: "C:\\pinned\\node.exe" }, {}, probe, fallback)).toEqual({
    path: "C:\\pinned\\node.exe",
    version: "v26.13.1",
  });
  // 钉死的路径跑不起来 → 回落候选链（旧脚本同样跳过不可用候选）
  expect(await resolveNodeFor({ nodePath: "C:\\broken\\node.exe" }, {}, probe, fallback)).toEqual({
    path: "C:\\fallback\\node.exe",
    version: "v24.22.0",
  });
  // 没有钉死路径 → 直接走候选链
  expect(await resolveNodeFor({}, {}, probe, fallback)).toEqual({
    path: "C:\\fallback\\node.exe",
    version: "v24.22.0",
  });
});

// ─── status 对象 ─────────────────────────────────────────────────────
test("buildStatus 只在 health.service 命中时判定 healthy", () => {
  const base = {
    listeners: [{ port: 49621, pid: 800 }],
    saved: {
      supervisorPid: 700,
      node: "C:\\node\\node.exe",
      script: "C:\\s\\bridge-server.mjs",
      startedAt: "2026-11-14T17:31:50",
      log: "C:\\l\\bridge.log",
    },
    supervisorAlive: true,
    nodePath: "C:\\node\\node.exe",
    nodeVersion: "v26.13.0",
    scriptPath: "C:\\s\\bridge-server.mjs",
    logFile: "C:\\l\\bridge.log",
    serviceId: "easyeda-bridge",
  };

  const healthy = buildStatus({
    ...base,
    health: {
      service: "easyeda-bridge",
      edaConnected: true,
      edaWindowCount: 2,
      activeWindowId: "win-1",
      pendingRequests: 3,
    },
  });
  expect(healthy).toEqual({
    running: true,
    healthy: true,
    port: 49621,
    pid: 800,
    supervisor: true,
    supervisorPid: 700,
    node: "C:\\node\\node.exe",
    nodeVersion: "v26.13.0",
    edaConnected: true,
    edaWindows: 2,
    activeWindow: "win-1",
    pending: 3,
    script: "C:\\s\\bridge-server.mjs",
    logFile: "C:\\l\\bridge.log",
  });
  expect(statusExitCode(healthy, false)).toBe(0);
  expect(statusExitCode(healthy, true)).toBe(0);

  // 端口被别的服务占着：running 但不 healthy
  const foreign = buildStatus({ ...base, health: { service: "other-service" } });
  expect(foreign.running).toBe(true);
  expect(foreign.healthy).toBe(false);
  expect(foreign.edaConnected).toBe(false);
  expect(foreign.edaWindows).toBe(0);
  expect(foreign.activeWindow).toBe("");
  expect(foreign.pending).toBe(0);
  expect(statusExitCode(foreign, false)).toBe(1);
  // --json 模式旧脚本只看 running
  expect(statusExitCode(foreign, true)).toBe(0);

  // 完全没跑
  const down = buildStatus({
    ...base,
    listeners: [],
    health: null,
    saved: null,
    supervisorAlive: false,
    nodePath: null,
    nodeVersion: "",
    scriptPath: null,
  });
  expect(down.running).toBe(false);
  expect(down.port).toBe(0);
  expect(down.pid).toBe(0);
  expect(down.supervisor).toBe(false);
  expect(down.supervisorPid).toBe(0);
  expect(down.node).toBeNull();
  expect(down.nodeVersion).toBe("");
  expect(down.script).toBeNull();
  expect(statusExitCode(down, false)).toBe(1);
  expect(statusExitCode(down, true)).toBe(1);
});

test("formatStatusJson 字段顺序与旧脚本 --Json 一致", () => {
  const status: BridgeStatus = {
    running: false,
    healthy: false,
    port: 0,
    pid: 0,
    supervisor: false,
    supervisorPid: 0,
    node: null,
    nodeVersion: "",
    edaConnected: false,
    edaWindows: 0,
    activeWindow: "",
    pending: 0,
    script: null,
    logFile: "C:\\l\\bridge.log",
  };
  const keys = Object.keys(JSON.parse(formatStatusJson(status)));
  expect(keys).toEqual([
    "running",
    "healthy",
    "port",
    "pid",
    "supervisor",
    "supervisorPid",
    "node",
    "nodeVersion",
    "edaConnected",
    "edaWindows",
    "activeWindow",
    "pending",
    "script",
    "logFile",
  ]);
});

test("statusLines 未运行时的行文案", () => {
  const status: BridgeStatus = {
    running: false,
    healthy: false,
    port: 0,
    pid: 0,
    supervisor: false,
    supervisorPid: 0,
    node: null,
    nodeVersion: "",
    edaConnected: false,
    edaWindows: 0,
    activeWindow: "",
    pending: 0,
    script: null,
    logFile: "C:\\l\\bridge.log",
  };
  const text = statusLines(status, { portFirst: 49620, portLast: 49629 }, null).join("\n");
  expect(text).toContain("嘉立创 EDA Bridge");
  expect(text).toContain("服务状态");
  expect(text).toContain("未运行");
  expect(text).toContain("49620-49629 全部空闲");
  expect(text).toContain("没找到能用的 node.exe");
  expect(text).toContain("未找到 bridge-server.mjs");
  expect(text).toContain("(还没有)");

  const ran = statusLines(
    {
      ...status,
      running: true,
      healthy: true,
      port: 49620,
      pid: 4321,
      edaConnected: true,
      edaWindows: 2,
      activeWindow: "win-abc",
      pending: 1,
      script: "C:\\s\\bridge-server.mjs",
    },
    { portFirst: 49620, portLast: 49629 },
    2048,
  ).join("\n");
  expect(ran).toContain("运行中");
  expect(ran).toContain("49620   (pid 4321)");
  expect(ran).toContain("健康检查");
  expect(ran).toContain("已连接 · 2 个窗口");
  expect(ran).toContain("活动窗口");
  expect(ran).toContain("待处理数");
  expect(ran).toContain("2 KB");
});

// ─── 时间戳 / 守护进程日志标记 ────────────────────────────────────────
test("时间戳与守护进程日志标记格式", () => {
  const date = new Date(2026, 0, 2, 3, 4, 5);
  expect(localTimestamp(date)).toBe("2026-01-02 03:04:05");
  expect(localTimestampSeconds(date)).toBe("2026-01-02T03:04:05");
  expect(superviseStartMarker("2026-01-02 03:04:05")).toBe(
    "\r\n===== 2026-01-02 03:04:05 start bridge =====\n",
  );
  expect(superviseExitMarker("2026-01-02 03:04:05", 7)).toBe(
    "===== 2026-01-02 03:04:05 exited (code 7) =====\n",
  );
  expect(superviseNodeGoneMarker("2026-01-02 03:04:05", "C:\\node\\node.exe")).toBe(
    "===== 2026-01-02 03:04:05 原 node 已不存在，重新解析: C:\\node\\node.exe =====\n",
  );
});

// ─── 入口：别名与未知动作（只跑不碰系统的分支）─────────────────────────
test("runBridgeAction 的 help 与未知动作", async () => {
  const env = {
    USERPROFILE: "C:\\Users\\tester",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  };
  const cfg = loadConfig(env, {});

  const helpIo = createMemoryIo();
  expect(await runBridgeAction("help", OPTIONS, { cfg, io: helpIo, env })).toBe(0);
  const helpText = helpIo.lines.join("\n");
  expect(helpText).toContain("lceda-bridge");
  expect(helpText).toContain("49620-49629");
  expect(helpText).toContain("bridge.log");

  const badIo = createMemoryIo();
  expect(await runBridgeAction("nope" as BridgeAction, OPTIONS, { cfg, io: badIo, env })).toBe(1);
  expect(badIo.lines.join("\n")).toContain("不认识的命令");
});
