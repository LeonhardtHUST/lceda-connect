import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { listAssetFiles, readAssetText } from "../core/assets.ts";
import { loadConfig } from "../core/config.ts";
import { packageVersion } from "../main.ts";
import { allTools } from "./registry.ts";
import { errorResult, okResult } from "./result.ts";
import type { ToolContext, ToolDef } from "./types.ts";

export const SERVER_NAME = "lceda-connect";

export interface CreateServerOptions {
  env?: NodeJS.ProcessEnv;
  tools?: ToolDef[];
}

/** 调用一个工具并把结果/异常统一包装成 MCP CallToolResult。供服务端与测试共用。 */
export async function invokeTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ReturnType<typeof okResult>> {
  try {
    return okResult(await tool.run(args, ctx));
  } catch (error) {
    return errorResult(error);
  }
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const env = options.env ?? process.env;
  const ctx: ToolContext = { cfg: loadConfig(env), env };
  const server = new McpServer(
    { name: SERVER_NAME, version: packageVersion() },
    { capabilities: { tools: {}, resources: {} } },
  );

  for (const tool of options.tools ?? allTools()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => await invokeTool(tool, args ?? {}, ctx),
    );
  }

  // 每个技能的 Markdown 文档作为只读 resource 暴露，客户端可按需拉取。
  for (const rel of listAssetFiles("skills", (p) => p.endsWith(".md"))) {
    const uri = `lceda://skills/${rel}`;
    server.registerResource(
      `skills/${rel}`,
      uri,
      { mimeType: "text/markdown", description: `技能文档 ${rel}` },
      async () => ({
        contents: [{ uri, mimeType: "text/markdown", text: readAssetText("skills", rel) }],
      }),
    );
  }

  return server;
}

/** 以 stdio 方式运行 MCP 服务。stdout 归协议所有，日志一律写 stderr。 */
export async function serveStdio(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const server = createServer({ env });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[${SERVER_NAME}] MCP 服务已在 stdio 上就绪 (v${packageVersion()})\n`);
}
