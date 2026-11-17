import { lstatSync, realpathSync } from "node:fs";
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
