/**
 * CDP 客户端的领域错误。
 *
 * `code` 给 MCP 用（ToolError 的错误码），`exitCode` 给 CLI 用（沿用源仓库脚本的
 * 退出码口径：0 成功 / 1 未找到或用法 / 2 端点或选页失败 / 3 拒绝 / 4 协议错误）。
 * 两者都放在异常上，避免 CLI 与 MCP 各写一套映射表。
 */
export class CdpError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    options: { exitCode?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CdpError";
    this.code = code;
    this.exitCode = options.exitCode ?? 4;
    this.details = options.details;
  }
}

/** 把任意异常归一成 CdpError：已经带 code 的保留，其余按兜底码包装。 */
export function asCdpError(error: unknown, fallbackCode = "CDP_ERROR"): CdpError {
  if (error instanceof CdpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const exitCode = (error as { exitCode?: unknown } | null)?.exitCode;
  return new CdpError(typeof code === "string" ? code : fallbackCode, message, {
    exitCode: typeof exitCode === "number" ? exitCode : 4,
    cause: error,
  });
}

/** 只截取错误文本的前 N 个字符，避免把整页 DOM 或堆栈塞进错误串。 */
export function clipText(value: unknown, limit = 200): string {
  const text = coerceText(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 把未知值转成可读文本：字符串原样，标量转字符串，对象用 JSON（不产生 [object Object]）。 */
export function coerceText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.stringify(value) ?? fallback;
  } catch {
    return fallback;
  }
}
