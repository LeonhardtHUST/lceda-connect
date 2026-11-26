import { spawn } from "node:child_process";

import {
  resolveWindowsEnvironment,
  resolveWindowsMcpEntry,
  resolveWindowsNode,
  type InteropProbes,
  type WindowsExecutable,
} from "../core/windowsHost.ts";
import type { Io } from "../core/io.ts";
import { paint } from "../core/term.ts";

/**
 * `lceda-connect mcp host`：在 WSL 里用 stdio 拉起 **Windows 侧**的 lceda-connect MCP。
 *
 * 为什么不是普通代理：WSL 的 stdio 客户端直接 spawn `/mnt/c/.../node.exe Windows\dist\cli-mcp.mjs`
 * 就能工作（已实测），但路径/环境需要人来翻。这个命令把「找 Windows node、找 Windows
 * 安装入口、翻译 /mnt 配置路径、构造干净的 Windows 环境」收成一条命令，MCP 客户端
 * 仍按 stdio 标准调用。`--print-config` 则直接输出可粘贴的客户端配置。
 */

export const HOST_CONFIG_ENV_KEYS: readonly string[] = [
  "LCEDA_ENV",
  "LCEDA_ENV_SOURCE",
  "LCEDA_LEDA_IN",
  "LCEDA_LEDA_IN_SOURCE",
  "LCEDA_WINDOWS_HOST",
  "LCEDA_CDP_HOST",
  "LCEDA_CDP_PORT",
  "LCEDA_CDP_SCAN",
  "LCEDA_BRIDGE_HOST",
  "LCEDA_BRIDGE_PORT_FIRST",
  "LCEDA_BRIDGE_PORT_LAST",
  "LCEDA_PRO_EXE",
  "LCEDA_CONFIG",
  "LCEDA_ENV_FILE",
  "LCEDA_CONNECT_HOME",
  "LCEDA_CONNECT_ASSETS",
  "LCEDA_NODE",
  "LCEDA_BRIDGE_SCRIPT",
  "LCEDA_TOOLSETS",
  "LCEDA_ALLOWED_ROOTS",
  "EASYEDA_CDP_TIMEOUT",
];

export interface McpHostOptions {
  env?: NodeJS.ProcessEnv;
  io: Io;
  /** 透传给 Windows MCP 的参数（如 --toolsets offline）。 */
  forwardArgs?: readonly string[];
  nodePath?: string;
  scriptPath?: string;
  printConfig?: boolean;
  /** 启动 MCP 前，先通过 Windows 侧 CLI 确保 EasyEDA 带调试端口运行。 */
  startClient?: boolean;
  /** 客户端调试端口；缺省读 LCEDA_CDP_PORT，再缺省 9222。 */
  clientPort?: number;
  /** 测试注入。 */
  probes?: InteropProbes;
}

export interface WindowsClientStatus {
  instances?: number[];
  debugFlagged?: { pid: number; port: number }[];
  managed?: boolean;
  running?: boolean;
}

export type ClientStartDecision = {
  action: "skip" | "start" | "error";
  reason: string;
  runningPort?: number;
};

/**
 * 纯决策：客户端已在目标端口就跑；已在别的端口/没端口就报错而**不杀进程**。
 * 这是“未保存工程确认”的工程化表达：只启动，不结束任何用户进程。
 */
export function decideClientStart(
  status: WindowsClientStatus | null,
  desiredPort: number,
): ClientStartDecision {
  const instances = status?.instances ?? [];
  const ports = (status?.debugFlagged ?? []).map((item) => item.port).filter((port) => port > 0);
  if (ports.includes(desiredPort)) {
    return { action: "skip", reason: `客户端已在 ${desiredPort} 上运行`, runningPort: desiredPort };
  }
  if (instances.length > 0) {
    if (ports.length > 0) {
      return {
        action: "error",
        reason: `客户端已在运行，调试端口是 ${ports.join("/")}，与目标 ${desiredPort} 不同；请先保存并手动退出客户端再重试（不会自动结束进程）`,
        runningPort: ports[0],
      };
    }
    return {
      action: "error",
      reason:
        "客户端已在运行但没有调试端口；请先保存并手动退出客户端，再重试 --start-client（不会自动结束进程）",
    };
  }
  return { action: "start", reason: `客户端未运行，将在 ${desiredPort} 上启动` };
}

export interface McpHostPlan {
  node: WindowsExecutable;
  entry: WindowsExecutable;
  childEnv: NodeJS.ProcessEnv;
  warnings: string[];
}

/** 构造启动计划；找不到 Windows node 或安装入口时返回错误字符串。 */
export function buildMcpHostPlan(
  options: McpHostOptions = { io: { out: () => {}, err: () => {} } },
): {
  plan: McpHostPlan | null;
  error: string | null;
} {
  const env = { ...(options.env ?? process.env) };
  if (options.nodePath) env.LCEDA_WINDOWS_NODE = options.nodePath;
  if (options.scriptPath) env.LCEDA_WINDOWS_MCP = options.scriptPath;
  const node = resolveWindowsNode(env, options.probes);
  if (!node) {
    return {
      plan: null,
      error:
        "找不到 Windows 的 node.exe。先在 Windows 装 Node 20+，或用 --node 'C:\\Program Files\\nodejs\\node.exe' 指定。",
    };
  }
  const entry = resolveWindowsMcpEntry(env, options.probes);
  if (!entry) {
    return {
      plan: null,
      error:
        "Windows 侧没有找到 lceda-connect 安装。先在 Windows 执行 `pnpm add -g lceda-connect`（或 npm），或用 --script 'D:\\path\\lceda-connect\\dist\\cli-mcp.mjs' 指定。",
    };
  }
  const windows = resolveWindowsEnvironment(env, options.probes);
  return {
    plan: { node, entry, childEnv: windows.env, warnings: windows.warnings },
    error: null,
  };
}

function cliEntryOf(plan: McpHostPlan): string | null {
  if (!/cli-mcp\.mjs$/i.test(plan.entry.winPath)) return null;
  return plan.entry.winPath.replace(/cli-mcp\.mjs$/i, "cli.mjs");
}

function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runWindowsCli(
  plan: McpHostPlan,
  args: readonly string[],
  timeoutMs: number,
): Promise<CliRunResult> {
  const cli = cliEntryOf(plan);
  if (!cli) {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "当前 Windows 入口不是 cli-mcp.mjs，无法定位 cli.mjs 来启动客户端",
    });
  }
  return new Promise((resolve) => {
    const child = spawn(plan.node.wslPath, [cli, ...args], {
      env: plan.childEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: 124, stdout, stderr: `${stderr}\n超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function waitForWindowsCdp(
  plan: McpHostPlan,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const script =
    "const http=require('http');const p=Number(process.argv[1]);" +
    "const t0=Date.now();const tryOnce=()=>{const req=http.get({host:'127.0.0.1',port:p,path:'/json/version',timeout:800},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{const j=JSON.parse(b);if(j.Browser&&j['Protocol-Version']){console.log('READY '+j.Browser);process.exit(0)}}catch{}if(Date.now()-t0>t){console.log('TIMEOUT');process.exit(2)}setTimeout(tryOnce,300)})});req.on('error',()=>{if(Date.now()-t0>t){console.log('TIMEOUT');process.exit(2)}setTimeout(tryOnce,300)});req.on('timeout',()=>req.destroy())};const t=" +
    String(timeoutMs) +
    ";tryOnce();";
  return new Promise((resolve) => {
    const child = spawn(plan.node.wslPath, ["-e", script, String(port)], {
      env: plan.childEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, detail: `等待端点超时（${timeoutMs}ms）` });
    }, timeoutMs + 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      resolve({
        ok: code === 0 && text.startsWith("READY"),
        detail: text || stderr.trim() || `退出码 ${code ?? "unknown"}`,
      });
    });
  });
}

async function ensureClient(plan: McpHostPlan, desiredPort: number, io: Io): Promise<boolean> {
  const statusRun = await runWindowsCli(plan, ["cdp", "status", "--json"], 30_000);
  const status =
    statusRun.code === 0 ? (parseJsonOutput(statusRun.stdout) as WindowsClientStatus | null) : null;
  if (!status) {
    io.err(
      paint.yellow(`  ! 无法读取客户端状态（cdp status 退出码 ${statusRun.code}）；尝试直接启动`),
    );
    io.err(paint.gray(`    ${(statusRun.stderr || statusRun.stdout).trim().slice(0, 300)}`));
  }
  const decision = decideClientStart(status, desiredPort);
  if (decision.action === "error") {
    io.err(paint.red(`  ${decision.reason}`));
    return false;
  }
  if (decision.action === "skip") {
    io.err(paint.green(`  ${decision.reason}`));
    return true;
  }
  io.err(paint.gray(`  ${decision.reason}…`));
  // `lceda-cdp start` 会作为 GUI 的父进程一直存活，不能等它退出；
  // 发起启动后改用 Windows node 轮询端点（MCP 客户端初始化有 60s 上限）。
  const cli = cliEntryOf(plan);
  if (!cli) {
    io.err(paint.red("  无法定位 Windows 侧 cli.mjs，不能自动启动客户端"));
    return false;
  }
  const starter = spawn(plan.node.wslPath, [cli, "cdp", "start", "--port", String(desiredPort)], {
    env: plan.childEnv,
    windowsHide: true,
    stdio: "ignore",
  });
  starter.once("error", (error) => {
    io.err(paint.yellow(`  ! 启动客户端失败：${error.message}`));
  });
  starter.unref();
  const waited = await waitForWindowsCdp(plan, desiredPort, 45_000);
  if (!waited.ok) {
    io.err(paint.red(`  EasyEDA 未在预期时间内就绪：${waited.detail}`));
    return false;
  }
  io.err(
    paint.green(
      `  客户端已启动：127.0.0.1:${desiredPort}（${waited.detail.replace(/^READY\s*/, "")}）`,
    ),
  );
  return true;
}

function envForPrintConfig(plan: McpHostPlan): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of HOST_CONFIG_ENV_KEYS) {
    const value = plan.childEnv[key];
    if (value === undefined || value === "") continue;
    picked[key] = value;
  }
  return picked;
}

function printClientConfig(io: Io, plan: McpHostPlan, args: readonly string[]): void {
  const config = {
    mcpServers: {
      lceda: {
        type: "stdio",
        command: plan.node.wslPath,
        args: [plan.entry.winPath, ...args],
        env: envForPrintConfig(plan),
      },
    },
  };
  io.out(JSON.stringify(config, null, 2));
}

export async function runMcpHost(options: McpHostOptions): Promise<number> {
  const { io } = options;
  const built = buildMcpHostPlan(options);
  if (!built.plan) {
    io.err(paint.red(`  ${built.error ?? "无法构造 Windows 启动计划"}`));
    return 1;
  }
  const { plan } = built;
  const forwardArgs = [...(options.forwardArgs ?? [])];

  if (options.printConfig) {
    for (const warning of plan.warnings) io.err(paint.yellow(`  ! ${warning}`));
    printClientConfig(io, plan, forwardArgs);
    return 0;
  }

  io.err(paint.gray(`  Windows node: ${plan.node.wslPath}（${plan.node.source}）`));
  io.err(paint.gray(`  Windows MCP:  ${plan.entry.winPath}（${plan.entry.source}）`));
  for (const warning of plan.warnings) io.err(paint.yellow(`  ! ${warning}`));

  if (options.startClient) {
    const port = options.clientPort ?? Number.parseInt(plan.childEnv.LCEDA_CDP_PORT ?? "9222", 10);
    const desiredPort = Number.isFinite(port) && port > 0 ? port : 9222;
    if (!(await ensureClient(plan, desiredPort, io))) return 1;
  }

  const child = spawn(plan.node.wslPath, [plan.entry.winPath, ...forwardArgs], {
    // 只接管 stdin（用于检测客户端 EOF），stdout/stderr 直接透传协议与日志。
    stdio: ["pipe", "inherit", "inherit"],
    env: plan.childEnv,
    windowsHide: true,
  });
  process.stdin.pipe(child.stdin);
  process.stdin.once("end", () => child.stdin?.end());

  let exiting = false;
  const forward = (signal: NodeJS.Signals): void => {
    if (exiting) return;
    exiting = true;
    child.kill(signal);
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  // stdio 客户端关闭输入时，避免 Windows 侧子进程变成孤儿。
  process.stdin.once("end", () => forward("SIGTERM"));

  return await new Promise<number>((resolve) => {
    child.once("error", (error) => {
      io.err(paint.red(`  启动 Windows MCP 失败：${error.message}`));
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      if (signal) io.err(paint.gray(`  Windows MCP 因信号 ${signal} 退出`));
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
