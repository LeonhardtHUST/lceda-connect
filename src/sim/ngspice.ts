/**
 * ngspice 定位、探测与批处理执行（源仓库 scripts/sim_exec.py + sweep_runner.py
 * 里硬编码 `C:\Users\Leon\...` 的部分统一改成 配置 → 环境变量 → 探测）。
 *
 * 布局约定：batch 模式用 `ngspice -b <deck>`，工作目录由调用方给出；
 * 超时后 core/exec.ts 会 kill 进程并以 code -1 返回。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { run, type RunResult } from "../core/exec.ts";
import { SimError } from "./types.ts";

export const NGSPICE_PROBE_TIMEOUT_MS = 20_000;
export const NGSPICE_RUN_TIMEOUT_MS = 600_000;

export class NgspiceError extends SimError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "NgspiceError";
  }
}

export type NgspiceSource = "config" | "env" | "path" | "workbuddy" | "known";

export interface NgspiceCandidate {
  bin: string;
  source: NgspiceSource;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
}

/** 在 PATH 里找可执行文件（Windows 补 .exe）。 */
function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEntries(env)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** 把一个可能是裸名字的候选解析成绝对路径（找不到原样返回）。 */
export function resolveExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path.isAbsolute(name) || name.includes(path.sep) || name.includes("/")) {
    return name;
  }
  return findOnPath(name, env) ?? name;
}

/**
 * 候选 ngspice 可执行文件，按优先级：
 * 配置（sim_config 的 ngspice_bin）→ NGSPICE_BIN → PATH → workbuddy 目录 → 已知安装路径。
 */
export function ngspiceCandidates(
  env: NodeJS.ProcessEnv = process.env,
  configured?: string | null,
): NgspiceCandidate[] {
  const candidates: NgspiceCandidate[] = [];
  const seen = new Set<string>();
  const push = (bin: string | null | undefined, source: NgspiceSource): void => {
    if (!bin) return;
    const resolved = resolveExecutable(bin, env);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ bin: resolved, source });
  };

  push(configured ?? null, "config");
  push(env.NGSPICE_BIN ?? null, "env");
  push(findOnPath("ngspice_con", env), "path");
  push(findOnPath("ngspice", env), "path");

  // ~/.workbuddy/binaries/ngspice/<版本>/Spice64/bin/ngspice_con.exe
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const root = path.join(home, ".workbuddy", "binaries", "ngspice");
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .sort();
    for (const dir of entries) {
      push(path.join(dir, "Spice64", "bin", "ngspice_con.exe"), "workbuddy");
      push(path.join(dir, "Spice64", "bin", "ngspice.exe"), "workbuddy");
    }
  } catch {
    // 目录不存在是正常情况（用户可能装在别处）
  }

  // 常见 Windows 安装位置
  const programFiles = env.ProgramFiles ?? env["ProgramFiles"] ?? "C:\\Program Files";
  push(path.join(programFiles, "ngspice", "Spice64", "bin", "ngspice_con.exe"), "known");
  push("C:\\Spice64\\bin\\ngspice_con.exe", "known");
  return candidates;
}

/** 同步检查候选是否可用（只看文件在不在，不跑进程）。 */
export function findNgspiceSync(
  env: NodeJS.ProcessEnv = process.env,
  configured?: string | null,
): string | null {
  for (const candidate of ngspiceCandidates(env, configured)) {
    if (isFile(candidate.bin)) return candidate.bin;
  }
  return null;
}

/** 从 `ngspice -v` 的输出里解析版本号。 */
export function parseNgspiceVersion(text: string): string | null {
  const match = /ngspice-(\d+[\w.-]*)/.exec(text);
  if (match) return `ngspice-${match[1]}`;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[1] ?? lines[0] ?? null;
}

/** 跑 `ngspice -v` 拿版本；失败返回 null。 */
export async function getNgspiceVersion(
  binPath: string | null | undefined,
  timeoutMs = NGSPICE_PROBE_TIMEOUT_MS,
): Promise<string | null> {
  if (!binPath) return null;
  const result = await run(binPath, ["-v"], { timeoutMs });
  if (result.error && (result.error.includes("ENOENT") || result.error.includes("EACCES"))) {
    return null;
  }
  return parseNgspiceVersion(result.stdout + result.stderr);
}

export interface NgspiceCandidateProbe extends NgspiceCandidate {
  ok: boolean;
  version: string | null;
  error?: string;
}

export interface NgspiceProbeResult {
  available: boolean;
  bin: string | null;
  version: string | null;
  source: NgspiceSource | null;
  candidates: NgspiceCandidateProbe[];
  hint: string;
}

/**
 * 探测可用的 ngspice：逐个候选跑 `-v`。
 * 本机没装时返回 available=false 且给出安装提示，不抛异常（探测工具本来就要能回答"没有"）。
 */
export async function probeNgspice(
  env: NodeJS.ProcessEnv = process.env,
  configured?: string | null,
): Promise<NgspiceProbeResult> {
  const candidates = ngspiceCandidates(env, configured);
  const probes: NgspiceCandidateProbe[] = [];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate.bin) && !isFile(candidate.bin)) {
      probes.push({ ...candidate, ok: false, version: null, error: "文件不存在" });
      continue;
    }
    const result = await run(candidate.bin, ["-v"], { timeoutMs: NGSPICE_PROBE_TIMEOUT_MS });
    const version = parseNgspiceVersion(result.stdout + result.stderr);
    const ok = !result.error && result.code === 0;
    probes.push({
      ...candidate,
      ok,
      version,
      error: result.error ?? (ok ? undefined : result.stderr.trim().slice(0, 200)),
    });
    if (ok) {
      return {
        available: true,
        bin: candidate.bin,
        version,
        source: candidate.source,
        candidates: probes,
        hint: "",
      };
    }
  }
  return {
    available: false,
    bin: null,
    version: null,
    source: null,
    candidates: probes,
    hint:
      "没有找到 ngspice。安装 ngspice-47 后设置 NGSPICE_BIN，或把 ngspice_con.exe 放进 PATH / " +
      "%USERPROFILE%\\.workbuddy\\binaries\\ngspice\\<版本>\\Spice64\\bin\\。",
  };
}

export interface RunNgspiceOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * batch 模式跑一个 deck：`ngspice -b <deck 文件名>`（cwd 作为工作目录，
 * 这样 deck 里的 `write tran.raw` 落到工作目录）。
 */
export async function runNgspiceBatch(
  bin: string,
  deckPath: string,
  options: RunNgspiceOptions = {},
): Promise<RunResult> {
  const cwd = options.cwd ?? path.dirname(deckPath);
  const result = await run(bin, ["-b", path.basename(deckPath)], {
    cwd,
    timeoutMs: options.timeoutMs ?? NGSPICE_RUN_TIMEOUT_MS,
    env: options.env,
  });
  if (result.error && /ENOENT|EACCES/i.test(result.error)) {
    throw new NgspiceError(
      "NGSPICE_NOT_FOUND",
      `找不到可执行的 ngspice: ${bin}（${result.error}）`,
    );
  }
  return result;
}

/** ngspice 二进制是否还在（不跑进程）。 */
export function ngspiceExists(bin: string | null | undefined): boolean {
  return Boolean(bin) && existsSync(bin as string);
}
