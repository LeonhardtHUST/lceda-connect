import fs from "node:fs";
import path from "node:path";

export function exists(target: string): boolean {
  return fs.existsSync(target);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readLines(file: string): string[] {
  const text = readText(file);
  if (text === null) return [];
  return text.replace(/^\uFEFF/, "").split(/\r?\n/);
}

export function writeText(file: string, text: string): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, "utf8");
}

export function readJson<T>(file: string): T | null {
  const text = readText(file);
  if (text === null || text.trim() === "") return null;
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

export function writeJson(file: string, value: unknown): void {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 忽略：清理动作本身不应该让命令失败
  }
}

export function listDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

/** 人类可读体积，沿用旧脚本的 N MB / N KB / N B 写法。 */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
