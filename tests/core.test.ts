import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { CDP_OPTIONS, bridgeHelp, cdpHelp, globalHelp, main, packageVersion } from "../src/main.ts";
import {
  CliUsageError,
  boolValue,
  numberValue,
  parseArgs,
  stringValue,
} from "../src/core/cliArgs.ts";
import { loadConfig, DEFAULT_PRO_EXE } from "../src/core/config.ts";
import { formatSize, readText } from "../src/core/fsx.ts";
import { tailLines } from "../src/core/log.ts";
import { parseNetstat, parseDevToolsActivePort } from "../src/core/netprobe.ts";
import { compareVersions, parseVersionName, nodeCandidates } from "../src/core/nodeResolve.ts";
import { parseProcessJson } from "../src/core/windows.ts";
import { createMemoryIo } from "../src/core/io.ts";

// ─── CLI 参数解析 ────────────────────────────────────────────────────
test("parseArgs 支持布尔、取值、等号与别名", () => {
  const parsed = parseArgs(
    ["status", "--json", "--lines", "20", "--proxy-server=http://127.0.0.1:7897", "-y"],
    [
      { name: "json", type: "boolean", description: "" },
      { name: "lines", type: "number", description: "" },
      { name: "proxy-server", type: "string", description: "" },
      { name: "yes", aliases: ["y"], type: "boolean", description: "" },
    ],
  );
  expect(parsed.positionals).toEqual(["status"]);
  expect(boolValue(parsed, "json")).toBe(true);
  expect(boolValue(parsed, "yes")).toBe(true);
  expect(numberValue(parsed, "lines")).toBe(20);
  expect(stringValue(parsed, "proxy-server")).toBe("http://127.0.0.1:7897");
});

test("parseArgs 兼容 PowerShell 风格的单破折号与大小写", () => {
  const parsed = parseArgs(
    ["-Json", "-Lines", "40"],
    [
      { name: "json", type: "boolean", description: "" },
      { name: "lines", type: "number", description: "" },
    ],
  );
  expect(boolValue(parsed, "json")).toBe(true);
  expect(numberValue(parsed, "lines")).toBe(40);
});

test("parseArgs 对未知选项与非整数抛 CliUsageError", () => {
  expect(() => parseArgs(["--nope"], [])).toThrow(CliUsageError);
  expect(() =>
    parseArgs(["--lines", "abc"], [{ name: "lines", type: "number", description: "" }]),
  ).toThrow(CliUsageError);
});

test("parseArgs 的 -- 之后不再解析选项", () => {
  const parsed = parseArgs(["--", "--json"], [{ name: "json", type: "boolean", description: "" }]);
  expect(parsed.positionals).toEqual(["--json"]);
  expect(parsed.values.json).toBeUndefined();
});

// ─── 配置 ────────────────────────────────────────────────────────────
test("loadConfig 默认值与旧脚本一致", () => {
  const cfg = loadConfig({}, {});
  expect(cfg.cdp.exePath).toBe(DEFAULT_PRO_EXE);
  expect(cfg.cdp.port).toBe(9222);
  expect(cfg.cdp.bindHost).toBe("127.0.0.1");
  expect(cfg.bridge.portFirst).toBe(49620);
  expect(cfg.bridge.portLast).toBe(49629);
  expect(cfg.bridge.serviceId).toBe("easyeda-bridge");
  expect(cfg.bridge.maxLogBytes).toBe(5 * 1024 * 1024);
  expect(cfg.bridge.startWaitMs).toBe(20_000);
  expect(cfg.bridge.restartDelayMs).toBe(3_000);
});

test("loadConfig 环境变量生效，且命令行覆盖优先", () => {
  // 目录类断言用当前平台的 path 拼：Windows 下是反斜杠，Linux/macOS 下是斜杠，
  // 和实现里的 path.join / homeDir 保持同一套语义。
  const home = path.join(os.tmpdir(), "lceda-connect-tester");
  const localAppData = path.join(home, "AppData", "Local");
  const customExe = path.join(os.tmpdir(), "lceda-pro-custom", "lceda-pro.exe");
  const customNode = path.join(os.tmpdir(), "lceda-node-bin", "node.exe");
  const env = {
    USERPROFILE: home,
    LOCALAPPDATA: localAppData,
    LCEDA_PRO_EXE: customExe,
    LCEDA_CDP_PORT: "9333",
    LCEDA_NODE: customNode,
  };
  const fromEnv = loadConfig(env, {});
  expect(fromEnv.cdp.exePath).toBe(customExe);
  expect(fromEnv.cdp.port).toBe(9333);
  expect(fromEnv.bridge.nodePath).toBe(customNode);
  expect(fromEnv.bridge.runtimeDir).toBe(path.join(localAppData, "lceda-bridge"));
  expect(fromEnv.cdp.pidFile).toBe(path.join(home, ".lceda-connect", "cdp", "lceda-cdp.pid"));

  const overrideExe = path.join(os.tmpdir(), "lceda-pro-override", "lceda-pro.exe");
  const overridden = loadConfig(env, { cdp: { exePath: overrideExe, port: 9444 } });
  expect(overridden.cdp.exePath).toBe(overrideExe);
  expect(overridden.cdp.port).toBe(9444);
});

// ─── netstat / DevToolsActivePort ────────────────────────────────────
test("parseNetstat 只取区间内 LISTENING 且支持 IPv6", () => {
  const text = [
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       880",
    "  TCP    127.0.0.1:49620        0.0.0.0:0              LISTENING       4412",
    "  TCP    [::]:49621             [::]:0                 LISTENING       4412",
    "  TCP    127.0.0.1:49630        0.0.0.0:0              LISTENING       9999",
  ].join("\r\n");
  expect(parseNetstat(text, 49620, 49629)).toEqual([
    { port: 49620, pid: 4412 },
    { port: 49621, pid: 4412 },
  ]);
});

test("parseDevToolsActivePort 取首个非空行", () => {
  expect(parseDevToolsActivePort("\uFEFF\r\n\r\n9222\r\n/devtools/browser/abc\r\n")).toBe(9222);
  expect(parseDevToolsActivePort("")).toBe(0);
  expect(parseDevToolsActivePort("not-a-port")).toBe(0);
});

// ─── 进程 / 版本 ─────────────────────────────────────────────────────
test("parseProcessJson 兼容单对象与数组，并跳过非法项", () => {
  expect(
    parseProcessJson('{"ProcessId":10,"Name":"a.exe","CommandLine":"a --type=renderer"}'),
  ).toEqual([{ pid: 10, name: "a.exe", commandLine: "a --type=renderer" }]);
  expect(
    parseProcessJson(
      JSON.stringify([
        { ProcessId: 11, Name: "b.exe", CommandLine: null },
        { ProcessId: 0, Name: "bad.exe" },
      ]),
    ),
  ).toEqual([{ pid: 11, name: "b.exe", commandLine: "" }]);
  expect(parseProcessJson("")).toEqual([]);
});

test("版本号解析与排序", () => {
  expect(parseVersionName("22.22.2-6")).toBe("22.22.2");
  expect(parseVersionName("node")).toBeNull();
  expect(compareVersions("26.13.0", "22.22.2")).toBeGreaterThan(0);
  expect(compareVersions("1.2", "1.2.0")).toBe(0);
});

test("nodeCandidates 把 LCEDA_NODE 排在首位并去重", () => {
  const env = { USERPROFILE: "C:\\Users\\tester", LCEDA_NODE: "C:\\node\\node.exe" };
  const candidates = nodeCandidates(env);
  expect(candidates[0]).toEqual({ path: "C:\\node\\node.exe", source: "环境变量 LCEDA_NODE" });
  const paths = candidates.map((item) => item.path.toLowerCase());
  expect(new Set(paths).size).toBe(paths.length);
});

// ─── 文件 / 日志 ─────────────────────────────────────────────────────
test("tailLines 取末尾 N 行且忽略尾部空行", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-connect-test-"));
  try {
    const file = path.join(dir, "bridge.log");
    fs.writeFileSync(file, "a\nb\nc\n\n", "utf8");
    expect(tailLines(file, 2)).toEqual(["b", "c"]);
    expect(tailLines(file, 0)).toEqual([]);
    expect(tailLines(path.join(dir, "missing.log"), 5)).toEqual([]);
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("formatSize 分档", () => {
  expect(formatSize(512)).toBe("512 B");
  expect(formatSize(1024 * 1024 * 1.5)).toBe("1.5 MB");
});

// ─── CLI 主入口（只测不触发真实命令的分支）────────────────────────────
test("main 打印版本并返回 0", async () => {
  const io = createMemoryIo();
  const code = await main({ argv: ["--version"], io, env: {} });
  expect(code).toBe(0);
  expect(io.lines[0]).toBe(`lceda-connect v${packageVersion()}`);
});

test("main 无参数打印全局帮助", async () => {
  const io = createMemoryIo();
  const code = await main({ argv: [], io, env: {} });
  expect(code).toBe(0);
  expect(io.lines.join("\n")).toContain("命令组");
});

test("main 顶层 --help / -h / help 打印全局帮助且不报未知命令", async () => {
  for (const flag of ["--help", "-h", "help"]) {
    const io = createMemoryIo();
    const code = await main({ argv: [flag], io, env: {} });
    expect(code).toBe(0);
    expect(io.errors).toEqual([]);
    expect(io.lines.join("\n")).toContain("命令组");
  }
});

test("main 对未知命令返回 1 并打印帮助", async () => {
  const io = createMemoryIo();
  const code = await main({ argv: ["whatever"], io, env: {} });
  expect(code).toBe(1);
  expect(io.errors.join("\n")).toContain("不认识的命令");
  expect(io.lines.join("\n")).toContain("命令组");
});

test("help 文案包含关键动作", () => {
  expect(cdpHelp().join("\n")).toContain("endpoint");
  expect(bridgeHelp().join("\n")).toContain("doctor");
  expect(globalHelp().join("\n")).toContain("lceda-bridge");
  expect(CDP_OPTIONS.map((spec) => spec.name)).toContain("proxy-server");
});

test("readText 对缺失文件返回 null", () => {
  expect(readText(path.join(os.tmpdir(), "definitely-missing-file.txt"))).toBeNull();
  expect(tailLines(path.join(os.tmpdir(), "definitely-missing-file.txt"), 3)).toEqual([]);
});
