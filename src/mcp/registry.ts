import { apiDocsTools } from "../apidocs/mcpTools.ts";
import { bridgeTools } from "../bridge/mcpTools.ts";
import { cdpTools } from "../cdp/mcpTools.ts";
import { coreTools } from "./coreTools.ts";
import type { ToolDef } from "./types.ts";

/**
 * 全部 MCP 工具。每个领域在自己的目录里导出一个 ToolDef 数组，在这里汇总。
 * 新增领域：在对应目录写 mcpTools.ts 导出 `xxxTools: ToolDef[]`，再加到下面。
 */
export function allTools(): ToolDef[] {
  const tools = [...coreTools, ...cdpTools, ...bridgeTools, ...apiDocsTools];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`MCP 工具重名：${tool.name}`);
    seen.add(tool.name);
  }
  return tools;
}
