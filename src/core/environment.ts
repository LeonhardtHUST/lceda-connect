import fs from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * 执行环境自动发现。
 *
 * 本工具的在线能力（CDP / bridge）依赖「客户端在哪个操作系统、哪个网络命名空间里」：
 *   - Windows 原生：客户端与 MCP 共享回环，127.0.0.1 直连。
 *   - WSL2 NAT（默认）：MCP 在 Linux 虚拟机里，Windows 的回环与它不互通；只有
 *     宿主地址（默认网关）上的监听才可能可达。
 *   - WSL2 mirrored：共享宿主网络命名空间，回环重新可用。
 * 因此先判环境，再决定探测哪些地址、能否启动客户端、失败时该给什么建议。
 *
 * 判定只读：读 /proc、读环境变量、跑一次 `wslinfo --networking-mode`（WSL 自带，
 * 不存在时跳过）。不启动、不修改任何东西。所有外部探测都可注入，便于测试。
 */

export type EnvironmentKind =
  | "windows-native"
  | "wsl2"
  | "linux-native"
  | "macos-native"
  | "unknown";

/** 客户端（嘉立创EDA专业版）所在的操作系统。 */
export type HostOs = "windows" | "linux" | "macos" | "unknown";
export type NetworkingMode = "nat" | "mirrored" | "unknown";

/**
 * 客户端实例相对 MCP 进程的宿主位置。只对 WSL2 有意义：
 *   - host：客户端跑在 Windows 宿主机上（WSL2 默认）
 *   - vm：客户端跑在 WSL2 这个 Linux 虚拟机里
 * `--lceda-in vm,host` 的顺序就是启动/探测优先级。
 */
export type ClientLocation = "host" | "vm";
export type ClientLocationSource = "default" | "argv" | "config-file" | "env";
/** 当前 Node 进程寻址文件的方式；WSL2 是 posix（/mnt/c/...），宿主是 Windows。 */
export type PathStyle = "windows" | "posix";
export type EnvironmentKindSource = "argv" | "config-file" | "env" | "auto-detected";
export type Confidence = "certain" | "likely" | "unknown";

export interface EnvironmentEvidence {
  source: string;
  value: string;
}

export interface EnvironmentInfo {
  kind: EnvironmentKind;
  hostOs: HostOs;
  platform: NodeJS.Platform;
  pathStyle: PathStyle;
  isWsl: boolean;
  /** WSL 发行版名（WSL_DISTRO_NAME），非 WSL 时为 null。 */
  distro: string | null;
  networkingMode: NetworkingMode;
  /** WSL2 下 Windows 宿主的可达地址；原生环境为 null。 */
  windowsHost: string | null;
  /** 客户端实例位置，按优先级排序；原生环境固定为 ["host"]。 */
  clientLocations: ClientLocation[];
  clientLocationSource: ClientLocationSource;
  /** true 表示用户显式指定了环境，没有做自动发现。 */
  explicit: boolean;
  source: EnvironmentKindSource;
  confidence: Confidence;
  evidence: EnvironmentEvidence[];
  warnings: string[];
}

/** 环境判定可注入的探针；默认实现读 /proc 并调用 wslinfo。 */
export interface EnvironmentProbes {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readText?: (file: string) => string | null;
  exists?: (file: string) => boolean;
  runText?: (command: string, args: readonly string[], timeoutMs: number) => string | null;
}

export interface DetectEnvironmentOptions {
  /** 显式环境：`--env` / 配置文件 environment.kind / LCEDA_ENV。 */
  kind?: string | null;
  /** 显式宿主地址：`--windows-host` / 配置文件 / LCEDA_WINDOWS_HOST。 */
  windowsHost?: string | null;
  /** 显式环境来自哪里；默认 argv。 */
  kindSource?: EnvironmentKindSource;
  /** 宿主地址是否也是显式给出的（用于证据与警告）。 */
  windowsHostSource?: EnvironmentKindSource;
  /**
   * 客户端实例位置优先级：`vm` / `host` / `vm,host`。
   * 省略时 WSL2 默认 host，其它环境固定 host。
   */
  clientLocations?: string | readonly string[] | null;
  clientLocationSource?: ClientLocationSource;
  probes?: EnvironmentProbes;
  /** 是否复用自动发现的缓存（默认 true；注入探针或测试时请设 false）。 */
  cache?: boolean;
}

const KIND_ALIASES: Readonly<Record<string, EnvironmentKind>> = {
  auto: "unknown",
  "": "unknown",
  win: "windows-native",
  win32: "windows-native",
  windows: "windows-native",
  "windows-native": "windows-native",
  "native-windows": "windows-native",
  wsl: "wsl2",
  wsl2: "wsl2",
  "wsl-2": "wsl2",
  "wsl2-native": "wsl2",
  linux: "linux-native",
  "linux-native": "linux-native",
  mac: "macos-native",
  macos: "macos-native",
  darwin: "macos-native",
  "macos-native": "macos-native",
};

/** 把用户输入归一成环境枚举；不认识时返回 null（调用方负责报错）。 */
export function normalizeEnvironmentKind(raw: string | null | undefined): EnvironmentKind | null {
  if (raw === null || raw === undefined) return null;
  const key = raw.trim().toLowerCase();
  if (key === "auto") return null;
  return KIND_ALIASES[key] ?? null;
}

/** 可选值列表，用于帮助文本与错误提示。 */
export const ENVIRONMENT_KIND_VALUES: readonly string[] = [
  "auto",
  "windows-native",
  "wsl2",
  "linux-native",
  "macos-native",
];

export function parseNetworkingMode(raw: string | null | undefined): NetworkingMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "nat") return "nat";
  if (value === "mirrored") return "mirrored";
  return "unknown";
}

export const CLIENT_LOCATION_VALUES: readonly string[] = ["host", "vm"];

/**
 * 解析客户端实例位置优先级。接受 `"vm,host"`、`"host"`、`["vm","host"]`。
 * 未知词与重复项会被丢弃（未知词记警告由调用方处理）。
 */
export function parseClientLocations(raw: string | readonly string[] | null | undefined): {
  locations: ClientLocation[];
  unknown: string[];
} {
  if (raw === null || raw === undefined) return { locations: [], unknown: [] };
  const items = (typeof raw === "string" ? raw.split(",") : [...raw])
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  const locations: ClientLocation[] = [];
  const unknown: string[] = [];
  for (const item of items) {
    if (item !== "host" && item !== "vm") {
      unknown.push(item);
      continue;
    }
    if (!locations.includes(item)) locations.push(item);
  }
  return { locations, unknown };
}

export function hostOsOf(kind: EnvironmentKind): HostOs {
  switch (kind) {
    case "windows-native":
    case "wsl2":
      return "windows";
    case "linux-native":
      return "linux";
    case "macos-native":
      return "macos";
    default:
      return "unknown";
  }
}

export function pathStyleOf(platform: NodeJS.Platform): PathStyle {
  return platform === "win32" ? "windows" : "posix";
}

/** 是否是回环地址（与 cdp/discover 的判定保持一致，避免 core 反向依赖 cdp）。 */
export function isLoopbackAddress(host: string): boolean {
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || /^127(\.\d{1,3}){3}$/.test(value);
}

export function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

export function isUncPath(value: string): boolean {
  return /^\\\\[^\\]+\\/.test(value);
}

/**
 * Windows 路径 → WSL 挂载路径（`D:\Program Files\x` → `/mnt/d/Program Files/x`）。
 * 已经是 POSIX 路径时原样返回。不做 `wslpath` 调用：规则固定且可测。
 */
export function windowsPathToWslPath(value: string, mountRoot = "/mnt"): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (isWindowsDrivePath(trimmed)) {
    const drive = trimmed[0]?.toLowerCase() ?? "";
    const rest = trimmed.slice(2).replace(/\\/g, "/").replace(/^\/+/, "");
    return `${mountRoot}/${drive}/${rest}`.replace(/\/{2,}/g, "/");
  }
  if (isUncPath(trimmed)) {
    return `//${trimmed.slice(2).replace(/\\/g, "/")}`;
  }
  return trimmed;
}

/** WSL 挂载路径 → Windows 路径（`/mnt/d/x` → `D:\x`）；不是挂载路径时返回 null。 */
export function wslPathToWindowsPath(value: string, mountRoot = "/mnt"): string | null {
  const trimmed = value.trim();
  const prefix = mountRoot.replace(/\/+$/, "");
  if (!trimmed.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) return null;
  const rest = trimmed.slice(prefix.length + 1);
  const drive = rest.slice(0, 1);
  if (!/^[A-Za-z]$/.test(drive)) return null;
  const tail = rest.slice(1).replace(/^\/+/, "").replace(/\//g, "\\");
  return `${drive.toUpperCase()}:\\${tail}`;
}

/**
 * 解析 `/proc/net/route` 的默认网关。该文件的地址是主机字节序的 8 位十六进制，
 * 需要按小端还原（`01E012AC` → `172.18.224.1`）。找不到默认路由时返回 null。
 */
export function parseRouteGateway(table: string): string | null {
  for (const line of table.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 3) continue;
    const destination = columns[1] ?? "";
    if (destination.toLowerCase() !== "00000000") continue;
    const hex = (columns[2] ?? "").padStart(8, "0");
    if (!/^[0-9a-f]{8}$/i.test(hex)) continue;
    const bytes = [6, 4, 2, 0].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
    if (bytes.every((byte) => byte === 0)) continue;
    return bytes.join(".");
  }
  return null;
}

/** 取 `/etc/resolv.conf` 的第一个 nameserver（老版本 WSL2 用它指代宿主）。 */
export function parseResolvNameserver(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*nameserver\s+(\S+)\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

const IS_WSL_OSRELEASE = /microsoft|wsl/i;

/** 合并注入探针与默认实现。默认实现刻意保持同步、只读。 */
function resolveProbes(probes: EnvironmentProbes = {}): Required<EnvironmentProbes> {
  return {
    platform: probes.platform ?? process.platform,
    env: probes.env ?? process.env,
    readText:
      probes.readText ??
      ((file) => {
        try {
          return fs.readFileSync(file, "utf8");
        } catch {
          return null;
        }
      }),
    exists:
      probes.exists ??
      ((file) => {
        try {
          return fs.existsSync(file);
        } catch {
          return false;
        }
      }),
    runText:
      probes.runText ??
      ((command, args, timeoutMs) => {
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
      }),
  };
}

function validateHost(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  if (/^[A-Za-z0-9._:-]+$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * 探测当前执行环境。显式给了 kind 时不再做自动发现（只保留证据与警告），
 * 这正是 `--env` 的语义。
 */
const detectionCache = new Map<string, EnvironmentInfo>();

export function detectEnvironment(options: DetectEnvironmentOptions = {}): EnvironmentInfo {
  const cacheable = options.probes === undefined && options.cache !== false;
  const cacheKey = [
    process.platform,
    options.kind ?? "",
    options.windowsHost ?? "",
    options.kindSource ?? "",
    options.windowsHostSource ?? "",
    options.clientLocationSource ?? "",
    typeof options.clientLocations === "string"
      ? options.clientLocations
      : (options.clientLocations ?? []).join(","),
    process.env.WSL_DISTRO_NAME ?? "",
  ].join("|");
  if (cacheable) {
    const hit = detectionCache.get(cacheKey);
    if (hit) return structuredClone(hit);
  }
  const probes = resolveProbes(options.probes);
  const env = probes.env;
  const platform = probes.platform;
  const evidence: EnvironmentEvidence[] = [];
  const warnings: string[] = [];

  const explicitKind = options.kind ? normalizeEnvironmentKind(options.kind) : null;
  if (options.kind && !explicitKind) {
    warnings.push(`无法识别的环境名 "${options.kind}"，已退回自动发现`);
  }

  const osRelease = probes.readText("/proc/sys/kernel/osrelease") ?? "";
  const procVersion = probes.readText("/proc/version") ?? "";
  const wslEnvMarkers = ["WSL_INTEROP", "WSL_DISTRO_NAME"].filter(
    (name) => (env[name] ?? "").trim() !== "",
  );
  const isWsl =
    platform === "linux" &&
    (IS_WSL_OSRELEASE.test(osRelease) ||
      IS_WSL_OSRELEASE.test(procVersion) ||
      wslEnvMarkers.length > 0);

  if (platform === "linux") {
    if (osRelease.trim()) evidence.push({ source: "proc:osrelease", value: osRelease.trim() });
    if (wslEnvMarkers.length > 0) {
      evidence.push({ source: "env", value: `WSL markers: ${wslEnvMarkers.join(", ")}` });
    }
    if (!isWsl) evidence.push({ source: "proc:osrelease", value: "未命中 WSL 标识" });
  } else {
    evidence.push({ source: "platform", value: platform });
  }

  let kind: EnvironmentKind;
  let source: EnvironmentKindSource;
  if (explicitKind) {
    kind = explicitKind;
    source = options.kindSource ?? "argv";
    evidence.unshift({ source: `explicit:${source}`, value: explicitKind });
    if (
      (explicitKind === "windows-native" && platform !== "win32") ||
      (explicitKind === "macos-native" && platform !== "darwin") ||
      (explicitKind === "linux-native" && platform === "win32") ||
      (explicitKind === "wsl2" && platform !== "linux")
    ) {
      warnings.push(
        `显式指定环境 ${explicitKind} 与当前平台 ${platform} 不一致；按显式值执行，自动策略可能失效`,
      );
    }
  } else if (platform === "win32") {
    kind = "windows-native";
    source = "auto-detected";
  } else if (platform === "darwin") {
    kind = "macos-native";
    source = "auto-detected";
  } else if (platform === "linux") {
    kind = isWsl ? "wsl2" : "linux-native";
    source = "auto-detected";
  } else {
    kind = "unknown";
    source = "auto-detected";
    warnings.push(`未识别的平台 ${platform}；在线工具按默认回环策略尝试`);
  }

  const distro = isWsl ? (env.WSL_DISTRO_NAME ?? "").trim() || null : null;
  let networkingMode: NetworkingMode = "unknown";
  if (kind === "wsl2") {
    const reported = probes.runText("wslinfo", ["--networking-mode"], 2_000);
    networkingMode = parseNetworkingMode(reported);
    if (networkingMode === "unknown") {
      // 老版本 WSL 没有 wslinfo：NAT 是默认行为，但只能作为提示而不是判决。
      warnings.push("无法确认 WSL 网络模式（wslinfo 不可用）；按 NAT 的保守策略探测");
    } else {
      evidence.push({ source: "wslinfo", value: `networking-mode=${networkingMode}` });
    }
  }

  const explicitHost = validateHost(options.windowsHost);
  if (options.windowsHost && !explicitHost) {
    warnings.push(`--windows-host 值 "${options.windowsHost}" 不像合法地址，已忽略`);
  }
  let windowsHost: string | null = null;
  if (kind === "wsl2" && !isWsl && !explicitHost) {
    warnings.push(
      "显式指定 wsl2，但当前进程没有 WSL 特征；跳过宿主地址推导（可用 --windows-host 显式给出）",
    );
  }
  if (kind === "wsl2" && (isWsl || explicitHost)) {
    if (explicitHost) {
      windowsHost = explicitHost;
      evidence.push({
        source: `explicit:${options.windowsHostSource ?? "argv"}`,
        value: `windowsHost=${explicitHost}`,
      });
    } else if (networkingMode === "mirrored") {
      windowsHost = "127.0.0.1";
      evidence.push({ source: "wsl-networking", value: "mirrored 共享宿主回环" });
    } else {
      const gateway = parseRouteGateway(probes.readText("/proc/net/route") ?? "");
      if (gateway) {
        windowsHost = gateway;
        evidence.push({ source: "proc:route", value: `default gateway ${gateway}` });
      } else {
        const nameserver = parseResolvNameserver(probes.readText("/etc/resolv.conf") ?? "");
        if (nameserver) {
          windowsHost = nameserver;
          warnings.push(`宿主地址由 /etc/resolv.conf 推断（${nameserver}），可能不是宿主地址`);
          evidence.push({ source: "resolv.conf", value: `nameserver ${nameserver}` });
        }
      }
    }
  }

  if (kind === "wsl2" && networkingMode === "nat") {
    warnings.push(
      "WSL2 NAT：Windows 回环服务默认不可达；在线工具需在 Windows 侧运行 MCP，或启用 mirrored 网络/端口转发",
    );
  }
  if (kind !== "wsl2" && options.windowsHost) {
    warnings.push("--windows-host 只在 WSL2 下生效；当前环境已忽略");
  }

  // ── 客户端实例位置（vm / host，带优先级）───────────────────────────
  const requestedLocations = parseClientLocations(options.clientLocations);
  const locationUnknown = requestedLocations.unknown;
  let clientLocations = requestedLocations.locations;
  let clientLocationSource: ClientLocationSource = options.clientLocationSource ?? "argv";
  if (locationUnknown.length > 0) {
    warnings.push(`忽略无法识别的客户端位置：${locationUnknown.join(", ")}（只接受 host / vm）`);
  }
  if (clientLocations.length === 0) {
    clientLocations = ["host"];
    clientLocationSource = "default";
  }
  if (kind !== "wsl2" && clientLocations.includes("vm")) {
    warnings.push(`环境 ${kind} 下没有 WSL VM，客户端位置 vm 已忽略`);
    clientLocations = clientLocations.filter((item) => item !== "vm");
    if (clientLocations.length === 0) clientLocations = ["host"];
  }
  evidence.push({
    source: `client-locations:${clientLocationSource}`,
    value: clientLocations.join(","),
  });

  const confidence: Confidence = explicitKind || kind !== "unknown" ? "certain" : "unknown";

  const result: EnvironmentInfo = {
    kind,
    hostOs: hostOsOf(kind),
    platform,
    pathStyle: pathStyleOf(platform),
    isWsl,
    distro,
    networkingMode,
    windowsHost,
    clientLocations,
    clientLocationSource,
    explicit: Boolean(explicitKind),
    source,
    confidence,
    evidence,
    warnings,
  };
  if (cacheable) detectionCache.set(cacheKey, structuredClone(result));
  return result;
}

/** 把环境信息压成一行，给 CLI 与日志用（不要在这里做网络判断）。 */
export function describeEnvironment(info: EnvironmentInfo): string {
  const parts: string[] = [info.kind];
  if (info.distro) parts.push(info.distro);
  if (info.networkingMode !== "unknown") parts.push(`net=${info.networkingMode}`);
  if (info.windowsHost) parts.push(`windowsHost=${info.windowsHost}`);
  if (info.kind === "wsl2") parts.push(`lceda=${info.clientLocations.join(",")}`);
  return parts.join(" · ");
}

/**
 * 在线通道（CDP）探测地址，按客户端位置优先级展开：
 *   - vm：客户端在 WSL 虚拟机内，回环直连；
 *   - host：客户端在 Windows 宿主，NAT 下只能先试宿主地址，mirrored 下回环可用。
 */
/**
 * 显式探测地址被边界拒绝时给一句可操作警告。
 * 返回 null 表示没给、合法、或本来就在允许范围（回环 / 当前环境宿主地址）。
 */
export function hostOverrideWarning(
  info: EnvironmentInfo,
  explicitHost: string | null | undefined,
  label: string,
): string | null {
  if (explicitHost === null || explicitHost === undefined || explicitHost.trim() === "")
    return null;
  const explicit = validateHost(explicitHost);
  if (!explicit) return `${label} "${explicitHost}" 不是合法地址，已忽略`;
  if (isLoopbackAddress(explicit) || explicit === info.windowsHost) return null;
  return `${label} ${explicit} 不在允许范围（只接受回环或当前环境宿主地址 ${info.windowsHost ?? "（无）"}），已忽略`;
}

export function cdpProbeHosts(info: EnvironmentInfo, explicitHost?: string | null): string[] {
  const explicit = validateHost(explicitHost);
  // 显式地址也不能突破边界：只接受回环，或当前环境推导出的宿主地址。
  if (explicit && (isLoopbackAddress(explicit) || explicit === info.windowsHost)) {
    return [explicit];
  }
  const hosts: string[] = [];
  for (const location of info.clientLocations) {
    if (location === "vm") {
      hosts.push("127.0.0.1");
      continue;
    }
    if (info.kind === "wsl2" && info.networkingMode !== "mirrored" && info.windowsHost) {
      hosts.push(info.windowsHost);
    }
    hosts.push("127.0.0.1");
  }
  const deduped = [...new Set(hosts)];
  return deduped.length > 0 ? deduped : ["127.0.0.1"];
}

/**
 * bridge 只监听回环，不能跨命名空间转发；所以探测地址永远是回环。
 * 能否真正可达由 liveStrategy 的 per-location 结论说明。
 */
export function bridgeProbeHost(info: EnvironmentInfo, explicitHost?: string | null): string {
  const explicit = validateHost(explicitHost);
  if (explicit && (isLoopbackAddress(explicit) || explicit === info.windowsHost)) return explicit;
  void info;
  return "127.0.0.1";
}

export interface LocationStrategy {
  location: ClientLocation;
  /** 该位置下按顺序尝试的 CDP 地址。 */
  cdpHosts: string[];
  bridgeHost: string;
  /** 该位置下 bridge 是否可能可达（跨命名空间时 false）。 */
  bridgeReachable: boolean;
  /** 该位置期望的客户端可执行文件形态。 */
  exeStyle: "windows" | "linux" | "native";
  summary: string;
}

export interface LiveStrategy {
  /** 至少一个位置能直连回环通道。 */
  loopbackReachable: boolean;
  /** 按客户端位置优先级排列的策略。 */
  locations: LocationStrategy[];
  cdpHosts: string[];
  bridgeHost: string;
  summary: string;
  nextAction: string;
}

function locationStrategy(info: EnvironmentInfo, location: ClientLocation): LocationStrategy {
  const isWsl = info.kind === "wsl2";
  const hostCdpHosts: string[] =
    isWsl && info.networkingMode !== "mirrored" && info.windowsHost
      ? [info.windowsHost, "127.0.0.1"]
      : ["127.0.0.1"];
  const hostBridgeReachable = !isWsl || info.networkingMode === "mirrored";
  if (location === "vm") {
    return {
      location,
      cdpHosts: ["127.0.0.1"],
      bridgeHost: "127.0.0.1",
      bridgeReachable: true,
      exeStyle: "linux",
      summary: "客户端在 WSL 虚拟机内：与 MCP 共享回环，CDP 与 bridge 都按本机处理",
    };
  }
  return {
    location,
    cdpHosts: hostCdpHosts,
    bridgeHost: "127.0.0.1",
    bridgeReachable: hostBridgeReachable,
    exeStyle: info.hostOs === "windows" ? "windows" : "native",
    summary: isWsl
      ? `客户端在 Windows 宿主：CDP 探测 ${hostCdpHosts.join(" → ")}；${
          hostBridgeReachable ? "mirrored 下回环可用" : "bridge 跨 OS 不可达"
        }`
      : "客户端与 MCP 同 OS：CDP 与 bridge 均走 127.0.0.1",
  };
}

export function liveStrategy(
  info: EnvironmentInfo,
  options: { cdpHost?: string | null; bridgeHost?: string | null } = {},
): LiveStrategy {
  const locations = info.clientLocations.map((location) => locationStrategy(info, location));
  const cdpHosts = cdpProbeHosts(info, options.cdpHost);
  const bridgeHost = bridgeProbeHost(info, options.bridgeHost);
  const loopbackReachable =
    info.kind !== "wsl2" ||
    info.networkingMode === "mirrored" ||
    info.clientLocations.includes("vm");

  if (info.kind === "wsl2" && !loopbackReachable) {
    return {
      loopbackReachable,
      locations,
      cdpHosts,
      bridgeHost,
      summary:
        "WSL2 NAT + 客户端在 Windows 宿主：回环与 Windows 不互通，CDP 只可能经宿主地址访问；bridge 不可达",
      nextAction:
        "推荐在 Windows 侧运行 MCP（npm i -g lceda-connect 后让 MCP 客户端指向 Windows 命令）；或启用 WSL mirrored 网络；或把客户端装进 WSL VM 后以 --lceda-in vm 重试",
    };
  }
  if (info.kind === "wsl2") {
    return {
      loopbackReachable,
      locations,
      cdpHosts,
      bridgeHost,
      summary:
        info.networkingMode === "mirrored"
          ? "WSL2 mirrored：与宿主共享回环，CDP 与 bridge 都按本机处理"
          : "WSL2：客户端在 VM 内，回环直连",
      nextAction:
        "直接按回环通道使用；客户端可执行文件仍要按位置（host→/mnt/...，vm→Linux 路径）选择",
    };
  }
  return {
    loopbackReachable,
    locations,
    cdpHosts,
    bridgeHost,
    summary: "客户端与 MCP 同 OS：CDP 与 bridge 均走 127.0.0.1",
    nextAction: "先启动客户端并开调试端口 / 加载 bridge 扩展",
  };
}
