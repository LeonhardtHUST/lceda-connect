import { createRequire } from "node:module";

import {
  CliUsageError,
  boolValue,
  formatOptions,
  numberValue,
  parseArgs,
  stringValue,
  type OptionSpec,
} from "./core/cliArgs.ts";
import { loadConfig, type ConfigOverrides } from "./core/config.ts";
import { stdIo, type Io } from "./core/io.ts";
import { hr, paint } from "./core/term.ts";
import { runBridgeAction } from "./commands/bridge.ts";
import { runCdpAction } from "./commands/cdp.ts";
import type { BridgeAction, CdpAction, CommandContext } from "./commands/types.ts";

export const CDP_ACTIONS: readonly CdpAction[] = ["start", "ensure", "status", "endpoint", "stop"];

export const BRIDGE_ACTIONS: readonly BridgeAction[] = [
  "start",
  "stop",
  "kill",
  "restart",
  "status",
  "st",
  "health",
  "logs",
  "log",
  "doctor",
  "check",
  "env",
  "run",
  "supervise",
  "help",
];

export const CDP_OPTIONS: readonly OptionSpec[] = [
  { name: "json", type: "boolean", description: "以 JSON 输出（给脚本 / Agent 用）" },
  { name: "yes", aliases: ["y"], type: "boolean", description: "stop 时确认结束进程" },
  { name: "force", type: "boolean", description: "已有实例仍强制启动（会争抢同一份数据）" },
  {
    name: "proxy-server",
    type: "string",
    placeholder: "URL",
    description: "显式代理，如 http://127.0.0.1:7897",
  },
  {
    name: "wait-online",
    type: "number",
    placeholder: "N",
    description: "启动前最多等 N 秒让网络就绪（0 = 不等）",
  },
  { name: "keep-proxy-env", type: "boolean", description: "保留继承来的代理环境变量" },
  {
    name: "exe",
    type: "string",
    placeholder: "PATH",
    description: "客户端主程序路径（等价 LCEDA_PRO_EXE）",
  },
  {
    name: "port",
    type: "number",
    placeholder: "PORT",
    description: "CDP 调试端口（等价 LCEDA_CDP_PORT）",
  },
];

export const BRIDGE_OPTIONS: readonly OptionSpec[] = [
  { name: "json", type: "boolean", description: "status 以 JSON 输出" },
  {
    name: "lines",
    aliases: ["n"],
    type: "number",
    placeholder: "N",
    description: "logs 显示最近 N 行（默认 40）",
  },
  { name: "follow", type: "boolean", description: "logs 实时跟随（Ctrl+C 退出）" },
  { name: "once", type: "boolean", description: "start/run 只跑一次，崩溃不自动重启" },
  {
    name: "node",
    type: "string",
    placeholder: "PATH",
    description: "指定 node.exe（等价 LCEDA_NODE）",
  },
  {
    name: "script",
    type: "string",
    placeholder: "PATH",
    description: "指定 bridge-server.mjs（等价 LCEDA_BRIDGE_SCRIPT）",
  },
];

export function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function globalHelp(): string[] {
  return [
    "",
    paint.cyan("  lceda-connect  --  嘉立创EDA专业版 (EasyEDA Pro) 连接工具箱"),
    paint.gray(`  ${hr()}`),
    "  用法: lceda-connect <命令组> <动作> [选项]",
    "",
    paint.white("  命令组:"),
    "    cdp        带 CDP 调试端口启动 / 管理立创EDA专业版",
    "    bridge     EasyEDA AI Bridge 服务管理",
    "",
    paint.white("  等价写法:"),
    "    lceda-cdp <动作>        等价于 lceda-connect cdp <动作>",
    "    lceda-bridge <动作>     等价于 lceda-connect bridge <动作>",
    "",
    paint.white("  例子:"),
    "    npx lceda-connect cdp start",
    "    npx lceda-connect bridge status --json",
    "    npx lceda-cdp endpoint",
    "    npx lceda-bridge logs --follow",
    "",
    paint.white("  全局选项:"),
    "    --version, -v           打印版本",
    "    --help, -h              打印帮助",
    "",
  ];
}

export function cdpHelp(): string[] {
  return [
    "",
    paint.cyan("  lceda-cdp  --  带 CDP 调试端口启动立创EDA专业版"),
    paint.gray(`  ${hr()}`),
    "  用法: lceda-cdp <动作> [选项]     （也写作 lceda-connect cdp <动作>）",
    "",
    paint.white("  动作:"),
    "    start       带调试端口启动，并等待端点就绪",
    "    ensure      端点没了先自愈：没进程就起，有进程就诊断",
    "    status      查看受管实例与端点状态（默认动作）",
    "    endpoint    只打印当前 CDP 端点与 WebSocket 地址",
    "    stop        停止本工具启动的实例（需 --yes）",
    "",
    paint.white("  选项:"),
    ...formatOptions(CDP_OPTIONS),
    "",
    paint.gray("  退出码: 0 成功 / 1 失败 / 2 需要确认或端点不可用"),
    "",
  ];
}

export function bridgeHelp(): string[] {
  return [
    "",
    paint.cyan("  lceda-bridge  --  嘉立创 EDA (EasyEDA Pro) AI Bridge 管理"),
    paint.gray(`  ${hr()}`),
    "  用法: lceda-bridge <动作> [选项]     （也写作 lceda-connect bridge <动作>）",
    "",
    paint.white("  动作:"),
    "    start      后台启动（隐藏窗口，崩溃 3 秒后自动重启）",
    "    stop       停止（连进程树一起清，再兜底扫端口）",
    "    restart    stop + start",
    "    status     看状态（默认动作）",
    "    logs       看日志",
    "    doctor     环境自检（node 候选、脚本、ws 依赖、端口）",
    "    run        前台运行（调试用）",
    "    help       这个帮助",
    "",
    paint.white("  选项:"),
    ...formatOptions(BRIDGE_OPTIONS),
    "",
    paint.white("  例子:"),
    "    lceda-bridge start",
    "    lceda-bridge status --json",
    "    lceda-bridge logs --follow",
    "    lceda-bridge restart",
    "    lceda-bridge doctor",
    "",
    paint.gray("  端口: 49620-49629   健康检查: http://127.0.0.1:49620/health"),
    "",
  ];
}

export interface MainOptions {
  argv: readonly string[];
  defaultGroup?: "cdp" | "bridge";
  io?: Io;
  env?: NodeJS.ProcessEnv;
}

function print(io: Io, lines: readonly string[]): void {
  for (const line of lines) io.out(line);
}

/**
 * CLI 主入口：解析命令组 / 动作 / 选项，交给对应命令实现，返回进程退出码。
 * 三种 bin（lceda-connect / lceda-cdp / lceda-bridge）共用这一份逻辑，靠 defaultGroup 区分。
 */
export async function main(options: MainOptions): Promise<number> {
  const io = options.io ?? stdIo;
  const env = options.env ?? process.env;
  const argv = [...options.argv];

  if (argv.includes("--version") || argv.includes("-v") || argv.includes("-version")) {
    io.out(`lceda-connect v${packageVersion()}`);
    return 0;
  }

  const [first, ...rest] = argv;
  const isHelpFlag = (token: string | undefined): boolean =>
    token === "--help" || token === "-h" || token === "-help" || token === "help";
  let group: "cdp" | "bridge";
  let tail: string[];

  if (first === "cdp" || first === "bridge") {
    group = first;
    tail = rest;
  } else if (options.defaultGroup) {
    group = options.defaultGroup;
    tail = argv;
  } else if (first === undefined || isHelpFlag(first)) {
    print(io, globalHelp());
    return 0;
  } else {
    io.err(paint.red(`  不认识的命令: ${first}`));
    print(io, globalHelp());
    return 1;
  }

  const helpRequested =
    tail.includes("--help") ||
    tail.includes("-h") ||
    tail.includes("help") ||
    tail.includes("-help");

  if (helpRequested) {
    print(io, group === "cdp" ? cdpHelp() : bridgeHelp());
    return 0;
  }

  const specs = group === "cdp" ? CDP_OPTIONS : BRIDGE_OPTIONS;
  let parsed;
  try {
    parsed = parseArgs(tail, specs);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(paint.red(`  ${error.message}`));
      print(io, group === "cdp" ? cdpHelp() : bridgeHelp());
      return 1;
    }
    throw error;
  }

  const actionName = parsed.positionals[0] ?? "status";
  const extras = parsed.positionals.slice(1);
  if (extras.length > 0) {
    io.err(paint.red(`  多余的参数: ${extras.join(" ")}`));
    print(io, group === "cdp" ? cdpHelp() : bridgeHelp());
    return 1;
  }

  const overrides: ConfigOverrides = {};
  const exePath = stringValue(parsed, "exe");
  const port = numberValue(parsed, "port");
  if (exePath !== undefined || port !== undefined) {
    overrides.cdp = { exePath, port };
  }
  const nodePath = stringValue(parsed, "node");
  const bridgeScript = stringValue(parsed, "script");
  if (nodePath !== undefined || bridgeScript !== undefined) {
    overrides.bridge = { nodePath, bridgeScript };
  }

  const ctx: CommandContext = { cfg: loadConfig(env, overrides), io, env };

  if (group === "cdp") {
    const action = actionName.trim().toLowerCase();
    if (!(CDP_ACTIONS as readonly string[]).includes(action)) {
      io.err(paint.red(`  不认识的命令: ${actionName}`));
      print(io, cdpHelp());
      return 1;
    }
    return await runCdpAction(
      action as CdpAction,
      {
        json: boolValue(parsed, "json"),
        yes: boolValue(parsed, "yes"),
        force: boolValue(parsed, "force"),
        proxyServer: stringValue(parsed, "proxy-server"),
        waitOnlineSec: numberValue(parsed, "wait-online") ?? 0,
        keepProxyEnv: boolValue(parsed, "keep-proxy-env"),
      },
      ctx,
    );
  }

  const action = actionName.trim().toLowerCase();
  if (!(BRIDGE_ACTIONS as readonly string[]).includes(action)) {
    io.err(paint.red(`  不认识的命令: ${actionName}`));
    print(io, bridgeHelp());
    return 1;
  }
  return await runBridgeAction(
    action as BridgeAction,
    {
      json: boolValue(parsed, "json"),
      lines: numberValue(parsed, "lines") ?? 40,
      follow: boolValue(parsed, "follow"),
      once: boolValue(parsed, "once"),
    },
    ctx,
  );
}
