import {
  boolValue,
  formatOptions,
  numberValue,
  parseArgs,
  stringValue,
  type OptionSpec,
} from "../core/cliArgs.ts";
import { loadConfig } from "../core/config.ts";
import { describeEnvironment } from "../core/environment.ts";
import type { Io } from "../core/io.ts";
import { GLOBAL_HELP_ROWS, type RuntimeResolution } from "../core/runtimeConfig.ts";
import { hr, paint } from "../core/term.ts";

/** `lceda-connect mcp` / `lceda-mcp` 的命令实现：只做参数解析与传输适配器选择。 */
export const MCP_OPTIONS: readonly OptionSpec[] = [
  {
    name: "toolsets",
    type: "string",
    placeholder: "N",
    description: "选择 core/offline/live 或逗号分隔的领域（默认全部）",
  },
  {
    name: "host",
    type: "string",
    placeholder: "HOST",
    description: "http 监听地址（默认 127.0.0.1；wsl=自动取 WSL 虚拟网卡地址）",
  },
  { name: "port", type: "number", placeholder: "PORT", description: "http 监听端口（默认 3939）" },
  { name: "path", type: "string", placeholder: "/mcp", description: "http 端点路径（默认 /mcp）" },
  {
    name: "token",
    type: "string",
    placeholder: "TOKEN",
    description: "http 要求 Authorization: Bearer <token>",
  },
  { name: "stateless", type: "boolean", description: "http 无状态模式（不管理 session）" },
  {
    name: "node",
    type: "string",
    placeholder: "PATH",
    description: "host 动作：Windows node.exe（默认自动发现）",
  },
  {
    name: "script",
    type: "string",
    placeholder: "PATH",
    description: "host 动作：Windows 侧 cli-mcp.mjs（默认按全局安装自动发现）",
  },
  {
    name: "print-config",
    type: "boolean",
    description: "host 动作：只打印可直接粘贴的 stdio 客户端配置",
  },
];

export function mcpHelp(): string[] {
  return [
    "",
    paint.cyan("  lceda-connect mcp  --  MCP 服务（stdio / streamable-http / WSL→Windows）"),
    paint.gray(`  ${hr()}`),
    "  用法: lceda-connect mcp [动作] [选项]     （也可直接用 lceda-mcp）",
    "",
    paint.white("  动作:"),
    "    serve      以 stdio 运行 MCP 服务（默认动作，给 MCP 客户端调用）",
    "    http       以 Streamable HTTP 运行 MCP 服务（默认只监听 127.0.0.1）",
    "    host       在 WSL 里拉起 Windows 侧的 lceda-connect MCP（stdio 透传）",
    "    tools      列出全部 MCP 工具名与说明",
    "",
    paint.white("  选项:"),
    ...formatOptions(MCP_OPTIONS),
    ...GLOBAL_HELP_ROWS.map((row) => `    ${row.flag.padEnd(24)} ${row.description}`),
    "",
    paint.white("  示例:"),
    "    lceda-connect mcp http --host wsl --port 3939 --token secret",
    "    lceda-connect mcp host --toolsets live",
    "    lceda-connect mcp host --print-config",
    "",
    paint.white("  MCP 客户端配置示例:"),
    '    { "type": "stdio", "command": "npx", "args": ["-y", "lceda-connect", "mcp"] }',
    '    { "type": "http",  "url": "http://127.0.0.1:3939/mcp" }',
    '    { "type": "stdio", "command": "npx", "args": ["-y", "lceda-connect", "mcp", "host"] }',
    "",
    paint.gray(
      "  提示：http 默认只绑回环，WSL 里连不到 Windows 回环；跨 WSL 用 --host wsl 或在 Windows 侧启动。",
    ),
    "",
  ];
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

export async function runMcpGroup(
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
  runtime?: RuntimeResolution,
): Promise<number> {
  if (
    argv[0] === "help" ||
    argv[0] === "--help" ||
    argv[0] === "-h" ||
    argv.includes("--help") ||
    argv.includes("-h")
  ) {
    print(io, mcpHelp());
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs(argv, MCP_OPTIONS);
  } catch (error) {
    io.err(paint.red(`  ${error instanceof Error ? error.message : String(error)}`));
    print(io, mcpHelp());
    return 1;
  }
  const action = (parsed.positionals[0] ?? "serve").trim().toLowerCase();
  const extras = parsed.positionals.slice(1);
  if (action === "help" || action === "--help" || action === "-h") {
    print(io, mcpHelp());
    return 0;
  }
  const selected = stringValue(parsed, "toolsets") ?? env.LCEDA_TOOLSETS;
  const normalized = (await import("../core/windowsHost.ts")).normalizeMcpEnv(env);
  for (const warning of normalized.warnings) io.err(paint.yellow(`  ! ${warning}`));
  const effectiveEnv = normalized.env;

  if (action === "tools") {
    const { toolsForEnv } = await import("../mcp/registry.ts");
    try {
      for (const tool of toolsForEnv(effectiveEnv, selected)) {
        io.out(`${paint.cyan(tool.name.padEnd(28))} ${tool.description.split("。")[0] ?? ""}`);
      }
      return 0;
    } catch (error) {
      io.err(paint.red(error instanceof Error ? error.message : String(error)));
      return 1;
    }
  }

  if (action === "serve") {
    if (extras.length > 0) {
      io.err(paint.red(`  多余的参数: ${extras.join(" ")}`));
      return 1;
    }
    const { serveStdio } = await import("../mcp/transports/stdio.ts");
    try {
      const cfg = loadConfig(effectiveEnv);
      io.err(
        paint.gray(
          `  环境: ${describeEnvironment(cfg.environment)}` +
            (runtime?.configPath ? ` · 配置 ${runtime.configPath}` : "") +
            (runtime?.envFilePath ? ` · .env ${runtime.envFilePath}` : ""),
        ),
      );
      await serveStdio(effectiveEnv, selected);
      return 0;
    } catch (error) {
      io.err(paint.red(error instanceof Error ? error.message : String(error)));
      return 1;
    }
  }

  if (action === "http") {
    if (extras.length > 0) {
      io.err(paint.red(`  多余的参数: ${extras.join(" ")}`));
      return 1;
    }
    const requestedHost =
      stringValue(parsed, "host") ?? effectiveEnv.LCEDA_HTTP_HOST ?? "127.0.0.1";
    let host = requestedHost;
    if (requestedHost.trim().toLowerCase() === "wsl") {
      const envInfo = loadConfig(effectiveEnv).environment;
      if (envInfo.platform === "linux" && envInfo.kind !== "wsl2") {
        io.err(paint.red("  当前不是 WSL2 环境，没有 WSL 虚拟网卡可绑；请直接传 --host <IP>"));
        return 1;
      }
      if (envInfo.kind === "wsl2" && envInfo.networkingMode === "mirrored") {
        io.err(
          paint.yellow(
            "  ! WSL mirrored 模式下宿主与 WSL 共享回环，--host wsl 取到的可能是 LAN 地址；建议用 127.0.0.1",
          ),
        );
      }
      const { resolveWslFacingHost } = await import("../core/windowsHost.ts");
      const resolved = resolveWslFacingHost(effectiveEnv);
      if (!resolved) {
        io.err(paint.red("  无法自动解析 WSL 虚拟网卡地址；请直接传 --host <宿主 vEthernet IP>"));
        return 1;
      }
      host = resolved.host;
      io.err(paint.gray(`  --host wsl → ${host}（${resolved.source}）`));
      for (const warning of resolved.warnings) io.err(paint.yellow(`  ! ${warning}`));
    }
    const envPort =
      effectiveEnv.LCEDA_HTTP_PORT && /^\d+$/.test(effectiveEnv.LCEDA_HTTP_PORT.trim())
        ? Number.parseInt(effectiveEnv.LCEDA_HTTP_PORT, 10)
        : undefined;
    const stateless =
      boolValue(parsed, "stateless") ||
      (effectiveEnv.LCEDA_HTTP_STATELESS ?? "").toLowerCase() === "true";
    const { startHttpTransport } = await import("../mcp/transports/http.ts");
    try {
      const handle = await startHttpTransport({
        env: effectiveEnv,
        toolsets: selected,
        host,
        port: numberValue(parsed, "port") ?? (Number.isFinite(envPort) ? envPort : undefined),
        path: stringValue(parsed, "path") ?? effectiveEnv.LCEDA_HTTP_PATH,
        token: stringValue(parsed, "token") ?? effectiveEnv.LCEDA_HTTP_TOKEN,
        stateless,
      });
      io.err(paint.gray(`  按 Ctrl+C 或结束进程退出；端点 ${handle.url}`));
      await waitForShutdown();
      await handle.close();
      return 0;
    } catch (error) {
      io.err(paint.red(error instanceof Error ? error.message : String(error)));
      return 1;
    }
  }

  if (action === "host") {
    const forwardArgs: string[] = [];
    if (selected) forwardArgs.push("--toolsets", selected);
    forwardArgs.push(...extras);
    const { runMcpHost } = await import("./mcpHost.ts");
    return await runMcpHost({
      env: effectiveEnv,
      io,
      forwardArgs,
      nodePath: stringValue(parsed, "node"),
      scriptPath: stringValue(parsed, "script"),
      printConfig: boolValue(parsed, "print-config"),
    });
  }

  io.err(paint.red(`  不认识的命令: ${action}`));
  print(io, mcpHelp());
  return 1;
}

function print(io: Io, lines: readonly string[]): void {
  for (const line of lines) io.out(line);
}
