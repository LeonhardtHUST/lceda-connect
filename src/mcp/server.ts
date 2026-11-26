import { fileURLToPath } from "node:url";

import {
  RootsListChangedNotificationSchema,
  type ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import { listAssetFiles, readAssetText } from "../core/assets.ts";
import { loadConfig } from "../core/config.ts";
import { resolveMcpWritePath } from "../core/pathPolicy.ts";
import { packageVersion } from "../core/version.ts";
import { toolsetsForTools, toolsForEnv } from "./registry.ts";
import { errorResult, listSavedResults, okResult, readSavedResult } from "./result.ts";
import type { McpServerFactory, McpServerFactoryOptions } from "./transports/types.ts";
import {
  ToolError,
  normalizeToolContext,
  type ToolContext,
  type ToolContextInput,
  type ToolDef,
} from "./types.ts";

export const SERVER_NAME = "lceda-connect";

export type CreateServerOptions = McpServerFactoryOptions;

function fileRootPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") return undefined;
    return fileURLToPath(parsed);
  } catch {
    return undefined;
  }
}

function safeSkillPath(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ToolError("PATH_NOT_ALLOWED", "技能资源 URI 编码无效。", { path: value });
  }
  const parts = decoded.split(/[\\/]/u);
  if (
    decoded.length === 0 ||
    decoded.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(decoded) ||
    parts.some((part) => part === "..")
  ) {
    throw new ToolError("PATH_NOT_ALLOWED", "技能资源路径必须是安全的相对路径。", { path: value });
  }
  return parts.join("/");
}

function resultResourceList(env: NodeJS.ProcessEnv) {
  return listSavedResults(env).map((uri) => ({
    uri,
    name: uri.slice("lceda://results/".length),
    mimeType: "application/json",
  }));
}

/** 调用一个工具并把结果/异常统一包装成 MCP CallToolResult。供服务端与测试共用。 */
export async function invokeTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ToolContextInput,
): Promise<ReturnType<typeof okResult>> {
  try {
    if (tool.platforms && !tool.platforms.includes(process.platform)) {
      throw new ToolError(
        "UNSUPPORTED_PLATFORM",
        `${tool.name} 不支持当前平台 ${process.platform}。`,
        { tool: tool.name, platform: process.platform, supported: tool.platforms },
      );
    }
    const normalized = normalizeToolContext(ctx);
    return okResult(await tool.run(args, normalized), undefined, {
      env: normalized.env,
      outputSchema: tool.output !== undefined,
    });
  } catch (error) {
    return errorResult(error, { env: ctx.env });
  }
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const env = options.env ?? process.env;
  const tools = options.tools ?? toolsForEnv(env, options.toolsets ?? env.LCEDA_TOOLSETS);
  const cfg = loadConfig(env);
  const toolNames = tools.map((tool) => tool.name);
  const toolsets = toolsetsForTools(tools);
  const server = new McpServer(
    { name: SERVER_NAME, version: packageVersion() },
    { capabilities: { tools: {}, resources: {} } },
  );

  let cachedRoots: string[] | undefined;
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    cachedRoots = undefined;
  });

  const roots = async (): Promise<string[]> => {
    if (cachedRoots) return [...cachedRoots];
    if (!server.server.getClientCapabilities()?.roots) {
      cachedRoots = [];
      return [];
    }
    const response = await server.server.listRoots();
    cachedRoots = response.roots.flatMap((root) => {
      const local = fileRootPath(root.uri);
      return local ? [local] : [];
    });
    return [...cachedRoots];
  };

  const makeContext = (extra: {
    signal: AbortSignal;
    sendNotification: (notification: ServerNotification) => Promise<void>;
    _meta?: { progressToken?: string | number };
  }): ToolContext => ({
    cfg,
    env,
    signal: extra.signal,
    progress: async (progress, total, message) => {
      const token = extra._meta?.progressToken;
      if (token === undefined) return;
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      });
    },
    roots,
    resolveWritePath: async (input) => resolveMcpWritePath(input, await roots(), env),
    toolNames,
    toolsets,
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>, extra) =>
        await invokeTool(tool, args ?? {}, makeContext(extra)),
    );
  }

  const skillFiles = listAssetFiles("skills", (item) => item.endsWith(".md"));
  const skillTemplate = new ResourceTemplate("lceda://skills/{+path}", {
    list: async () => ({
      resources: skillFiles.map((rel) => ({
        uri: `lceda://skills/${encodeURI(rel)}`,
        name: `skills/${rel}`,
        mimeType: "text/markdown",
        description: `技能文档 ${rel}`,
      })),
    }),
  });
  server.registerResource(
    "skills",
    skillTemplate,
    { mimeType: "text/markdown", description: "随包附带的技能 Markdown 文档" },
    async (uri, variables) => {
      const rel = safeSkillPath(String(variables.path ?? ""));
      if (!skillFiles.includes(rel)) throw new ToolError("NOT_FOUND", `没有技能文档 ${rel}`);
      return {
        contents: [
          { uri: uri.toString(), mimeType: "text/markdown", text: readAssetText("skills", rel) },
        ],
      };
    },
  );

  const resultTemplate = new ResourceTemplate("lceda://results/{id}", {
    list: async () => ({ resources: resultResourceList(env) }),
  });
  server.registerResource(
    "results",
    resultTemplate,
    { mimeType: "application/json", description: "超限 MCP 工具结果" },
    async (_uri, variables) => {
      const id = String(variables.id ?? "");
      return {
        contents: [
          {
            uri: `lceda://results/${id}`,
            mimeType: "application/json",
            text: readSavedResult(id, env),
          },
        ],
      };
    },
  );

  return server;
}

/**
 * 组装工厂：传输适配器只依赖这个函数，不依赖 createServer 的细节。
 * 每次调用必须返回独立的 McpServer（HTTP 每个 session 一个）。
 */
export function createServerFactory(options: CreateServerOptions = {}): McpServerFactory {
  return () => createServer(options);
}
