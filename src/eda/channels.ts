import {
  BridgeClientError,
  discover as discoverBridge,
  type BridgeEndpoint,
} from "../bridge/client.ts";
import { BRIDGE_LISTEN_HOST, BRIDGE_PORT_END, BRIDGE_PORT_START } from "../bridge/protocol.ts";
import {
  DEFAULT_CDP_HOST,
  DEFAULT_CDP_PORT,
  browserUuid,
  defaultPortFromEnv,
  discover as discoverCdp,
  versionBrowser,
  type DiscoverOutput,
} from "../cdp/discover.ts";
import {
  cdpProbeHosts,
  describeEnvironment,
  liveStrategy,
  type EnvironmentInfo,
  type LiveStrategy,
} from "../core/environment.ts";
import type { ClientExeDiscovery } from "../core/exeDiscovery.ts";

/**
 * 双通道环境自检（源仓库 `scripts/check_environment.py`）。
 *
 * 只读：不安装、不登录、不改配置、不启动进程。输出四态 `channel_state`：
 * both / bridge-only / cdp-only / none，另有逐项 `checks[]`（含 reason_code 与 hint）
 * 和一句 `next_action`。退出码沿用源口径：0 双通道 / 1 单通道 / 2 都不可用。
 *
 * 环境自适应：探测地址由 `EnvironmentInfo` 推导，而不是写死回环。WSL2 NAT 下
 * bridge 与客户端不在同一网络命名空间，会明确报 `cross_os_loopback` 并给出
 * 「在 Windows 侧运行 MCP / 启用 mirrored / 客户端装进 VM」的下一步。
 */

export type ChannelState = "both" | "bridge-only" | "cdp-only" | "none";
export type EnvironmentStatus = "ready" | "partial" | "needs_setup";
export type CheckStatus = "ready" | "partial" | "missing" | "unavailable";

export interface ChannelCheck {
  id: string;
  status: CheckStatus;
  /** 机器可判的失败原因：ok / service_absent / eda_disconnected / service_unavailable… */
  reason_code: string;
  detail: string;
  hint: string;
  [key: string]: unknown;
}

export interface EnvironmentDependency {
  id: string;
  status: CheckStatus;
  checks: string[];
}

export interface LiveStrategyReport {
  summary: string;
  next_action: string;
  locations: LiveStrategy["locations"];
}

export interface ClientExeReport {
  status: string;
  path: string | null;
  location: string;
  source: string;
}

export interface EnvironmentReport {
  status: EnvironmentStatus;
  channel_state: ChannelState;
  checks: ChannelCheck[];
  dependencies: EnvironmentDependency[];
  functional_degradations: string[];
  version_fingerprint: {
    cdp: { browser?: string | null; protocol?: string | null } | null;
    bridge: { port?: number | null; windows: number } | null;
  };
  next_action: string;
  /** 给 CLI 用的退出码：0 双通道 / 1 单通道 / 2 都不可用。 */
  exit_code: 0 | 1 | 2;
  /** 执行环境（调用方传入时才有）。 */
  environment?: EnvironmentInfo;
  /** 按环境推导的在线通道策略。 */
  live_strategy?: LiveStrategyReport;
  /** 客户端可执行文件发现结果。 */
  client_exe?: ClientExeReport | null;
}

export interface BridgeProbeOptions {
  host?: string;
  portFirst?: number;
  portLast?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CdpProbeOptions {
  host?: string;
  /** 按环境优先级排列的探测地址；优先于 host。 */
  hosts?: readonly string[];
  port?: number;
  scan?: readonly [number, number];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface EnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  bridge?: BridgeProbeOptions;
  cdp?: CdpProbeOptions;
  /** 执行环境；用于推导探测地址与给出跨 OS 诊断。 */
  environment?: EnvironmentInfo;
  /** 已算好的策略，避免重复推导。 */
  strategy?: LiveStrategy;
  /** 客户端可执行文件发现结果。 */
  clientExe?: ClientExeDiscovery | null;
  /** bridge 探测地址（缺省回环）。 */
  bridgeHost?: string;
  /** CDP 探测地址列表；缺省由 environment 推导，再退回回环。 */
  cdpHosts?: readonly string[];
  /** 测试注入：替换真实端口探测。 */
  probeBridge?: () => Promise<ChannelCheck>;
  probeCdp?: () => Promise<ChannelCheck>;
}

const CDP_PROBE_TIMEOUT_MS = 1500;
const BRIDGE_PROBE_TIMEOUT_MS = 800;

/** 由 bridge 发现结果生成一条 check；桥在跑但没窗口时是 partial。 */
export function bridgeCheckFromEndpoint(
  endpoint: BridgeEndpoint | null,
  host: string,
): ChannelCheck {
  if (!endpoint) {
    return {
      id: "bridge-probe",
      status: "missing",
      reason_code: "service_absent",
      detail: "",
      hint: "启动 easyeda-bridge 服务（lceda-bridge start），并在客户端加载 run-api-gateway 扩展",
    };
  }
  const windows = Number(endpoint.health.edaWindowCount ?? 0);
  const base = { id: "bridge-probe", port: endpoint.port, windows };
  if (endpoint.health.edaConnected) {
    return {
      ...base,
      status: "ready",
      reason_code: "ok",
      detail: `${host}:${endpoint.port} · ${windows} 个窗口`,
      hint: "",
    };
  }
  return {
    ...base,
    status: "partial",
    reason_code: "eda_disconnected",
    detail: `${host}:${endpoint.port} 服务在跑，但没有窗口连接`,
    hint: "在客户端加载并启用 run-api-gateway 扩展",
  };
}

/** 探测 bridge。找不到是 missing；身份/协议错误是 unavailable。 */
export async function probeBridgeChannel(options: BridgeProbeOptions = {}): Promise<ChannelCheck> {
  const host = options.host ?? BRIDGE_LISTEN_HOST;
  try {
    const endpoint = await discoverBridge({
      host,
      portFirst: options.portFirst ?? BRIDGE_PORT_START,
      portLast: options.portLast ?? BRIDGE_PORT_END,
      timeoutMs: options.timeoutMs ?? BRIDGE_PROBE_TIMEOUT_MS,
    });
    return bridgeCheckFromEndpoint(endpoint, host);
  } catch (error) {
    const message = error instanceof BridgeClientError ? error.message : String(error);
    return {
      id: "bridge-probe",
      status: "unavailable",
      reason_code: "probe_failed",
      detail: message,
      hint: "检查 lceda-bridge 日志；协议错误通常意味着 bridge 版本与本工具不一致",
    };
  }
}

function cdpCheckFromOutput(output: DiscoverOutput, host: string): ChannelCheck {
  const best = output.usable[0];
  if (!best) {
    return {
      id: "cdp-endpoint",
      status: "missing",
      reason_code: "service_unavailable",
      detail: "",
      hint: "彻底退出客户端后带 --remote-debugging-port=9222 启动；或用 lceda-connect cdp start",
    };
  }
  const browser = versionBrowser(best.version);
  return {
    id: "cdp-endpoint",
    status: "ready",
    reason_code: "ok",
    detail: `${host}:${best.port} · ${browser || "unknown"}`,
    hint: "",
    version: {
      browser: browser || null,
      protocol:
        best.version !== null &&
        typeof best.version === "object" &&
        typeof (best.version as Record<string, unknown>)["Protocol-Version"] === "string"
          ? ((best.version as Record<string, unknown>)["Protocol-Version"] as string)
          : null,
      uuid: browserUuid(best.version) || null,
    },
  };
}

/**
 * 探测 CDP。按 hosts 顺序尝试，命中即返回；全部失败时把试过的地址写进 detail。
 * 默认先看 profile 的端口文件，再试 9222 / EASYEDA_CDP_PORT。
 */
export async function probeCdpChannel(options: CdpProbeOptions = {}): Promise<ChannelCheck> {
  const env = options.env ?? process.env;
  const port = options.port ?? defaultPortFromEnv(env) ?? DEFAULT_CDP_PORT;
  const hosts =
    options.hosts && options.hosts.length > 0 ? options.hosts : [options.host ?? DEFAULT_CDP_HOST];
  const tried: string[] = [];
  let last: ChannelCheck | null = null;
  for (const host of hosts) {
    tried.push(host);
    try {
      const output = await discoverCdp(host, {
        port,
        scan: options.scan,
        timeoutMs: options.timeoutMs ?? CDP_PROBE_TIMEOUT_MS,
        env,
        allowedHosts: hosts,
      });
      const check = cdpCheckFromOutput(output, host);
      if (check.status === "ready") return { ...check, hosts: tried };
      last = check;
    } catch (error) {
      last = {
        id: "cdp-endpoint",
        status: "unavailable",
        reason_code: "probe_failed",
        detail: error instanceof Error ? error.message : String(error),
        hint: `试过 ${tried.join(" → ")}；确认客户端调试端口、Windows 防火墙或 WSL 网络模式`,
      };
    }
  }
  const base: ChannelCheck = last ?? {
    id: "cdp-endpoint",
    status: "missing",
    reason_code: "service_unavailable",
    detail: "",
    hint: "彻底退出客户端后带 --remote-debugging-port=9222 启动；或用 lceda-connect cdp start",
  };
  return {
    ...base,
    detail: base.detail || `试过 ${tried.join(" → ")}`,
    hosts: tried,
  };
}

function checkNodeVersion(nodeVersion: string): ChannelCheck {
  const match = /^v?(\d+)\./.exec(nodeVersion.trim());
  const major = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
  const ok = major >= 20;
  return {
    id: "node-version",
    status: ok ? "ready" : "missing",
    reason_code: ok ? "ok" : "version_incompatible",
    detail: nodeVersion,
    hint: ok ? "" : "安装 Node 20 或更高版本（打包目标为 node20）",
  };
}

function versionFingerprint(
  bridge: ChannelCheck,
  cdp: ChannelCheck,
): EnvironmentReport["version_fingerprint"] {
  const cdpVersion =
    cdp.version !== null && typeof cdp.version === "object"
      ? (cdp.version as { browser?: string | null; protocol?: string | null })
      : null;
  return {
    cdp: cdpVersion,
    bridge:
      typeof bridge.port === "number"
        ? { port: bridge.port, windows: Number(bridge.windows ?? 0) }
        : null,
  };
}

/** 是否是「WSL2 NAT + 客户端在 Windows 宿主」这种跨命名空间组合。 */
function isCrossOsHostEnvironment(info: EnvironmentInfo | undefined): boolean {
  if (!info || info.kind !== "wsl2") return false;
  if (info.networkingMode === "mirrored") return false;
  if (info.clientLocations.includes("vm")) return false;
  return true;
}

/** 完整自检；`probeBridge` / `probeCdp` 可注入，便于离线测试四态。 */
export async function checkEnvironment(
  options: EnvironmentOptions = {},
): Promise<EnvironmentReport> {
  const env = options.env ?? process.env;
  const info = options.environment;
  const strategy = options.strategy ?? (info ? liveStrategy(info) : undefined);
  const nodeItem = checkNodeVersion(options.nodeVersion ?? process.version);
  const cdpModuleItem: ChannelCheck = {
    id: "cdp-module",
    status: "ready",
    reason_code: "ok",
    detail: "内置 CDP 连接层（src/cdp）",
    hint: "",
  };
  const bridgeHost =
    options.bridgeHost ??
    options.bridge?.host ??
    (info ? (strategy?.bridgeHost ?? BRIDGE_LISTEN_HOST) : BRIDGE_LISTEN_HOST);
  const cdpHosts =
    options.cdpHosts ??
    (info ? cdpProbeHosts(info) : undefined) ??
    (options.cdp?.hosts && options.cdp.hosts.length > 0
      ? options.cdp.hosts
      : [options.cdp?.host ?? DEFAULT_CDP_HOST]);

  let bridgeItem = options.probeBridge
    ? await options.probeBridge()
    : await probeBridgeChannel({ ...options.bridge, host: bridgeHost });
  if (!options.probeBridge && isCrossOsHostEnvironment(info)) {
    if (bridgeItem.status === "missing" || bridgeItem.status === "unavailable") {
      bridgeItem = {
        ...bridgeItem,
        reason_code: "cross_os_loopback",
        hint:
          strategy?.nextAction ??
          "bridge 只监听回环，跨 WSL/Windows 不可达；在 Windows 侧运行 MCP 或启用 WSL mirrored 网络",
      };
    }
  }
  const cdpItem = options.probeCdp
    ? await options.probeCdp()
    : await probeCdpChannel({
        ...options.cdp,
        host: cdpHosts[0],
        hosts: cdpHosts,
        env,
      });

  const bridgeOk = bridgeItem.status === "ready";
  const cdpOk = cdpItem.status === "ready";
  let channelState: ChannelState;
  let status: EnvironmentStatus;
  if (bridgeOk && cdpOk) {
    channelState = "both";
    status = "ready";
  } else if (bridgeOk || cdpOk) {
    channelState = bridgeOk ? "bridge-only" : "cdp-only";
    status = "partial";
  } else {
    channelState = "none";
    status = "needs_setup";
  }

  const sessionOk = bridgeOk || cdpOk;
  const crossOs = isCrossOsHostEnvironment(info);
  const checks: ChannelCheck[] = [];
  if (info) {
    checks.push({
      id: "environment",
      status: "ready",
      reason_code: "ok",
      detail: describeEnvironment(info),
      hint: strategy?.summary ?? "",
    });
  }
  checks.push(
    nodeItem,
    cdpModuleItem,
    {
      id: "client-session",
      status: sessionOk ? "ready" : "missing",
      reason_code: sessionOk ? "ok" : crossOs ? "cross_os_loopback" : "service_unavailable",
      detail: sessionOk
        ? "至少一条通道可见客户端"
        : crossOs
          ? "两条通道都看不到客户端（WSL2 与 Windows 宿主回环不互通）"
          : "两条通道都看不到客户端",
      hint: sessionOk
        ? ""
        : crossOs
          ? (strategy?.nextAction ?? "在 Windows 侧运行 MCP，或启用 WSL mirrored 网络")
          : "先启动客户端；bridge 需加载扩展，CDP 需带调试端口启动",
    },
    bridgeItem,
    cdpItem,
  );

  const functionalDegradations: string[] = [];
  if (!bridgeOk) functionalDegradations.push("无官方 API 面：工程管理、制造导出不可用");
  if (!cdpOk) functionalDegradations.push("无视觉回路：截图类审查降级为人工截图");
  if (crossOs) {
    functionalDegradations.push(
      "WSL2 NAT：在线通道跨命名空间，bridge 不可达（CDP 仅在客户端监听非回环时可达）",
    );
  }

  const nextAction =
    status === "ready"
      ? "两条通道都可用，直接进入路由决策"
      : status === "partial"
        ? "单通道可用：按路由表执行，跳过不可用通道相关的动词"
        : (strategy?.nextAction ??
          "先搭一条通道：bridge 需启动服务并加载扩展，或按 setup-guide 开 CDP 端口");

  return {
    status,
    channel_state: channelState,
    checks,
    dependencies: [
      { id: "node-runtime", status: nodeItem.status, checks: ["node-version"] },
      {
        id: "easyeda-cdp-connect",
        status: cdpModuleItem.status,
        checks: ["cdp-module", "cdp-endpoint"],
      },
      { id: "easyeda-bridge", status: bridgeItem.status, checks: ["bridge-probe"] },
      {
        id: "lceda-pro-client",
        status: sessionOk ? "ready" : "missing",
        checks: ["client-session"],
      },
    ],
    functional_degradations: functionalDegradations,
    version_fingerprint: versionFingerprint(bridgeItem, cdpItem),
    next_action: nextAction,
    exit_code: status === "ready" ? 0 : status === "partial" ? 1 : 2,
    ...(info
      ? {
          environment: info,
          live_strategy: strategy
            ? {
                summary: strategy.summary,
                next_action: strategy.nextAction,
                locations: strategy.locations,
              }
            : undefined,
        }
      : {}),
    client_exe: options.clientExe
      ? {
          status: options.clientExe.status,
          path: options.clientExe.path,
          location: options.clientExe.location,
          source: options.clientExe.source,
        }
      : null,
  };
}

/** 环境自检的退出码（源仓库 0/1/2 口径）。 */
export function environmentExitCode(report: EnvironmentReport): 0 | 1 | 2 {
  return report.exit_code;
}
