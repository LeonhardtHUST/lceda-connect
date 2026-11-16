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
import { packageVersion } from "./core/version.ts";
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

export { packageVersion };

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
    "    mcp        以 stdio 运行 MCP 服务 / 列出工具",
    ...DOMAIN_GROUPS.map((g) => `    ${g.name.padEnd(10)} ${g.summary}`),
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
    paint.white("  CDP 客户端动作（连到已开启调试端口的客户端）:"),
    "    discover    发现调试端点（含 DevToolsActivePort uuid 归属校验）",
    "    targets     列出页面 target；frames 打印 iframe 树",
    "    eval        在编辑器页面里求值（默认拒绝有副作用的表达式）",
    "    shot        截图落盘",
    "    docs        文档列表 / 当前文档 / 打开文档",
    paint.gray("    （lceda-cdp eval --help 查看这些动作的详细参数）"),
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
    "    doctor     环境自检（node 候选、脚本、ws 依赖、端口；找不到外部脚本时用内置服务）",
    "    run        前台运行（调试用）",
    "    windows    列出已连接的编辑器窗口",
    "    select     切换活动窗口",
    "    exec       在编辑器里执行 eda.* 代码（--code / --file）",
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

/** 领域命令的统一签名：argv 不含命令组名本身。 */
export type DomainRunner = (
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
) => Promise<number>;

export interface DomainGroup {
  name: string;
  summary: string;
  load: () => Promise<DomainRunner>;
}

/**
 * 由合并进来的各源仓库提供的命令组。按需动态加载，避免 cdp/bridge 这类常用命令
 * 启动时把所有领域模块都读进来。
 */
export const DOMAIN_GROUPS: readonly DomainGroup[] = [
  {
    name: "api",
    summary: "离线检索 EasyEDA Pro 扩展 API 文档（search / get）",
    load: async () => (await import("./apidocs/cli.ts")).runApiCommand,
  },
  {
    name: "epro2",
    summary: "离线解析 .epro2 工程：网表、PCB 几何、一致性报告、版本对比",
    load: async () => (await import("./epro2/cli.ts")).runEpro2Command,
  },
  {
    name: "format",
    summary: "EasyEDA Pro 文件格式：类型检索、图元字段说明、记录校验、示例",
    load: async () => (await import("./format/cli.ts")).runFormatCommand,
  },
  {
    name: "eda",
    summary: "编辑器动词：双通道自检、读板、DRC、板指纹、自动布线、动词台账检索",
    load: async () => (await import("./eda/cli.ts")).runEdaCommand,
  },
];

/** cdp 命令组里由 CDP 客户端（src/cdp）处理的动作，其余仍归启动器。 */
export const CDP_CLIENT_ACTIONS: readonly string[] = [
  "discover",
  "targets",
  "frames",
  "eval",
  "shot",
  "docs",
];

/** bridge 命令组里由 bridge 客户端（src/bridge）处理的动作，其余仍归服务管理。 */
export const BRIDGE_CLIENT_ACTIONS: readonly string[] = ["windows", "select", "exec"];

export function mcpHelp(): string[] {
  return [
    "",
    paint.cyan("  lceda-connect mcp  --  MCP 服务（stdio）"),
    paint.gray(`  ${hr()}`),
    "  用法: lceda-connect mcp [动作]     （也可直接用 lceda-mcp）",
    "",
    paint.white("  动作:"),
    "    serve      以 stdio 运行 MCP 服务（默认动作，给 MCP 客户端调用）",
    "    tools      列出全部 MCP 工具名与说明",
    "",
    paint.white("  MCP 客户端配置示例:"),
    '    { "command": "npx", "args": ["-y", "lceda-connect", "mcp"] }',
    "",
  ];
}

async function runMcpGroup(
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const action = (argv[0] ?? "serve").trim().toLowerCase();
  if (action === "help" || action === "--help" || action === "-h") {
    print(io, mcpHelp());
    return 0;
  }
  if (action === "tools") {
    const { allTools } = await import("./mcp/registry.ts");
    for (const tool of allTools()) {
      io.out(`${paint.cyan(tool.name.padEnd(28))} ${tool.description.split("。")[0] ?? ""}`);
    }
    return 0;
  }
  if (action === "serve") {
    const { serveStdio } = await import("./mcp/server.ts");
    await serveStdio(env);
    return 0;
  }
  io.err(paint.red(`  不认识的命令: ${action}`));
  print(io, mcpHelp());
  return 1;
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

  if (first === "mcp") {
    return await runMcpGroup(rest, io, env);
  }

  const domain = DOMAIN_GROUPS.find((g) => g.name === first);
  if (domain) {
    const run = await domain.load();
    return await run(rest, io, env);
  }

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

  const clientAction = tail[0]?.trim().toLowerCase() ?? "";
  if (group === "cdp" && CDP_CLIENT_ACTIONS.includes(clientAction)) {
    const { runCdpClientCommand } = await import("./cdp/cli.ts");
    return await runCdpClientCommand(tail, io, env);
  }
  if (group === "bridge" && BRIDGE_CLIENT_ACTIONS.includes(clientAction)) {
    const { runBridgeClientCommand } = await import("./bridge/cli.ts");
    return await runBridgeClientCommand(tail, io, env);
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
