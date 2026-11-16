import type { z } from "zod";

import type { AppConfig } from "../core/config.ts";

/** 工具运行时拿到的上下文。CLI 与 MCP 共用同一份配置加载逻辑。 */
export interface ToolContext {
  cfg: AppConfig;
  env: NodeJS.ProcessEnv;
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
 * - `run` 返回任意可 JSON 序列化的数据；需要以错误形式返回时抛 `ToolError`。
 */
export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodRawShape;
  annotations?: ToolAnnotations;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/** 带类型推断地定义工具：handler 的 args 由 input 自动推导。 */
export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  input: S;
  annotations?: ToolAnnotations;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => unknown;
}): ToolDef {
  return {
    name: def.name,
    description: def.description,
    input: def.input,
    annotations: def.annotations,
    run: async (args, ctx) => await def.handler(args as z.infer<z.ZodObject<S>>, ctx),
  };
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

/** 写操作的统一闸口：没有 confirm=true 时只返回预览，不执行。 */
export function requireConfirm(confirm: boolean | undefined, preview: unknown): void {
  if (!confirm) {
    throw new ToolError("CONFIRM_REQUIRED", "这是写操作，确认影响后以 confirm: true 重新调用。", {
      preview,
    });
  }
}
