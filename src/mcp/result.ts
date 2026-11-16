import { ToolError } from "./types.ts";

/** 单个工具结果文本的上限。超出时截断并在 _meta 里说明，避免把整个上下文窗口塞满。 */
export const MAX_RESULT_BYTES = 64 * 1024;

export interface CallToolResultShape {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

function serialize(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === undefined) return "null";
  return JSON.stringify(data, null, 2);
}

/** 按 UTF-8 字节截断，并保证不切坏多字节字符。 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // 回退到字符边界：UTF-8 续字节形如 10xxxxxx
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

export function okResult(data: unknown, maxBytes = MAX_RESULT_BYTES): CallToolResultShape {
  const full = serialize(data);
  const { text, truncated } = truncateUtf8(full, maxBytes);
  const result: CallToolResultShape = {
    content: [
      {
        type: "text",
        text: truncated
          ? `${text}\n…[结果被截断：原始 ${Buffer.byteLength(full, "utf8")} 字节，上限 ${maxBytes} 字节。请缩小查询范围或改用 outDir 落盘。]`
          : text,
      },
    ],
  };
  if (truncated) {
    result._meta = { truncated: true, originalBytes: Buffer.byteLength(full, "utf8") };
  }
  return result;
}

export function errorResult(error: unknown): CallToolResultShape {
  if (error instanceof ToolError) {
    const payload: Record<string, unknown> = { error: error.code, message: error.message };
    if (error.details !== undefined) payload.details = error.details;
    return { ...okResult(payload), isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ...okResult({ error: "INTERNAL", message }), isError: true };
}
