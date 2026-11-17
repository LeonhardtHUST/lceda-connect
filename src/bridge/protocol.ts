/**
 * EasyEDA AI Bridge 的协议常量与消息形状。
 *
 * 这些字段不是随便定的：已经装在编辑器里的扩展（`eda.sys_WebSocket.register()`）
 * 以及外部脚本都按这套契约说话，改名或改端口会让它们连不上。
 * 来源：easyeda-api-skill/scripts/bridge-server.mjs（sha 002a39d，见 assets/api-docs/SOURCE.md）。
 */

/** 端口区间：服务从 49620 起找第一个空闲端口。 */
export const BRIDGE_PORT_START = 49620;
export const BRIDGE_PORT_END = 49629;
/** 服务身份，`GET /health` 与 WS 握手都靠它确认「对面确实是 bridge」。 */
export const BRIDGE_SERVICE_ID = "easyeda-bridge";
/** 只监听回环地址。 */
export const BRIDGE_LISTEN_HOST = "127.0.0.1";

/** 编辑器端连接的 WebSocket 路径；其它路径都按 agent 端处理。 */
export const BRIDGE_EDA_PATH = "/eda";
export const BRIDGE_HEALTH_PATH = "/health";
export const BRIDGE_WINDOWS_PATH = "/eda-windows";
export const BRIDGE_SELECT_WINDOW_PATH = "/eda-windows/select";
export const BRIDGE_EXECUTE_PATH = "/execute";

/** 单条 HTTP 请求体上限（4 MiB）。 */
export const BRIDGE_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** 单条 execute 代码上限（1 MiB，按 UTF-8 字节计算）。 */
export const BRIDGE_MAX_CODE_BYTES = 1 * 1024 * 1024;
/** WebSocket 单帧上限（16 MiB）。 */
export const BRIDGE_MAX_WS_PAYLOAD_BYTES = 16 * 1024 * 1024;
/** 服务端同时等待的 execute 请求上限。 */
export const BRIDGE_MAX_PENDING_REQUESTS = 64;
/** agent 认证请求头。 */
export const BRIDGE_TOKEN_HEADER = "X-Lceda-Bridge-Token";
/** 运行态目录中的按端口 token 文件名格式。 */
export const BRIDGE_TOKEN_FILE_PREFIX = "token-";
export const BRIDGE_TOKEN_FILE_SUFFIX = ".txt";
/** 认证相关环境变量。 */
export const BRIDGE_TOKEN_ENV = "LCEDA_BRIDGE_TOKEN";
export const BRIDGE_RUNTIME_ENV = "LCEDA_BRIDGE_RUNTIME";
export const BRIDGE_AUTH_ENV = "LCEDA_BRIDGE_AUTH";
export const BRIDGE_ALLOWED_ORIGINS_ENV = "LCEDA_BRIDGE_ALLOWED_ORIGINS";

/** 单条 execute 请求的服务端超时（与原实现一致）。 */
export const BRIDGE_REQUEST_TIMEOUT_MS = 30_000;

export type BridgeClientType = "eda" | "agent";

/** 连接建立后服务端主动发的第一帧。 */
export interface BridgeHandshakeMessage {
  type: "handshake";
  service: string;
  clientType: BridgeClientType;
  timestamp: number;
}

/** 编辑器端注册窗口（扩展启动后发送）。 */
export interface BridgeRegisterMessage {
  type: "register";
  windowId: string;
}

export interface BridgeExecuteMessage {
  type: "execute";
  id: string;
  code: string;
  windowId: string;
  timestamp: number;
}

export interface BridgeResultMessage {
  type: "result";
  id: string;
  result: unknown;
  timestamp: number;
}

export interface BridgeErrorMessage {
  type: "error";
  id: string;
  error: string;
  timestamp: number;
}

export interface BridgePingMessage {
  type: "ping";
  id?: string;
  timestamp?: number;
}

export interface BridgePongMessage {
  type: "pong";
  id?: string;
  timestamp: number;
}

/** 双向消息的并集；解析外部 JSON 时先按 unknown 取 type 再收窄。 */
export type BridgeMessage =
  | BridgeHandshakeMessage
  | BridgeRegisterMessage
  | BridgeExecuteMessage
  | BridgeResultMessage
  | BridgeErrorMessage
  | BridgePingMessage
  | BridgePongMessage;

/** `GET /health` 的响应体，字段顺序与原实现一致。 */
export interface BridgeHealthResponse {
  service: string;
  status: "ok";
  edaConnected: boolean;
  edaWindowCount: number;
  activeWindowId: string | null;
  pendingRequests: number;
  timestamp: number;
}

export interface BridgeWindowInfo {
  windowId: string;
  connected: boolean;
  active: boolean;
}

export interface BridgeWindowsResponse {
  windows: BridgeWindowInfo[];
  activeWindowId: string | null;
  count: number;
}

/** `POST /execute` 的响应体：成功带 result，失败带 error。 */
export interface BridgeExecuteResponse {
  success: boolean;
  result?: unknown;
  windowId?: string;
  error?: string;
}

export interface BridgeSelectWindowResponse {
  success?: boolean;
  activeWindowId?: string;
  error?: string;
}

/** 把外部 JSON 收窄成带 type 的消息；不是对象或没有字符串 type 时返回 null。 */
export function asBridgeMessage(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return typeof record.type === "string" ? record : null;
}

/** ws 的 RawData 统一转成 UTF-8 字符串（Buffer / Buffer[] / ArrayBuffer / string 都可能）。 */
export function rawDataText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return String(raw);
}
