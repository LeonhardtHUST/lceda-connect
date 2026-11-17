import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { ToolError } from "../mcp/types.ts";
function comparePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Resolve a path through the nearest existing ancestor so a symlink/junction
 * cannot make a seemingly in-root write escape the configured root.
 */
function realpathWithMissing(target: string): string | undefined {
  let current = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try {
      lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      suffix.unshift(path.basename(current));
      current = parent;
      continue;
    }
    try {
      return comparePath(path.resolve(realpathSync.native(current), ...suffix));
    } catch {
      return undefined;
    }
  }
}

/**
 * Whether `target` is inside one of `roots` after normalization and realpath
 * resolution of the nearest existing target ancestor.
 */
export function isWithinRoots(target: string, roots: readonly string[]): boolean {
  if (typeof target !== "string" || roots.length === 0) return false;
  const canonicalTarget = realpathWithMissing(target);
  if (!canonicalTarget) return false;
  return roots.some((root) => {
    if (typeof root !== "string" || root.trim() === "") return false;
    const canonicalRoot = realpathWithMissing(root);
    if (!canonicalRoot) return false;
    const relative = path.relative(canonicalRoot, canonicalTarget);
    const normalizedRelative = comparePath(relative);
    return (
      normalizedRelative === "" ||
      (!normalizedRelative.startsWith(`..${path.sep}`) &&
        normalizedRelative !== ".." &&
        !path.isAbsolute(normalizedRelative))
    );
  });
}

/** Default roots used by the MCP write-path policy. */
export function defaultWriteRoots(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string[] {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const connectHome = env.LCEDA_CONNECT_HOME || path.join(home, ".lceda-connect");
  return [cwd, os.tmpdir(), connectHome];
}

/** Parse LCEDA_ALLOWED_ROOTS, preserving platform-specific path delimiters. */
export function allowedRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const value = env.LCEDA_ALLOWED_ROOTS;
  if (!value || value === "*") return [];
  return value
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Resolve a write path against the process working directory and enforce the
 * MCP roots policy. `*` in LCEDA_ALLOWED_ROOTS explicitly disables limits.
 */
export function resolveMcpWritePath(
  input: string,
  roots: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const target = path.resolve(input);
  if (env.LCEDA_ALLOWED_ROOTS === "*") return target;
  const allowed = [...roots, ...allowedRootsFromEnv(env), ...defaultWriteRoots(env)];
  const unique = [...new Set(allowed.map((root) => path.resolve(root)))];
  if (!isWithinRoots(target, unique)) {
    throw new ToolError("PATH_NOT_ALLOWED", `写路径不在允许的 MCP 根目录内：${input}`, {
      path: target,
      roots: unique,
    });
  }
  return target;
}

function pathNotAllowed(target: string, reason: string): ToolError {
  return new ToolError("PATH_NOT_ALLOWED", `拒绝不安全的产物路径：${target}（${reason}）`, {
    path: target,
    reason,
  });
}

/**
 * Canonicalize a path through its nearest existing ancestor (realpath), keeping
 * any missing suffix so callers can still create it. Returns undefined for a
 * dangling symlink or an unresolvable component.
 */
function canonicalWithMissing(target: string): string | undefined {
  let current = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try {
      lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      suffix.unshift(path.basename(current));
      current = parent;
      continue;
    }
    try {
      return path.resolve(realpathSync.native(current), ...suffix);
    } catch {
      // Dangling link: lstat succeeds, realpath cannot resolve it.
      return undefined;
    }
  }
}

function isReparsePoint(current: string): boolean {
  const stats = lstatSync(current);
  if (stats.isSymbolicLink()) return true;
  if (process.platform !== "win32") return false;
  try {
    return comparePath(realpathSync.native(current)) !== comparePath(path.resolve(current));
  } catch {
    return true;
  }
}

/**
 * Resolve the parent through realpath first so system-level aliases such as
 * macOS `/tmp` or `/var` are followed instead of rejected, then reject an
 * existing final component that is a symlink, junction, or dangling link.
 * Missing final components are allowed so callers can create them.
 */
export function assertSafeOutputPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const parent = canonicalWithMissing(path.dirname(resolved));
  if (!parent) {
    throw pathNotAllowed(resolved, "父目录包含悬空或无法解析的链接");
  }
  const target = path.join(parent, path.basename(resolved));
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
    throw pathNotAllowed(resolved, "目标路径无法安全检查");
  }
  if (stats.isSymbolicLink() || isReparsePoint(target)) {
    throw pathNotAllowed(resolved, "目标文件是符号链接或 reparse point");
  }
  return target;
}

/** Create an output directory only after checking that an existing path is safe. */
export function ensureSafeOutputDir(dirPath: string): string {
  const target = assertSafeOutputPath(dirPath);
  mkdirSync(target, { recursive: true });
  return assertSafeOutputPath(target);
}

/** Reject links already present in a simulation work directory before execution. */
export function assertSafeWorkDirEntries(dirPath: string): string {
  const target = assertSafeOutputPath(dirPath);
  for (const entry of readdirSync(target)) {
    const entryPath = path.join(target, entry);
    if (isReparsePoint(entryPath)) {
      throw pathNotAllowed(entryPath, "工作目录中存在符号链接或 reparse point");
    }
  }
  return target;
}

/**
 * Write through a same-directory temporary file and atomic rename. The final
 * component is never opened for writing, so an existing ordinary file can be
 * replaced while a symlink is rejected rather than followed.
 */
export function safeWriteFile(filePath: string, data: string | NodeJS.ArrayBufferView): string {
  const target = assertSafeOutputPath(filePath);
  const parent = path.dirname(target);
  const temporary = path.join(
    parent,
    `.${path.basename(target)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o666);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    assertSafeOutputPath(target);
    renameSync(temporary, target);
    return target;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup; preserve the original failure.
    }
    throw error;
  }
}

export function safeWriteText(filePath: string, text: string): string {
  return safeWriteFile(filePath, text);
}

export function safeWriteJson(filePath: string, value: unknown): string {
  return safeWriteText(filePath, JSON.stringify(value, null, 1));
}
