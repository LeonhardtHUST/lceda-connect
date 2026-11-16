/** 运行时共享类型。 */
export interface ProcInfo {
  pid: number;
  name: string;
  /** PowerShell 拿不到时有可能是空串（例如由 tasklist 兜底）。 */
  commandLine: string;
}

export interface TcpListener {
  port: number;
  pid: number;
}

/** `GET /json/version` 的响应（CDP）。 */
export interface CdpInfo {
  Browser?: string;
  "Protocol-Version"?: string;
  "User-Agent"?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

/** bridge-server.mjs 的 `GET /health` 响应。 */
export interface BridgeHealth {
  service?: string;
  edaConnected?: boolean;
  edaWindowCount?: number;
  activeWindowId?: string | null;
  pendingRequests?: number;
  [key: string]: unknown;
}
