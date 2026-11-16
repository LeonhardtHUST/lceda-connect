import { readFileSync } from "node:fs";

import { CliUsageError, numberValue, parseArgs, stringValue } from "../core/cliArgs.ts";
import type { Io } from "../core/io.ts";
import {
  BridgeClientError,
  bridgeErrorHint,
  discover,
  execute,
  requireConnected,
  selectWindow,
  windows,
} from "./client.ts";
import { BRIDGE_PORT_END, BRIDGE_PORT_START } from "./protocol.ts";

/**
 * `lceda-connect bridge-client <动作>` 的实现：只走 HTTP，不开 WS、不管进程。
 * 语义对齐 leonskill-easyeda-connect/scripts/bridge_client.py（退出码 0/2/3/4/5）。
 */

const OPTIONS = [
  {
    name: "port",
    type: "number" as const,
    placeholder: "PORT",
    description: "指定端口；缺省扫描 49620-49629",
  },
  {
    name: "code",
    type: "string" as const,
    placeholder: "JS",
    description: "exec 要执行的函数体，需 return",
  },
  {
    name: "file",
    type: "string" as const,
    placeholder: "PATH",
    description: "exec 从文件读取函数体",
  },
  {
    name: "window",
    type: "string" as const,
    placeholder: "ID",
    description: "目标窗口 id（缺省用激活窗口）",
  },
  {
    name: "timeout",
    type: "number" as const,
    placeholder: "SEC",
    description: "exec 等待上限（秒，默认 35）",
  },
  { name: "json", type: "boolean" as const, description: "以紧凑 JSON 输出（默认缩进 2）" },
  { name: "help", aliases: ["h"], type: "boolean" as const, description: "显示帮助" },
];

export function bridgeClientHelpLines(): string[] {
  return [
    "",
    "  lceda-connect bridge-client  --  EasyEDA bridge 的协议客户端",
    "  ------------------------------------------------------------",
    "  用法: lceda-connect bridge-client <动作> [选项]",
    "",
    "  动作:",
    "    windows                列出已注册的 EDA 窗口",
    "    select --window <ID>   切换当前窗口",
    "    exec --code <JS> | --file <PATH> [--window ID] [--timeout SEC]",
    "                           在编辑器扩展上下文执行代码，代码需用 return 交出结果",
    "    help                   这个帮助",
    "",
    "  选项:",
    "    --port <PORT>          指定端口；缺省从 49620 扫到 49629 并按 service 校验",
    "    --json                 紧凑输出",
    "",
    "  例子:",
    "    lceda-connect bridge-client windows",
    '    lceda-connect bridge-client exec --code "return await eda.dmt_Project.getCurrentProjectInfo();"',
    "    lceda-connect bridge-client exec --file .\\probe.js --window win-abc --timeout 60",
    "",
    "  退出码: 0 成功 / 2 没有 bridge / 3 EDA 未连接 / 4 协议错误 / 5 超时",
    "",
  ];
}

function printJson(io: Io, data: unknown, compact: boolean): void {
  io.out(JSON.stringify(data, null, compact ? 0 : 2));
}

async function resolvePort(
  io: Io,
  port: number | undefined,
  env: NodeJS.ProcessEnv,
): Promise<{ port: number; host: string } | null> {
  const host = env.LCEDA_BRIDGE_HOST || "127.0.0.1";
  const fromEnv = env.LCEDA_BRIDGE_PORT ? Number.parseInt(env.LCEDA_BRIDGE_PORT, 10) : Number.NaN;
  const chosen = port ?? (Number.isFinite(fromEnv) ? fromEnv : undefined);
  if (chosen !== undefined) return { port: chosen, host };
  const endpoint = await discover();
  if (!endpoint) {
    io.err(
      `  端口区间 ${BRIDGE_PORT_START}-${BRIDGE_PORT_END} 里没有 easyeda-bridge。` +
        "先跑 lceda-bridge start。",
    );
    return null;
  }
  return { port: endpoint.port, host };
}

export async function runBridgeClientCommand(
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const action = (argv[0] ?? "help").trim().toLowerCase();
  if (action === "help" || action === "--help" || action === "-h") {
    for (const line of bridgeClientHelpLines()) io.out(line);
    return 0;
  }

  let parsed;
  try {
    parsed = parseArgs(argv.slice(1), OPTIONS);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(`  ${error.message}`);
      for (const line of bridgeClientHelpLines()) io.err(line);
      return 1;
    }
    throw error;
  }
  if (parsed.values.help === true) {
    for (const line of bridgeClientHelpLines()) io.out(line);
    return 0;
  }

  const json = parsed.values.json === true;
  const [first, ...extras] = parsed.positionals;
  if (extras.length > 0) {
    io.err(`  多余的参数: ${extras.join(" ")}`);
    return 1;
  }

  try {
    if (action === "windows") {
      const target = await resolvePort(io, numberValue(parsed, "port"), env);
      if (!target) return 2;
      const list = await windows(target.port, { host: target.host });
      printJson(io, { port: target.port, ...list }, json);
      return 0;
    }

    if (action === "select") {
      const windowId = stringValue(parsed, "window") ?? first;
      if (!windowId) {
        io.err("  select 需要 --window <ID>。");
        return 1;
      }
      const target = await resolvePort(io, numberValue(parsed, "port"), env);
      if (!target) return 2;
      const result = await selectWindow(target.port, windowId, { host: target.host });
      printJson(io, { port: target.port, ...result }, json);
      return 0;
    }

    if (action === "exec") {
      const codeFromFile = stringValue(parsed, "file");
      let code = stringValue(parsed, "code");
      if (codeFromFile) {
        try {
          code = readFileSync(codeFromFile, "utf8");
        } catch (error) {
          io.err(
            `  读不了 ${codeFromFile}：${error instanceof Error ? error.message : String(error)}`,
          );
          return 4;
        }
      }
      if (!code || code.trim() === "") {
        io.err("  exec 需要 --code 或 --file（二选一）。");
        return 1;
      }
      const target = await resolvePort(io, numberValue(parsed, "port"), env);
      if (!target) return 2;
      await requireConnected(target.port, { host: target.host });
      const timeoutSec = numberValue(parsed, "timeout");
      const timeoutMs = timeoutSec === undefined ? undefined : Math.max(1, timeoutSec) * 1000;
      const result = await execute(target.port, code, {
        windowId: stringValue(parsed, "window"),
        host: target.host,
        timeoutMs,
      });
      printJson(io, { port: target.port, result }, json);
      return 0;
    }

    io.err(`  不认识的命令: ${action}`);
    for (const line of bridgeClientHelpLines()) io.err(line);
    return 1;
  } catch (error) {
    if (error instanceof BridgeClientError) {
      io.err(`  ${error.message}`);
      io.err(`  ${bridgeErrorHint(error.code)}`);
      return error.exitCode;
    }
    io.err(`  ${error instanceof Error ? error.message : String(error)}`);
    return 4;
  }
}
