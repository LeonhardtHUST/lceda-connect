import path from "node:path";
import type { z } from "zod";

import type { AppConfig } from "../core/config.ts";

/** 工具运行时拿到的上下文。CLI 与 MCP 共用同一份配置加载逻辑。 */
export interface ToolContext {
  cfg: AppConfig;
  env: NodeJS.ProcessEnv;
  /** 当前 MCP 请求的取消信号。 */
  signal: AbortSignal;
  /** 向客户端报告当前请求进度；没有 progressToken 时是 no-op。 */
  progress(progress: number, total?: number, message?: string): Promise<void>;
  /** 取得 MCP 客户端声明的 roots（本地路径）。 */
  roots(): Promise<string[]>;
  /** 校验并解析一个 MCP 写路径。 */
  resolveWritePath(p: string): Promise<string>;
  /** 当前服务实例注册的工具名，供 core 工具展示。 */
  toolNames?: readonly string[];
  /** 当前服务实例的 toolset → 工具名映射。 */
  toolsets?: Readonly<Record<string, readonly string[]>>;
}

/** 旧版直接调用 ToolDef.run 时可传入的上下文，新增字段均有默认值。 */
export type ToolContextInput = Pick<ToolContext, "cfg" | "env"> &
  Partial<Omit<ToolContext, "cfg" | "env">>;

/** 为旧版直接调用补齐新增上下文字段。 */
export function normalizeToolContext(ctx: ToolContextInput): ToolContext {
  return {
    ...ctx,
    signal: ctx.signal ?? new AbortController().signal,
    progress: ctx.progress ?? (async () => undefined),
    roots: ctx.roots ?? (async () => []),
    resolveWritePath: ctx.resolveWritePath ?? (async (p: string) => path.resolve(p)),
  };
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * 一个 MCP 工具的定义（类型已擦除，便于放进同一个数组里统一注册）。
 *
 * - `input` 是 zod 的 raw shape（`{ file: z.string(), ... }`），SDK 会据此生成 JSON Schema 并做参数校验。
 * - `output` 是可选的 zod raw shape，存在时会注册 MCP outputSchema。
 * - `run` 返回任意可 JSON 序列化的数据；需要以错误形式返回时抛 `ToolError`。
 */
export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodRawShape;
  /** Bounded plain-object result shape; >64 KiB returns RESULT_TOO_LARGE + resource_link. */
  output?: z.ZodRawShape;
  annotations?: ToolAnnotations;
  platforms?: readonly NodeJS.Platform[];
  toolset?: string;
  run: (args: Record<string, unknown>, ctx: ToolContextInput) => Promise<unknown>;
}

/** 带类型推断地定义工具：handler 的 args 由 input 自动推导。 */
export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  input: S;
  /** Bounded plain-object result shape; >64 KiB returns RESULT_TOO_LARGE + resource_link. */
  output?: z.ZodRawShape;
  annotations?: ToolAnnotations;
  platforms?: readonly NodeJS.Platform[];
  toolset?: string;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => unknown;
}): ToolDef {
  return {
    name: def.name,
    description: def.description,
    input: def.input,
    output: def.output,
    annotations: def.annotations,
    platforms: def.platforms,
    toolset: def.toolset,
    run: async (args, ctx) =>
      await def.handler(args as z.infer<z.ZodObject<S>>, normalizeToolContext(ctx)),
  };
}

/** 非 Windows 平台调用 Windows 专属工具时抛出统一错误。 */
export function requireWindows(toolName: string): void {
  if (process.platform !== "win32") {
    throw new ToolError(
      "UNSUPPORTED_PLATFORM",
      `${toolName} 仅支持 Windows 平台，当前平台为 ${process.platform}。`,
      { tool: toolName, platform: process.platform, required: ["win32"] },
    );
  }
}

/** 写操作的统一闸口：没有 confirm=true 时只返回预览，不执行。 */
export function requireConfirm(confirm: boolean | undefined, preview: unknown): void {
  if (!confirm) {
    throw new ToolError("CONFIRM_REQUIRED", "这是写操作，确认影响后以 confirm: true 重新调用。", {
      preview,
    });
  }
}

/** 领域内可预期的失败（参数不对、目标不存在、通道不可用…）。会作为 isError 结果返回，而不是协议错误。 */
export class ToolError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}
