import fs from "node:fs";
import path from "node:path";

import { homeDir } from "../core/config.ts";
import { CdpError } from "./errors.ts";

/**
 * CDP 端点发现。
 *
 * 判定标准只有一条：`GET /json/version` 的返回体同时含 `Browser` 与 `Protocol-Version`。
 * 端口能连不等于 CDP。`DevToolsActivePort` 的第二行记着 `/devtools/browser/<uuid>`，
 * 与 `/json/version` 返回的 uuid 比对，才能把「当前实例」和「上次运行/别的 profile
 * 留下的过期文件」区分开——机器上有多份 profile 时，光看端口会认错主人。
 *
 * 来源：leonskill-easyeda-cdp-connect/scripts/lceda_cdp.py 的
 * `profile_roots / devtools_active_ports / looks_like_cdp / discover / resolve`。
 */

export const DEFAULT_CDP_HOST = "127.0.0.1";
export const DEFAULT_CDP_PORT = 9222;
export const DEFAULT_HTTP_TIMEOUT_MS = 2500;
/** profile 目录名前缀：立创EDA专业版与 EasyEDA。 */
export const PRODUCT_PREFIXES: readonly string[] = ["LCEDA", "EasyEDA"];

export interface CdpVersionInfo {
  Browser?: string;
  "Protocol-Version"?: string;
  "User-Agent"?: string;
  "V8-Version"?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

export interface DevToolsPortRecord {
  port: number;
  /** DevToolsActivePort 的绝对路径。 */
  file: string;
  /** 文件第二行记录的 browser uuid；缺失时为空串。 */
  uuid: string;
}

export type DiscoverSource = "DevToolsActivePort" | "cli" | "scan";

export interface DiscoverResult {
  port: number;
  source: DiscoverSource;
  /** 端口文件路径；cli / scan 候选为空串。 */
  profile: string;
  cdp: boolean;
  /** true=匹配；false=不匹配（过期文件）；null=没有记录可比。 */
  uuidMatch: boolean | null;
  /** /json/version 的原始返回（拿不到时为 null）。 */
  version: unknown;
}

export interface DiscoverOutput {
  /** 优先 uuid 匹配的候选；没有再退回「活但未记录 uuid」的候选。 */
  usable: DiscoverResult[];
  results: DiscoverResult[];
  livePorts: number[];
}

export interface DiscoverOptions {
  /** 用户指定端口（等价 `--port`），作为 `cli` 候选。 */
  port?: number;
  /** 额外扫描的端口区间（闭区间）。 */
  scan?: readonly [number, number];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** 直接给端口记录，跳过文件系统（测试用）。 */
  records?: readonly DevToolsPortRecord[];
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 允许连接的非回环地址（只放行当前环境推导出的宿主地址）。 */
  allowedHosts?: readonly string[];
}

// ─── 回环地址 ────────────────────────────────────────────────────────

/** 只允许本机回环地址：`127.*`（合法 IPv4 形式）、`localhost`、`::1`。 */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === "localhost" || value === "::1" || value === "[::1]") return true;
  return /^127(\.\d{1,3}){3}$/.test(value);
}

/** 非回环地址直接拒绝（源仓库的硬边界：不做端口转发、不连内网别的机器）。 */
export function requireLoopbackHost(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new CdpError("LOOPBACK_ONLY", `只允许回环地址，拒绝连接 ${host}`, { exitCode: 3 });
  }
}

/**
 * 允许回环地址，或显式列出的「当前环境的宿主地址」（WSL2 → Windows 宿主）。
 * 边界仍然是本机：列表只能由环境发现或用户显式配置产生，不接受任意远端主机。
 */
export function requireAllowedHost(host: string, allowedHosts: readonly string[] = []): void {
  if (isLoopbackHost(host)) return;
  const target = host.trim().toLowerCase();
  if (allowedHosts.some((allowed) => allowed.trim().toLowerCase() === target)) return;
  throw new CdpError("LOOPBACK_ONLY", `只允许回环地址或当前环境的宿主地址，拒绝连接 ${host}`, {
    exitCode: 3,
  });
}

// ─── profile 与端口文件 ──────────────────────────────────────────────

/**
 * 候选 profile 根目录：Windows 扫 %LOCALAPPDATA% 下以 LCEDA / EasyEDA 开头的目录；
 * 其他平台对应 `~/.config`。返回排序后的绝对路径。
 */
export function profileRoots(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const bases =
    platform === "win32"
      ? env.LOCALAPPDATA
        ? [env.LOCALAPPDATA]
        : []
      : [path.join(homeDir(env), ".config")];

  const roots: string[] = [];
  for (const base of bases) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    const matched = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          PRODUCT_PREFIXES.some((prefix) =>
            entry.name.toLowerCase().startsWith(prefix.toLowerCase()),
          ),
      )
      .map((entry) => path.join(base, entry.name))
      .sort();
    roots.push(...matched);
  }
  return roots;
}

/** 取 `/devtools/browser/<uuid>` 或 `ws://host:port/devtools/browser/<uuid>` 的最后一段。 */
export function browserUuidFromLine(line: string): string {
  const value = line.trim().replace(/\/+$/, "");
  if (!value) return "";
  return value.split("/").pop() ?? "";
}

/** `browserUuidFromLine` 的别名：commands/cdp.ts 解析 DevToolsActivePort 第 2 行时用。 */
export function parseBrowserUuidLine(line: string): string {
  return browserUuidFromLine(line);
}

/** 解析 DevToolsActivePort 文本：第 1 行端口，第 2 行 browser uuid。 */
export function parseDevToolsActivePortText(text: string): { port: number; uuid: string } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const portLine = (lines[0] ?? "").trim();
  const port = /^[+-]?\d+$/.test(portLine) ? Number.parseInt(portLine, 10) : 0;
  return { port, uuid: browserUuidFromLine(lines[1] ?? "") };
}

/** 读每个 profile 根目录下 cache.* 子目录里的 DevToolsActivePort，保留记录的 uuid。 */
export function readDevToolsActivePorts(roots: readonly string[]): DevToolsPortRecord[] {
  const records: DevToolsPortRecord[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const caches = entries
      .filter((entry) => entry.isDirectory() && /^cache\./i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const name of caches) {
      const file = path.join(root, name, "DevToolsActivePort");
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const parsed = parseDevToolsActivePortText(text);
      if (parsed.port <= 0) continue;
      records.push({ port: parsed.port, file, uuid: parsed.uuid });
    }
  }
  return records;
}

/** profile 路径的人类可读标签，如 `LCEDA Pro/cache.x64.3`。 */
export function profileLabel(file: string): string {
  if (!file) return "";
  const dir = path.dirname(file);
  const parent = path.basename(path.dirname(dir));
  const name = path.basename(dir);
  if (!name) return path.basename(file);
  return parent ? `${parent}/${name}` : name;
}

// ─── HTTP 探测 ──────────────────────────────────────────────────────

function httpUrl(host: string, port: number, route: string): string {
  const normalized = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${normalized}:${port}${route}`;
}

/** 拉本地 CDP 的 JSON 路由；连不上 / 不是 JSON 一律返回 null。 */
export async function fetchJson<T = unknown>(
  host: string,
  port: number,
  route: string,
  timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T | null> {
  if (port <= 0) return null;
  try {
    const response = await fetch(httpUrl(host, port, route), {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    if (signal?.aborted) throw new CdpError("CANCELLED", "CDP 探测已取消");
    return null;
  }
}

/** 判定标准：`Browser` 非空字符串，且 `Protocol-Version` 存在。 */
export function looksLikeCdp(payload: unknown): payload is CdpVersionInfo {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return (
    typeof record.Browser === "string" &&
    record.Browser !== "" &&
    typeof record["Protocol-Version"] === "string"
  );
}

export function versionBrowser(version: unknown): string {
  if (version === null || typeof version !== "object" || Array.isArray(version)) return "";
  const value = (version as Record<string, unknown>).Browser;
  return typeof value === "string" ? value : "";
}

export function versionWebSocketUrl(version: unknown): string {
  if (version === null || typeof version !== "object" || Array.isArray(version)) return "";
  const value = (version as Record<string, unknown>).webSocketDebuggerUrl;
  return typeof value === "string" ? value : "";
}

/** 从 `/json/version` 的 webSocketDebuggerUrl 里取 browser uuid。 */
export function browserUuid(version: unknown): string {
  return browserUuidFromLine(versionWebSocketUrl(version));
}

export function endpointUrl(host: string, port: number): string {
  return httpUrl(host, port, "");
}

/** 归属说明文案（CLI 与 MCP 共用）。 */
export function attributionOf(item: Pick<DiscoverResult, "uuidMatch">): string {
  if (item.uuidMatch === true) return "uuid=匹配";
  if (item.uuidMatch === false) return "uuid=不匹配（该 profile 的端口文件是上次运行留下的）";
  return "uuid=未记录";
}

// ─── 发现主流程 ──────────────────────────────────────────────────────

interface Candidate {
  port: number;
  source: DiscoverSource;
  profile: string;
  uuid: string;
}

/**
 * 枚举候选端口并逐个验证 `/json/version`。
 *
 * `usable` 优先 uuid 匹配的条目：几份 profile 文件可能写着同一端口，只有 uuid 对得上
 * 的那份才是当前实例；没有匹配项时才退回「活但未记录 uuid」的候选（cli / scan）。
 */
export async function discover(
  host: string = DEFAULT_CDP_HOST,
  options: DiscoverOptions = {},
): Promise<DiscoverOutput> {
  requireAllowedHost(host, options.allowedHosts);

  const records =
    options.records ??
    readDevToolsActivePorts(
      profileRoots(options.env ?? process.env, options.platform ?? process.platform),
    );

  const candidates: Candidate[] = records.map((record) => ({
    port: record.port,
    source: "DevToolsActivePort",
    profile: record.file,
    uuid: record.uuid,
  }));

  if (options.port !== undefined && options.port > 0) {
    candidates.push({ port: options.port, source: "cli", profile: "", uuid: "" });
  }

  if (options.scan) {
    const low = Math.max(1, Math.trunc(options.scan[0]));
    const high = Math.min(65535, Math.trunc(options.scan[1]));
    for (let port = low; port <= high; port += 1) {
      candidates.push({ port, source: "scan", profile: "", uuid: "" });
    }
  }

  const probes = new Map<number, unknown>();
  const results: DiscoverResult[] = [];
  for (const candidate of candidates) {
    if (!probes.has(candidate.port)) {
      const payload = await fetchJson(
        host,
        candidate.port,
        "/json/version",
        options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
        options.signal,
      );
      probes.set(candidate.port, payload);
    }
    const version = probes.get(candidate.port) ?? null;
    const live = looksLikeCdp(version);
    const liveUuid = live ? browserUuid(version) : "";
    let uuidMatch: boolean | null;
    if (!candidate.uuid) uuidMatch = null;
    else uuidMatch = live ? candidate.uuid === liveUuid : false;

    results.push({
      port: candidate.port,
      source: candidate.source,
      profile: candidate.profile,
      cdp: live,
      uuidMatch,
      version,
    });
  }

  const authentic = results.filter((item) => item.cdp && item.uuidMatch === true);
  const unattributed = results.filter((item) => item.cdp && item.uuidMatch !== true);
  const livePorts = [...new Set(results.filter((item) => item.cdp).map((item) => item.port))].sort(
    (left, right) => left - right,
  );
  return {
    usable: authentic.length > 0 ? authentic : unattributed,
    results,
    livePorts,
  };
}

/** 只取最佳端点；没有可用端点返回 null。 */
export async function resolveEndpoint(
  host: string = DEFAULT_CDP_HOST,
  options: DiscoverOptions = {},
): Promise<DiscoverResult | null> {
  const { usable } = await discover(host, options);
  return usable[0] ?? null;
}

/** 从环境变量读取默认端口；没配置时返回 undefined（不要凭空多出一个候选）。 */
export function defaultPortFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.LCEDA_CDP_PORT;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 解析 `LOW-HIGH` 形式的端口区间；格式不对返回 null。 */
export function parsePortRange(text: string): readonly [number, number] | null {
  const match = /^(\d{1,5})\s*-\s*(\d{1,5})$/.exec(text.trim());
  if (!match) return null;
  const low = Number.parseInt(match[1] ?? "", 10);
  const high = Number.parseInt(match[2] ?? "", 10);
  if (low <= 0 || low > 65535 || high < low || high > 65535) return null;
  return [low, high];
}
