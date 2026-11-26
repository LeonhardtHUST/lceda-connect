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
  /** 测试注入。 */
  probes?: InteropProbes;
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
