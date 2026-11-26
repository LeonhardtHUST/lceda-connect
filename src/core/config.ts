import { homedir } from "node:os";
import path from "node:path";

import {
  bridgeProbeHost,
  cdpProbeHosts,
  detectEnvironment,
  hostOverrideWarning,
  type ClientLocationSource,
  type DetectEnvironmentOptions,
  type EnvironmentInfo,
  type EnvironmentKindSource,
} from "./environment.ts";
import {
  discoverClientExePlan,
  type ClientExeDiscovery,
  type ClientExePlan,
} from "./exeDiscovery.ts";

/** 立创EDA专业版历史默认安装路径（仅 Windows 原生环境；可用 `--exe` / LCEDA_PRO_EXE 覆盖）。 */
export const DEFAULT_PRO_EXE = "D:\\Program Files\\lceda-pro\\lceda-pro.exe";
export const DEFAULT_CDP_PORT = 9222;
export const LOOPBACK = "127.0.0.1";

/** bridge-server.mjs 的固定契约，改动前请同步核对服务端。 */
export const BRIDGE_PORT_FIRST = 49620;
export const BRIDGE_PORT_LAST = 49629;
export const BRIDGE_SERVICE_ID = "easyeda-bridge";
export const BRIDGE_MAX_LOG_BYTES = 5 * 1024 * 1024;
export const BRIDGE_START_WAIT_MS = 20_000;
export const BRIDGE_RESTART_DELAY_MS = 3_000;

/** CDP 启动后等待端点就绪的上限（旧脚本为 60 秒）。 */
export const CDP_START_WAIT_MS = 60_000;

export interface CdpConfig {
  /** 显式/历史默认的可执行文件路径；实际可执行路径见 `client.exe.path`。 */
  exePath: string;
  port: number;
  /** CLI 探测端点的回环地址，不控制客户端的监听地址。 */
  bindHost: string;
  /** 当前环境下的首选探测地址（WSL2 可能是宿主地址，而不是回环）。 */
  host: string;
  /** 按客户端位置优先级展开的探测地址列表。 */
  hosts: readonly string[];
  runtimeDir: string;
  pidFile: string;
  logFile: string;
  /** 旧版 easyeda-cdp-connect 的 pid 文件，迁移期只读兼容。 */
  legacyPidFile: string;
  startWaitMs: number;
  /** 附加扫描端口区间（配置 LCEDA_CDP_SCAN=9222-9240）。 */
  scan?: readonly [number, number];
}

export interface BridgeConfig {
  portFirst: number;
  portLast: number;
  /** 服务监听地址（契约固定回环，不可跨命名空间）。 */
  bindHost: string;
  /** 探测地址；默认回环，允许配置覆盖（例如端口转发场景）。 */
  host: string;
  serviceId: string;
  runtimeDir: string;
  logFile: string;
  stateFile: string;
  maxLogBytes: number;
  startWaitMs: number;
  restartDelayMs: number;
  /** LCEDA_NODE 覆盖 */
  nodePath?: string;
  /** LCEDA_BRIDGE_SCRIPT 覆盖 */
  bridgeScript?: string;
}

export interface ClientConfig {
  /** 按实例位置优先级排列的发现结果。 */
  plan: ClientExePlan;
  /** 首个可用结果；没有则是 null。 */
  exe: ClientExeDiscovery | null;
}

export interface AppConfig {
  cdp: CdpConfig;
  bridge: BridgeConfig;
  /** 执行环境（自动发现或显式指定）。 */
  environment: EnvironmentInfo;
  /** 客户端可执行文件发现结果。 */
  client: ClientConfig;
}

export interface CdpOverrides {
  exePath?: string;
  port?: number;
}

export interface BridgeOverrides {
  nodePath?: string;
  bridgeScript?: string;
}

export interface ConfigOverrides {
  cdp?: CdpOverrides;
  bridge?: BridgeOverrides;
}

const KIND_SOURCES: readonly EnvironmentKindSource[] = [
  "argv",
  "config-file",
  "env",
  "auto-detected",
];

function kindSourceOf(
  raw: string | undefined,
  fallback: EnvironmentKindSource,
): EnvironmentKindSource {
  return KIND_SOURCES.includes(raw as EnvironmentKindSource)
    ? (raw as EnvironmentKindSource)
    : fallback;
}

function locationSourceOf(raw: string | undefined): ClientLocationSource | undefined {
  if (raw === "argv" || raw === "config-file" || raw === "env" || raw === "default") return raw;
  return undefined;
}

export interface LoadConfigOptions {
  /** 环境探测注入（测试用）。 */
  detect?: DetectEnvironmentOptions;
  /** 客户端发现是否走 where/which 深探（较慢，默认关闭）。 */
  deepExe?: boolean;
  /** 注入文件存在性判断（测试用）。 */
  exists?: (file: string) => boolean;
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function scanFromEnv(raw: string | undefined): readonly [number, number] | undefined {
  if (!raw) return undefined;
  const match = /^(\d+)\s*[-:]\s*(\d+)$/.exec(raw.trim());
  if (!match) return undefined;
  const start = Number.parseInt(match[1] ?? "", 10);
  const end = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start)
    return undefined;
  return [start, end];
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.USERPROFILE || env.HOME || homedir();
}

/**
 * 配置优先级：命令行参数 > 配置文件 > .env > 环境变量 > 内置默认值
 * （前四级由 core/runtimeConfig 合并成 env，这里只处理 env + 显式 overrides）。
 *
 * 目录约定：
 *   - CDP 运行态放在 ~/.lceda-connect/cdp（可用 LCEDA_CONNECT_HOME 改根）
 *   - Bridge 运行态沿用 %LOCALAPPDATA%\lceda-bridge，保证老的 state.json / bridge.log 继续可用
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {},
  options: LoadConfigOptions = {},
): AppConfig {
  const home = homeDir(env);
  const connectHome = env.LCEDA_CONNECT_HOME || path.join(home, ".lceda-connect");
  const cdpDir = path.join(connectHome, "cdp");
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const bridgeDir = env.LCEDA_BRIDGE_RUNTIME || path.join(localAppData, "lceda-bridge");

  const detectOptions: DetectEnvironmentOptions = {
    ...options.detect,
    kind: options.detect?.kind ?? env.LCEDA_ENV ?? null,
    windowsHost: options.detect?.windowsHost ?? env.LCEDA_WINDOWS_HOST ?? null,
    clientLocations: options.detect?.clientLocations ?? env.LCEDA_LEDA_IN ?? null,
    cache: options.detect?.probes === undefined,
  };
  if (options.detect?.kindSource === undefined && env.LCEDA_ENV_SOURCE) {
    detectOptions.kindSource = kindSourceOf(env.LCEDA_ENV_SOURCE, "env");
  }
  if (options.detect?.windowsHostSource === undefined && env.LCEDA_WINDOWS_HOST_SOURCE) {
    detectOptions.windowsHostSource = kindSourceOf(env.LCEDA_WINDOWS_HOST_SOURCE, "env");
  }
  if (options.detect?.clientLocationSource === undefined && env.LCEDA_LEDA_IN_SOURCE) {
    detectOptions.clientLocationSource = locationSourceOf(env.LCEDA_LEDA_IN_SOURCE);
  }
  const environment = detectEnvironment(detectOptions);
  for (const [value, label] of [
    [env.LCEDA_CDP_HOST, "CDP 探测地址"],
    [env.LCEDA_BRIDGE_HOST, "bridge 探测地址"],
  ] as const) {
    const warning = hostOverrideWarning(environment, value, label);
    if (warning) environment.warnings.push(warning);
  }
  const cdpHosts = cdpProbeHosts(environment, env.LCEDA_CDP_HOST);
  const bridgeHost = bridgeProbeHost(environment, env.LCEDA_BRIDGE_HOST);
  const explicitExe = overrides.cdp?.exePath ?? env.LCEDA_PRO_EXE;
  const exePlan = discoverClientExePlan({
    environment,
    env,
    explicitPath: explicitExe,
    deep: options.deepExe ?? false,
    exists: options.exists,
  });

  return {
    cdp: {
      exePath: explicitExe ?? DEFAULT_PRO_EXE,
      port: overrides.cdp?.port ?? intFromEnv(env.LCEDA_CDP_PORT, DEFAULT_CDP_PORT),
      bindHost: LOOPBACK,
      host: cdpHosts[0] ?? LOOPBACK,
      hosts: cdpHosts,
      runtimeDir: cdpDir,
      pidFile: path.join(cdpDir, "lceda-cdp.pid"),
      logFile: path.join(cdpDir, "lceda-cdp.log"),
      legacyPidFile: path.join(home, ".lceda-cdp", "lceda-cdp.pid"),
      startWaitMs: CDP_START_WAIT_MS,
      scan: scanFromEnv(env.LCEDA_CDP_SCAN),
    },
    bridge: {
      portFirst: intFromEnv(env.LCEDA_BRIDGE_PORT_FIRST, BRIDGE_PORT_FIRST),
      portLast: intFromEnv(env.LCEDA_BRIDGE_PORT_LAST, BRIDGE_PORT_LAST),
      bindHost: LOOPBACK,
      host: bridgeHost,
      serviceId: BRIDGE_SERVICE_ID,
      runtimeDir: bridgeDir,
      logFile: path.join(bridgeDir, "bridge.log"),
      stateFile: path.join(bridgeDir, "state.json"),
      maxLogBytes: BRIDGE_MAX_LOG_BYTES,
      startWaitMs: BRIDGE_START_WAIT_MS,
      restartDelayMs: BRIDGE_RESTART_DELAY_MS,
      nodePath: overrides.bridge?.nodePath ?? env.LCEDA_NODE,
      bridgeScript: overrides.bridge?.bridgeScript ?? env.LCEDA_BRIDGE_SCRIPT,
    },
    environment,
    client: {
      plan: exePlan,
      exe: exePlan.primary,
    },
  };
}
