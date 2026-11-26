import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { packageVersion } from "../../core/version.ts";
import { createServerFactory, SERVER_NAME } from "../server.ts";
import type { TransportHandle, TransportStartOptions } from "./types.ts";

/**
 * stdio 传输适配器（薄层）。
 *
 * 只做三件事：从工厂拿一个 McpServer、接到 StdioServerTransport、把就绪日志写 stderr。
 * stdout 归 JSON-RPC 协议所有，这里不写任何日志。
 */

export interface StdioTransportOptions extends TransportStartOptions {
  /** 诊断日志出口，默认 stderr。 */
  log?: (line: string) => void;
}

export interface StdioTransportHandle extends TransportHandle {
  readonly kind: "stdio";
}

export async function startStdioTransport(
  options: StdioTransportOptions,
): Promise<StdioTransportHandle> {
  const serverFactory = options.serverFactory ?? createServerFactory(options);
  const server = serverFactory();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  log(`[${SERVER_NAME}] MCP 服务已在 stdio 上就绪 (v${packageVersion()})`);

  let closed = false;
  return {
    kind: "stdio",
    close: async () => {
      if (closed) return;
      closed = true;
      await server.close();
    },
  };
}

/** 兼容旧入口：连接后即返回（进程由 stdio 传输保持存活）。 */
export async function serveStdio(
  env: NodeJS.ProcessEnv = process.env,
  toolsets?: TransportStartOptions["toolsets"],
): Promise<void> {
  await startStdioTransport({ env, toolsets });
}
