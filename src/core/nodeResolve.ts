import path from "node:path";

import { run } from "./exec.ts";
import { exists, listDirs } from "./fsx.ts";
import { homeDir } from "./config.ts";

export interface NodeCandidate {
  path: string;
  source: string;
}

export interface VersionDir {
  dir: string;
  version: string;
}

/** `22.22.2-6` 这类带后缀的目录名，只取前面的版本号。 */
export function parseVersionName(name: string): string | null {
  const match = /^\d+(?:\.\d+){0,3}/.exec(name);
  return match ? match[0] : null;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 按版本号倒序列出某个 root 下的版本目录。 */
export function listVersionDirs(root: string): VersionDir[] {
  const items: VersionDir[] = [];
  for (const dir of listDirs(root)) {
    const version = parseVersionName(path.basename(dir));
    if (version) items.push({ dir, version });
  }
  return items.sort((left, right) => compareVersions(right.version, left.version));
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  return raw.split(path.delimiter).filter((entry) => entry.trim() !== "");
}

/**
 * node 候选列表，优先级与旧脚本一致：
 * 环境变量 → vp js_runtime（真实 node）→ WorkBuddy 内置 → PATH → vp 启动壳 → 官方安装目录。
 * 这里只做「可能能用」的枚举，是否真能跑由 probeNodeVersion 判定。
 */
export function nodeCandidates(env: NodeJS.ProcessEnv = process.env): NodeCandidate[] {
  const home = homeDir(env);
  const list: NodeCandidate[] = [];

  if (env.LCEDA_NODE) {
    list.push({ path: env.LCEDA_NODE, source: "环境变量 LCEDA_NODE" });
  }

  for (const item of listVersionDirs(path.join(home, ".vite-plus", "js_runtime", "node"))) {
    list.push({ path: path.join(item.dir, "node.exe"), source: `vp js_runtime ${item.version}` });
  }

  for (const item of listVersionDirs(
    path.join(home, ".workbuddy", "binaries", "node", "versions"),
  )) {
    list.push({ path: path.join(item.dir, "node.exe"), source: `WorkBuddy 内置 ${item.version}` });
  }

  for (const entry of pathEntries(env)) {
    const candidate = path.join(entry, "node.exe");
    if (exists(candidate)) {
      list.push({ path: candidate, source: "PATH" });
      break;
    }
  }

  const vpShell = path.join(home, ".vite-plus", "bin", "node.exe");
  if (exists(vpShell)) {
    list.push({ path: vpShell, source: "vp 启动壳" });
  }

  for (const programFiles of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    if (!programFiles) continue;
    const standard = path.join(programFiles, "nodejs", "node.exe");
    if (exists(standard)) {
      list.push({ path: standard, source: `官方安装 (${programFiles})` });
    }
  }

  const seen = new Set<string>();
  const unique: NodeCandidate[] = [];
  for (const candidate of list) {
    const key = candidate.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

/**
 * 校验一个 exe 是否真能跑，能跑返回版本号（如 v26.13.0）。
 * 只判断文件存在不够：vp 的 bin\node.exe 只是个壳，js_runtime 被清掉后就跑不起来。
 */
export async function probeNodeVersion(exe: string, timeoutMs = 5000): Promise<string | null> {
  if (!exe || !exists(exe)) return null;
  // 外部 NODE_OPTIONS 有可能让 node 卡住，探活时先摘掉。
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = await run(exe, ["-v"], { timeoutMs, env, cwd: process.env.TEMP ?? process.cwd() });
  if (result.code !== 0) return null;
  const output = result.stdout.trim();
  return /^v\d+\./.test(output) ? output : null;
}

let cachedNode: { path: string; version: string } | null = null;

export function resetNodeCache(): void {
  cachedNode = null;
}

/** 选出第一个真能跑的 node；结果在进程内缓存（supervise 重启时会主动 reset）。 */
export async function resolveNodePath(
  env: NodeJS.ProcessEnv = process.env,
  options: { useCache?: boolean } = {},
): Promise<{ path: string; version: string } | null> {
  if (options.useCache !== false && cachedNode && exists(cachedNode.path)) return cachedNode;
  for (const candidate of nodeCandidates(env)) {
    const version = await probeNodeVersion(candidate.path);
    if (version) {
      cachedNode = { path: candidate.path, version };
      return cachedNode;
    }
  }
  return null;
}
