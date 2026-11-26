export { loadConfig, DEFAULT_PRO_EXE, DEFAULT_CDP_PORT } from "./core/config.ts";
export type { AppConfig, BridgeConfig, CdpConfig, ConfigOverrides } from "./core/config.ts";
export type { BridgeHealth, CdpInfo, ProcInfo, TcpListener } from "./core/types.ts";
export { main, packageVersion } from "./main.ts";
export { runCdpAction } from "./commands/cdp.ts";
export { runBridgeAction } from "./commands/bridge.ts";
export type {
  BridgeAction,
  BridgeOptions,
  CdpAction,
  CdpOptions,
  CommandContext,
} from "./commands/types.ts";

// 合并进来的各领域库 API（CLI 与 MCP 共用的同一套实现）
export * as epro2 from "./epro2/index.ts";
export * as eprj3 from "./eprj3/index.ts";
export * as format from "./format/index.ts";
export * as sim from "./sim/index.ts";
export { createServer, createServerFactory } from "./mcp/server.ts";
export { serveStdio, startHttpTransport, startStdioTransport } from "./mcp/transports/index.ts";
export { allTools } from "./mcp/registry.ts";
export { defineTool, ToolError } from "./mcp/types.ts";
export type { ToolContext, ToolDef } from "./mcp/types.ts";
