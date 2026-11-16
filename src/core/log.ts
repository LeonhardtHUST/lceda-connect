import fs from "node:fs";
import path from "node:path";

import type { Io } from "./io.ts";
import { ensureDir, fileSize, readText } from "./fsx.ts";

export function appendLog(file: string, text: string): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, text, "utf8");
}

/** 超过上限就把当前日志滚存为 `<file>.1`（对应旧脚本的 Move-Item）。 */
export function rotateIfTooLarge(file: string, maxBytes: number): boolean {
  if (fileSize(file) <= maxBytes) return false;
  try {
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

/** 取最后 N 行（忽略文件末尾的空行）。 */
export function tailLines(file: string, count: number): string[] {
  const text = readText(file);
  if (text === null) return [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (count <= 0) return [];
  return lines.slice(-count);
}

/**
 * 跟随日志新增内容（等价 `Get-Content -Wait`）。
 * 检测到文件被轮转/截断（体积变小）时从头继续。
 */
export function followLog(
  file: string,
  io: Io,
  signal?: AbortSignal,
  intervalMs = 300,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let offset = fileSize(file);
    let timer: NodeJS.Timeout | null = null;

    const stop = (): void => {
      if (timer) clearInterval(timer);
      timer = null;
      resolve();
    };

    const drain = (): void => {
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        return;
      }
      if (size < offset) offset = 0;
      if (size === offset) return;
      try {
        const handle = fs.openSync(file, "r");
        try {
          const length = size - offset;
          const buffer = Buffer.alloc(length);
          fs.readSync(handle, buffer, 0, length, offset);
          offset = size;
          for (const line of buffer.toString("utf8").split(/\r?\n/)) {
            if (line !== "") io.out(line);
          }
        } finally {
          fs.closeSync(handle);
        }
      } catch {
        // 文件正在被写入时偶发读取失败，下一轮再试即可
      }
    };

    timer = setInterval(drain, intervalMs);
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }
  });
}
