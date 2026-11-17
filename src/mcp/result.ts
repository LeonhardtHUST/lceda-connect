import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { ToolError } from "./types.ts";

/** 单个工具结果文本的上限。超出时完整落盘并返回资源 URI。 */
export const MAX_RESULT_BYTES = 64 * 1024;
export const RESULT_PREVIEW_BYTES = 8 * 1024;
export const RESULT_RETENTION_COUNT = 50;

export type ResultContent =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string; text?: undefined };

export interface CallToolResultShape {
  [key: string]: unknown;
  content: ResultContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface ResultOptions {
  env?: NodeJS.ProcessEnv;
  outputSchema?: boolean;
}

function serialize(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === undefined) return "null";
  const encoded = JSON.stringify(data, null, 2);
  return encoded === undefined ? "null" : encoded;
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

function isStructuredValue(data: unknown): data is Record<string, unknown> | unknown[] {
  if (Array.isArray(data)) return true;
  if (data === null || typeof data !== "object") return false;
  const prototype = Object.getPrototypeOf(data);
  return prototype === Object.prototype || prototype === null;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.USERPROFILE || env.HOME || os.homedir();
}

export function resultRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.LCEDA_CONNECT_HOME || path.join(homeDir(env), ".lceda-connect"), "results");
}

const RESULT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

export function isValidResultId(id: string): boolean {
  return RESULT_ID_RE.test(id) && !id.includes("..\\") && !id.includes("../");
}

function retainRecentResults(dir: string): void {
  const entries = readdirSync(dir)
    .filter((name) => RESULT_ID_RE.test(name))
    .map((name) => {
      const full = path.join(dir, name);
      return { name, mtime: statSync(full).mtimeMs };
    })
    .sort((left, right) => right.mtime - left.mtime);
  for (const entry of entries.slice(RESULT_RETENTION_COUNT)) {
    try {
      unlinkSync(path.join(dir, entry.name));
    } catch {
      // A concurrent cleanup/read should not make a tool result fail.
    }
  }
}

export function saveResult(
  data: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  id: string;
  path: string;
  uri: string;
} {
  const dir = resultRoot(env);
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const id = `${timestamp}-${randomBytes(6).toString("hex")}.json`;
  const filePath = path.join(dir, id);
  writeFileSync(filePath, data, "utf8");
  retainRecentResults(dir);
  return { id, path: filePath, uri: `lceda://results/${id}` };
}

export function listSavedResults(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = resultRoot(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => RESULT_ID_RE.test(name))
    .sort()
    .map((id) => `lceda://results/${id}`);
}

export function readSavedResult(id: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isValidResultId(id)) throw new ToolError("NOT_FOUND", "结果资源标识无效。");
  const dir = resultRoot(env);
  const filePath = path.join(dir, id);
  const relative = path.relative(dir, filePath);
  if (!existsSync(filePath) || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ToolError("NOT_FOUND", `没有找到结果资源 ${id}`);
  }
  return readFileSync(filePath, "utf8");
}

function oversizedResult(
  full: string,
  maxBytes: number,
  env: NodeJS.ProcessEnv,
  outputSchema: boolean,
): CallToolResultShape {
  const originalBytes = Buffer.byteLength(full, "utf8");
  const stored = saveResult(full, env);
  const preview = truncateUtf8(full, RESULT_PREVIEW_BYTES).text;
  const payload = outputSchema
    ? {
        error: "RESULT_TOO_LARGE",
        message: "声明了 outputSchema 的工具结果超过 64 KiB，完整结果已落盘。",
        details: { originalBytes, resultUri: stored.uri, path: stored.path },
      }
    : {
        truncated: true,
        originalBytes,
        resultUri: stored.uri,
        path: stored.path,
        preview,
        hint: `完整结果已落盘；请读取 ${stored.uri}，或缩小查询范围。`,
      };
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [
      { type: "text", text },
      { type: "resource_link", uri: stored.uri, name: stored.id, mimeType: "application/json" },
    ],
    isError: outputSchema || undefined,
    _meta: {
      truncated: true,
      originalBytes,
      maxBytes,
      resultUri: stored.uri,
      path: stored.path,
    },
  };
}

export function okResult(
  data: unknown,
  maxBytes = MAX_RESULT_BYTES,
  options: ResultOptions = {},
): CallToolResultShape {
  const full = serialize(data);
  const byteLength = Buffer.byteLength(full, "utf8");
  if (byteLength > maxBytes) {
    return oversizedResult(
      full,
      maxBytes,
      options.env ?? process.env,
      options.outputSchema ?? false,
    );
  }

  const result: CallToolResultShape = {
    content: [{ type: "text", text: full }],
  };
  if (isStructuredValue(data)) {
    result.structuredContent = Array.isArray(data) ? { items: data } : data;
  }
  return result;
}

export function errorResult(error: unknown, options: ResultOptions = {}): CallToolResultShape {
  if (error instanceof ToolError) {
    const payload: Record<string, unknown> = { error: error.code, message: error.message };
    if (error.details !== undefined) payload.details = error.details;
    return { ...okResult(payload, MAX_RESULT_BYTES, options), isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ...okResult({ error: "INTERNAL", message }, MAX_RESULT_BYTES, options), isError: true };
}
