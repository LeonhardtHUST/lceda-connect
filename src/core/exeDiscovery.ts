import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  isWindowsDrivePath,
  windowsPathToWslPath,
  wslPathToWindowsPath,
  type ClientLocation,
  type EnvironmentInfo,
} from "./environment.ts";

/**
 * 客户端可执行文件发现。
 *
 * 候选路径同时取决于两件事：执行环境（windows-native / wsl2 / linux / macos）和
 * 客户端实例位置（WSL2 下 host=Windows 宿主、vm=WSL 虚拟机内）。只做
 * 「列候选 → 逐个 stat」，不猜不存在的位置；找不到时把试过的路径完整吐出来。
 * 跨环境时统一成当前进程能执行的路径（WSL2 + host 是 /mnt/d/...），同时保留
 * Windows 形式的 hostPath 供 pid 记录与提示。
 */

export interface ExeCandidate {
  path: string;
  source: string;
}

export interface ExeCandidateResult extends ExeCandidate {
  exists: boolean;
}

export type ClientExeStatus = "explicit" | "discovered" | "explicit_missing" | "not_found";

export interface ClientExeDiscovery {
  status: ClientExeStatus;
  /** 当前进程可直接执行的路径；找不到时为 null。 */
  path: string | null;
  /** 宿主（Windows）风格路径，便于日志 / pid 记录；未知时 null。 */
  hostPath: string | null;
  source: string;
  /** 这个结果对应的实例位置。 */
  location: ClientLocation;
  candidates: ExeCandidateResult[];
  warnings: string[];
  environment: EnvironmentInfo["kind"];
}

export interface DiscoverExeOptions {
  environment: EnvironmentInfo;
  /** 实例位置；省略时取 environment.clientLocations[0]。 */
  location?: ClientLocation;
  env?: NodeJS.ProcessEnv;
  /** 显式路径（--exe / 配置文件 / LCEDA_PRO_EXE）；优先级最高，找不到不回退。 */
  explicitPath?: string | null;
  /** 测试注入。 */
  exists?: (file: string) => boolean;
  /** deep=true 时额外调用 where/which（较慢，默认关闭）。 */
  deep?: boolean;
  runText?: (command: string, args: readonly string[], timeoutMs: number) => string | null;
}

const EXE_NAME = "lceda-pro.exe";
const DRIVE_LETTERS = ["c", "d", "e", "f"] as const;
const PROGRAM_DIRS = ["Program Files", "Program Files (x86)"] as const;
const WSL_HOST_EXE_NAMES = ["lceda-pro.exe", "lceda-pro", "easyeda-pro.exe"] as const;
const POSIX_EXE_NAMES = [
  "lceda-pro",
  "lceda-pro.exe",
  "easyeda-pro",
  "easyeda-pro.AppImage",
] as const;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitPath(value: string | undefined, delimiter: string): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function pushCandidate(list: ExeCandidate[], seen: Set<string>, candidate: ExeCandidate): void {
  const key = candidate.path.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  list.push(candidate);
}

/** macOS `.app` 包展开成包内可执行文件候选；不是 app 包时返回空数组。 */
function expandMacAppBundle(value: string): string[] {
  if (!value.toLowerCase().endsWith(".app")) return [];
  return [
    path.join(value, "Contents", "MacOS", "lceda-pro"),
    path.join(value, "Contents", "MacOS", "EasyEDA Pro"),
    path.join(value, "Contents", "MacOS", "EasyEDA"),
  ];
}

function windowsNativeCandidates(env: NodeJS.ProcessEnv): ExeCandidate[] {
  const list: ExeCandidate[] = [];
  const seen = new Set<string>();
  for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    if (base) {
      pushCandidate(list, seen, {
        path: path.win32.join(base, "lceda-pro", EXE_NAME),
        source: "Program Files",
      });
    }
  }
  if (env.LOCALAPPDATA) {
    pushCandidate(list, seen, {
      path: path.win32.join(env.LOCALAPPDATA, "Programs", "lceda-pro", EXE_NAME),
      source: "LOCALAPPDATA\\Programs",
    });
    pushCandidate(list, seen, {
      path: path.win32.join(env.LOCALAPPDATA, "lceda-pro", EXE_NAME),
      source: "LOCALAPPDATA",
    });
  }
  // 旧脚本的默认安装位置：盘符不固定，作为最后兜底候选。
  pushCandidate(list, seen, {
    path: "D:\\Program Files\\lceda-pro\\lceda-pro.exe",
    source: "历史默认路径",
  });
  for (const entry of splitPath(env.PATH ?? env.Path, ";")) {
    pushCandidate(list, seen, { path: path.win32.join(entry, EXE_NAME), source: "PATH" });
  }
  return list;
}

function wslHostCandidates(env: NodeJS.ProcessEnv): ExeCandidate[] {
  const list: ExeCandidate[] = [];
  const seen = new Set<string>();
  // PATH 在 WSL 里可能上百项，逐个 stat 走 drvfs 很慢：先按目录名过滤出线索项，
  // 再补固定盘符候选，最后才扫其余 PATH（截断，避免把启动时间耗在无关键上）。
  const entries = splitPath(env.PATH, ":");
  const hinted = entries.filter((entry) => /lceda|easyeda/i.test(entry));
  const hintedSet = new Set(hinted);
  const others = entries.filter((entry) => !hintedSet.has(entry)).slice(0, 24);
  for (const entry of [...hinted, ...others]) {
    for (const name of WSL_HOST_EXE_NAMES) {
      pushCandidate(list, seen, { path: path.posix.join(entry, name), source: "WSL PATH" });
    }
  }
  for (const drive of DRIVE_LETTERS) {
    for (const dir of PROGRAM_DIRS) {
      pushCandidate(list, seen, {
        path: `/mnt/${drive}/${dir}/lceda-pro/${EXE_NAME}`,
        source: `/mnt/${drive}/${dir}`,
      });
    }
  }
  return list;
}

function posixCandidates(
  env: NodeJS.ProcessEnv,
  home: string | undefined,
  options: { excludeWindowsMounts?: boolean } = {},
): ExeCandidate[] {
  const list: ExeCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of splitPath(env.PATH, ":")) {
    // /mnt/... 下的是 Windows 可执行文件（经互操作运行），属于「客户端在宿主」，
    // 不能算作 WSL 虚拟机内的 Linux 客户端。
    if (options.excludeWindowsMounts && /^\/mnt\//i.test(entry)) continue;
    for (const name of POSIX_EXE_NAMES) {
      pushCandidate(list, seen, { path: path.posix.join(entry, name), source: "PATH" });
    }
  }
  for (const fixed of [
    "/opt/lceda-pro/lceda-pro",
    "/opt/easyeda-pro/lceda-pro",
    "/usr/local/bin/lceda-pro",
    "/usr/bin/lceda-pro",
  ]) {
    pushCandidate(list, seen, { path: fixed, source: "常见安装目录" });
  }
  if (home) {
    for (const name of POSIX_EXE_NAMES) {
      pushCandidate(list, seen, {
        path: path.posix.join(home, ".local", "bin", name),
        source: "~/.local/bin",
      });
    }
  }
  return list;
}

function macosCandidates(env: NodeJS.ProcessEnv): ExeCandidate[] {
  const list: ExeCandidate[] = [];
  const seen = new Set<string>();
  for (const bundle of [
    "/Applications/lceda-pro.app",
    "/Applications/EasyEDA Pro.app",
    path.posix.join(env.HOME ?? "", "Applications", "lceda-pro.app"),
  ]) {
    for (const inner of expandMacAppBundle(bundle)) {
      pushCandidate(list, seen, { path: inner, source: "Applications" });
    }
  }
  for (const entry of splitPath(env.PATH, ":")) {
    for (const name of POSIX_EXE_NAMES) {
      pushCandidate(list, seen, { path: path.posix.join(entry, name), source: "PATH" });
    }
  }
  return list;
}

/**
 * 生成候选列表。纯函数：不碰文件系统，顺序即优先级。
 * `explicitPath` 不在这里（它单独处理，避免被候选顺序淹没）。
 */
export function clientExeCandidates(
  environment: EnvironmentInfo,
  env: NodeJS.ProcessEnv = process.env,
  location: ClientLocation = environment.clientLocations[0] ?? "host",
): ExeCandidate[] {
  const list: ExeCandidate[] = [];
  const seen = new Set<string>();
  const fromEnv = stripQuotes(env.LCEDA_PRO_EXE ?? "");
  if (fromEnv) {
    if (environment.kind === "wsl2" && isWindowsDrivePath(fromEnv)) {
      pushCandidate(list, seen, {
        path: windowsPathToWslPath(fromEnv),
        source: "env:LCEDA_PRO_EXE（Windows 路径已转 WSL）",
      });
    } else {
      pushCandidate(list, seen, { path: fromEnv, source: "env:LCEDA_PRO_EXE" });
    }
  }

  switch (environment.kind) {
    case "windows-native":
      return [...list, ...windowsNativeCandidates(env)];
    case "wsl2":
      return [
        ...list,
        ...(location === "vm"
          ? posixCandidates(env, env.HOME, { excludeWindowsMounts: true })
          : wslHostCandidates(env)),
      ];
    case "linux-native":
      return [...list, ...posixCandidates(env, env.HOME)];
    case "macos-native":
      return [...list, ...macosCandidates(env)];
    default:
      return list;
  }
}

/** 显式路径归一：Windows 路径在 WSL2 + host 下自动转换；macOS .app 包展开为内部可执行文件。 */
export function normalizeExplicitExe(
  value: string,
  environment: EnvironmentInfo,
  location: ClientLocation = environment.clientLocations[0] ?? "host",
): { candidates: string[]; hostPath: string | null } {
  const cleaned = stripQuotes(value);
  if (!cleaned) return { candidates: [], hostPath: null };
  let hostPath: string | null = null;
  const candidates: string[] = [];
  if (environment.kind === "wsl2" && location === "host" && isWindowsDrivePath(cleaned)) {
    candidates.push(windowsPathToWslPath(cleaned));
    hostPath = cleaned;
  } else if (environment.kind === "wsl2") {
    candidates.push(cleaned);
    hostPath = wslPathToWindowsPath(cleaned);
  } else {
    candidates.push(cleaned);
    if (environment.kind === "windows-native") hostPath = cleaned;
  }
  if (environment.kind === "macos-native") {
    for (const inner of expandMacAppBundle(cleaned)) candidates.push(inner);
  }
  return { candidates: [...new Set(candidates)], hostPath };
}

function defaultRunText(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): string | null {
  try {
    const result = spawnSync(command, [...args], {
      timeout: timeoutMs,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    return `${result.stdout ?? ""}`.trim() || null;
  } catch {
    return null;
  }
}

function deepProbeCandidates(
  environment: EnvironmentInfo,
  location: ClientLocation,
  runText: DiscoverExeOptions["runText"],
): ExeCandidate[] {
  const runner = runText ?? defaultRunText;
  const list: ExeCandidate[] = [];
  const seen = new Set<string>();
  if (environment.kind === "wsl2" && location === "host") {
    const output = runner("cmd.exe", ["/c", "where", "lceda-pro.exe"], 8_000);
    if (output) {
      for (const line of output.split(/\r?\n/)) {
        const value = line.trim();
        if (!value) continue;
        const translated = isWindowsDrivePath(value) ? windowsPathToWslPath(value) : value;
        pushCandidate(list, seen, { path: translated, source: "Windows where.exe" });
      }
    }
    return list;
  }
  if (environment.kind === "windows-native") {
    const output = runner("where.exe", ["lceda-pro.exe"], 5_000);
    if (output) {
      for (const line of output.split(/\r?\n/)) {
        const value = line.trim();
        if (value) pushCandidate(list, seen, { path: value, source: "where.exe" });
      }
    }
    return list;
  }
  if (
    environment.kind === "macos-native" ||
    environment.kind === "linux-native" ||
    (environment.kind === "wsl2" && location === "vm")
  ) {
    const output = runner("sh", ["-lc", "command -v lceda-pro || command -v easyeda-pro"], 5_000);
    if (output) {
      for (const line of output.split(/\r?\n/)) {
        const value = line.trim();
        if (value) pushCandidate(list, seen, { path: value, source: "command -v" });
      }
    }
  }
  return list;
}

/**
 * 发现客户端可执行文件。
 *
 * 显式路径优先且**不回退**：用户说了用哪个就必须用哪个，找不到要明确报错，
 * 不能悄悄换成自动发现的结果（否则排查时会以为显式参数生效了）。
 */
export function discoverClientExe(options: DiscoverExeOptions): ClientExeDiscovery {
  const { environment } = options;
  const env = options.env ?? process.env;
  const location = options.location ?? environment.clientLocations[0] ?? "host";
  const exists = options.exists ?? ((file: string) => fs.existsSync(file));
  const warnings: string[] = [];
  const candidates: ExeCandidateResult[] = [];

  if (options.explicitPath && options.explicitPath.trim()) {
    const explicit = normalizeExplicitExe(options.explicitPath, environment, location);
    for (const candidate of explicit.candidates) {
      const present = exists(candidate);
      candidates.push({ path: candidate, source: "显式指定", exists: present });
      if (present) {
        return {
          status: "explicit",
          path: candidate,
          hostPath: explicit.hostPath,
          source: "显式指定",
          location,
          candidates,
          warnings,
          environment: environment.kind,
        };
      }
    }
    warnings.push(`显式指定的客户端路径不存在：${options.explicitPath}`);
    return {
      status: "explicit_missing",
      path: null,
      hostPath: explicit.hostPath,
      source: "显式指定",
      location,
      candidates,
      warnings,
      environment: environment.kind,
    };
  }

  const list = clientExeCandidates(environment, env, location);
  for (const candidate of list) {
    const present = exists(candidate.path);
    candidates.push({ ...candidate, exists: present });
    if (present) {
      return {
        status: "discovered",
        path: candidate.path,
        hostPath: wslPathToWindowsPath(candidate.path) ?? candidate.path,
        source: candidate.source,
        location,
        candidates,
        warnings,
        environment: environment.kind,
      };
    }
  }

  if (options.deep) {
    for (const candidate of deepProbeCandidates(environment, location, options.runText)) {
      const present = exists(candidate.path);
      candidates.push({ ...candidate, exists: present });
      if (present) {
        return {
          status: "discovered",
          path: candidate.path,
          hostPath: wslPathToWindowsPath(candidate.path) ?? candidate.path,
          source: candidate.source,
          location,
          candidates,
          warnings,
          environment: environment.kind,
        };
      }
    }
  }

  if (environment.kind === "unknown") {
    warnings.push("环境未知：无法生成客户端候选路径，请用 --exe 显式指定");
  }
  return {
    status: "not_found",
    path: null,
    hostPath: null,
    source: "",
    location,
    candidates,
    warnings,
    environment: environment.kind,
  };
}

export interface ClientExePlan {
  /** 按 clientLocations 优先级排列，每项对应一个实例位置。 */
  locations: ClientExeDiscovery[];
  /** 第一个找到的可用路径（显式路径优先命中）。 */
  primary: ClientExeDiscovery | null;
  warnings: string[];
}

/**
 * 发现结果缓存：loadConfig 在 MCP 进程里会被多次调用（每个 server / 每次自检），
 * 而候选路径的 stat 在 WSL 的 /mnt 上并不便宜。文件系统探测结果按环境 + PATH 缓存；
 * 注入探针（测试）不缓存。
 */
const planCache = new Map<string, ClientExePlan>();

function planCacheKey(options: Omit<DiscoverExeOptions, "location">): string | null {
  if (options.exists || options.runText) return null;
  const env = options.env ?? process.env;
  return [
    options.environment.kind,
    options.environment.clientLocations.join(","),
    options.explicitPath ?? "",
    env.PATH ?? "",
    env.LCEDA_PRO_EXE ?? "",
    env.HOME ?? "",
    env.ProgramFiles ?? "",
    env["ProgramFiles(x86)"] ?? "",
    env.LOCALAPPDATA ?? "",
    options.deep ? "deep" : "",
  ].join("\u0000");
}

/**
 * 按客户端位置优先级依次发现。显式路径在所有位置下都会尝试，
 * 命中即返回该位置；显式路径全都不存在时，整体按 explicit_missing 处理，不回退。
 */
export function discoverClientExePlan(
  options: Omit<DiscoverExeOptions, "location">,
): ClientExePlan {
  const cacheKey = planCacheKey(options);
  if (cacheKey) {
    const hit = planCache.get(cacheKey);
    if (hit) return structuredClone(hit);
  }
  const warnings: string[] = [];
  const locations: ClientExeDiscovery[] = [];
  const targets = options.environment.clientLocations.length
    ? options.environment.clientLocations
    : (["host"] as ClientLocation[]);
  for (const location of targets) {
    const result = discoverClientExe({ ...options, location });
    locations.push(result);
    warnings.push(...result.warnings);
    if (result.status === "explicit" || result.status === "discovered") {
      return rememberPlan(cacheKey, { locations, primary: result, warnings });
    }
    // 显式路径没找到时不再继续自动发现，避免掩盖用户传错的路径。
    if (result.status === "explicit_missing") {
      return rememberPlan(cacheKey, { locations, primary: null, warnings });
    }
  }
  return rememberPlan(cacheKey, { locations, primary: null, warnings });
}

function rememberPlan(cacheKey: string | null, plan: ClientExePlan): ClientExePlan {
  if (cacheKey) planCache.set(cacheKey, structuredClone(plan));
  return plan;
}
