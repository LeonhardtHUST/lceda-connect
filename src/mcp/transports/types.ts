import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolsetSelection } from "../registry.ts";
import type { ToolDef } from "../types.ts";

/**
 * 传输适配层的公共契约。
 *
 * 组装（tools/resources/roots/写路径策略）只发生在 `createServer` / `createServerFactory`；
 * stdio 与 Streamable HTTP 只做「把协议的字节搬到 McpServer 上」这一件事。
 * 这样新增传输（SSE、WebSocket、进程内 pipe）时只需要写一个适配器，
 * 不在传输层复制任何业务/权限逻辑。
 */

export interface McpServerFactoryOptions {
  env?: NodeJS.ProcessEnv;
  tools?: ToolDef[];
  toolsets?: ToolsetSelection;
}

/** 每次调用返回一个独立的 McpServer；HTTP 每个 session 一个，stdio 一个。 */
export type McpServerFactory = () => McpServer;

export interface TransportStartOptions {
  env: NodeJS.ProcessEnv;
  toolsets?: ToolsetSelection;
  /** 嵌入/测试用：覆盖默认的 createServerFactory。 */
  serverFactory?: McpServerFactory;
}

/** 传输实例的生命周期句柄；`close` 必须可重复调用。 */
export interface TransportHandle {
  /** 监听地址（HTTP）；stdio 没有。 */
  readonly url?: string;
  close(): Promise<void>;
}
