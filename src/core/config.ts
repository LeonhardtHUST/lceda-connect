import { homedir } from "node:os";
import path from "node:path";

/** 立创EDA专业版默认安装路径（与旧脚本保持一致，可用 LCEDA_PRO_EXE / --exe 覆盖）。 */
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
  exePath: string;
  port: number;
  /** CLI 探测端点的回环地址，不控制客户端的监听地址。 */
  bindHost: string;
  runtimeDir: string;
  pidFile: string;
  logFile: string;
  /** 旧版 easyeda-cdp-connect 的 pid 文件，迁移期只读兼容。 */
  legacyPidFile: string;
  startWaitMs: number;
}

export interface BridgeConfig {
  portFirst: number;
  portLast: number;
  bindHost: string;
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

export interface AppConfig {
  cdp: CdpConfig;
  bridge: BridgeConfig;
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

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.USERPROFILE || env.HOME || homedir();
}

/**
 * 配置优先级：命令行参数 > 环境变量 > 内置默认值。
 * 目录约定：
 *   - CDP 运行态放在 ~/.lceda-connect/cdp（可用 LCEDA_CONNECT_HOME 改根）
 *   - Bridge 运行态沿用 %LOCALAPPDATA%\lceda-bridge，保证老的 state.json / bridge.log 继续可用
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {},
): AppConfig {
  const home = homeDir(env);
  const connectHome = env.LCEDA_CONNECT_HOME || path.join(home, ".lceda-connect");
  const cdpDir = path.join(connectHome, "cdp");
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const bridgeDir = env.LCEDA_BRIDGE_RUNTIME || path.join(localAppData, "lceda-bridge");

  return {
    cdp: {
      exePath: overrides.cdp?.exePath ?? env.LCEDA_PRO_EXE ?? DEFAULT_PRO_EXE,
      port: overrides.cdp?.port ?? intFromEnv(env.LCEDA_CDP_PORT, DEFAULT_CDP_PORT),
      bindHost: LOOPBACK,
      runtimeDir: cdpDir,
      pidFile: path.join(cdpDir, "lceda-cdp.pid"),
      logFile: path.join(cdpDir, "lceda-cdp.log"),
      legacyPidFile: path.join(home, ".lceda-cdp", "lceda-cdp.pid"),
      startWaitMs: CDP_START_WAIT_MS,
    },
    bridge: {
      portFirst: BRIDGE_PORT_FIRST,
      portLast: BRIDGE_PORT_LAST,
      bindHost: LOOPBACK,
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
  };
}
