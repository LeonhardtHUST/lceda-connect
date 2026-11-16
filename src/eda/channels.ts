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

/**
 * 双通道环境自检（源仓库 `scripts/check_environment.py`）。
 *
 * 只读：不安装、不登录、不改配置、不启动进程。输出四态 `channel_state`：
 * both / bridge-only / cdp-only / none，另有逐项 `checks[]`（含 reason_code 与 hint）
 * 和一句 `next_action`。退出码沿用源口径：0 双通道 / 1 单通道 / 2 都不可用。
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

/** 探测本机 bridge。找不到是 missing；身份/协议错误是 unavailable。 */
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

/** 探测 CDP 端点。默认先看 profile 的端口文件，再试 9222 / EASYEDA_CDP_PORT。 */
export async function probeCdpChannel(options: CdpProbeOptions = {}): Promise<ChannelCheck> {
  const host = options.host ?? DEFAULT_CDP_HOST;
  const env = options.env ?? process.env;
  const port = options.port ?? defaultPortFromEnv(env) ?? DEFAULT_CDP_PORT;
  try {
    const output = await discoverCdp(host, {
      port,
      scan: options.scan,
      timeoutMs: options.timeoutMs ?? CDP_PROBE_TIMEOUT_MS,
      env,
    });
    return cdpCheckFromOutput(output, host);
  } catch (error) {
    return {
      id: "cdp-endpoint",
      status: "unavailable",
      reason_code: "probe_failed",
      detail: error instanceof Error ? error.message : String(error),
      hint: "只允许回环地址；确认客户端与端口配置",
    };
  }
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

/** 完整自检；`probeBridge` / `probeCdp` 可注入，便于离线测试四态。 */
export async function checkEnvironment(
  options: EnvironmentOptions = {},
): Promise<EnvironmentReport> {
  const env = options.env ?? process.env;
  const nodeItem = checkNodeVersion(options.nodeVersion ?? process.version);
  const cdpModuleItem: ChannelCheck = {
    id: "cdp-module",
    status: "ready",
    reason_code: "ok",
    detail: "内置 CDP 连接层（src/cdp）",
    hint: "",
  };
  const bridgeItem = options.probeBridge
    ? await options.probeBridge()
    : await probeBridgeChannel(options.bridge);
  const cdpItem = options.probeCdp
    ? await options.probeCdp()
    : await probeCdpChannel({ ...options.cdp, env });

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
  const checks: ChannelCheck[] = [
    nodeItem,
    cdpModuleItem,
    {
      id: "client-session",
      status: sessionOk ? "ready" : "missing",
      reason_code: sessionOk ? "ok" : "service_unavailable",
      detail: sessionOk ? "至少一条通道可见客户端" : "两条通道都看不到客户端",
      hint: sessionOk ? "" : "先启动客户端；bridge 需加载扩展，CDP 需带调试端口启动",
    },
    bridgeItem,
    cdpItem,
  ];

  const functionalDegradations: string[] = [];
  if (!bridgeOk) functionalDegradations.push("无官方 API 面：工程管理、制造导出不可用");
  if (!cdpOk) functionalDegradations.push("无视觉回路：截图类审查降级为人工截图");

  const nextAction =
    status === "ready"
      ? "两条通道都可用，直接进入路由决策"
      : status === "partial"
        ? "单通道可用：按路由表执行，跳过不可用通道相关的动词"
        : "先搭一条通道：bridge 需启动服务并加载扩展，或按 setup-guide 开 CDP 端口";

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
  };
}

/** 环境自检的退出码（源仓库 0/1/2 口径）。 */
export function environmentExitCode(report: EnvironmentReport): 0 | 1 | 2 {
  return report.exit_code;
}
