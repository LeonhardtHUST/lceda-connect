import type { AppConfig } from "../core/config.ts";
import type { Io } from "../core/io.ts";

/** CDP 子命令（对应旧 lceda-cdp.ps1 的 action）。 */
export type CdpAction = "start" | "ensure" | "status" | "endpoint" | "stop";

/** Bridge 子命令（对应旧 lceda-bridge.ps1 的 action，含别名）。 */
export type BridgeAction =
  | "start"
  | "stop"
  | "kill"
  | "restart"
  | "status"
  | "st"
  | "health"
  | "logs"
  | "log"
  | "doctor"
  | "check"
  | "env"
  | "run"
  | "supervise"
  | "help";

export interface CommandContext {
  cfg: AppConfig;
  io: Io;
  env: NodeJS.ProcessEnv;
}

export interface CdpOptions {
  json: boolean;
  yes: boolean;
  force: boolean;
  proxyServer?: string;
  waitOnlineSec: number;
  keepProxyEnv: boolean;
}

export interface BridgeOptions {
  json: boolean;
  lines: number;
  follow: boolean;
  once: boolean;
}
