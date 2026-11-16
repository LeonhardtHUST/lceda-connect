import {
  BRIDGE_LISTEN_HOST,
  BRIDGE_PORT_END,
  BRIDGE_PORT_START,
  BRIDGE_SERVICE_ID,
  type BridgeHealthResponse,
  type BridgeSelectWindowResponse,
  type BridgeWindowsResponse,
} from "./protocol.ts";

/**
 * bridge 的 HTTP 客户端（对应 leonskill-easyeda-connect 的 scripts/bridge_client.py）。
 *
 * 只连回环地址；服务身份必须是 easyeda-bridge；不做端口转发。
 * Python 版用退出码表示失败类别，这里换成错误码，CLI 再映射回退出码：
 *   NO_BRIDGE=2 / NOT_CONNECTED=3 / PROTOCOL=4 / TIMEOUT=5
 */

export type BridgeErrorCode = "NO_BRIDGE" | "NOT_CONNECTED" | "PROTOCOL" | "TIMEOUT";

const EXIT_CODES: Record<BridgeErrorCode, number> = {
  NO_BRIDGE: 2,
  NOT_CONNECTED: 3,
  PROTOCOL: 4,
  TIMEOUT: 5,
};

export class BridgeClientError extends Error {
  readonly code: BridgeErrorCode;
  /** 与 bridge_client.py 对齐的退出码（0 成功 / 2 没服务 / 3 未连接 / 4 协议 / 5 超时）。 */
  readonly exitCode: number;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = "BridgeClientError";
    this.code = code;
    this.exitCode = EXIT_CODES[code];
  }
}

/** 发现失败时给调用方的可执行建议。 */
export function bridgeErrorHint(code: BridgeErrorCode): string {
  switch (code) {
    case "NO_BRIDGE":
      return "没有发现运行中的 bridge：先跑 lceda-bridge start（或 lceda-bridge doctor 看原因）。";
    case "NOT_CONNECTED":
      return "bridge 在跑，但没有 EDA 窗口连接：到 EasyEDA Pro 里点扩展的「重新连接」。";
    case "TIMEOUT":
      return "请求超时：确认编辑器窗口没有卡住，或调大 timeoutMs。";
    case "PROTOCOL":
      return "协议/HTTP 错误：检查 bridge 版本与本工具是否一致，必要时 lceda-bridge restart。";
  }
}

export interface BridgeClientOptions {
  host?: string;
  /** 单次 HTTP 请求超时。 */
  timeoutMs?: number;
}

export interface BridgeDiscoveryOptions extends BridgeClientOptions {
  portFirst?: number;
  portLast?: number;
}

export interface BridgeEndpoint {
  port: number;
  host: string;
  health: BridgeHealthResponse;
}

export interface BridgeExecuteOptions extends BridgeClientOptions {
  windowId?: string;
  /** 服务端自己 30s 超时，客户端默认留一点余量。 */
  timeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 800;
const DEFAULT_EXECUTE_TIMEOUT_MS = 35_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

interface HttpResult {
  status: number;
  data: unknown;
}

function errorCause(error: unknown): { code?: string; name?: string; message: string } {
  const err = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
  return {
    code:
      typeof cause?.code === "string"
        ? cause.code
        : typeof err.code === "string"
          ? err.code
          : undefined,
    name: typeof err.name === "string" ? err.name : undefined,
    message:
      (typeof cause?.message === "string" && cause.message) ||
      (typeof err.message === "string" ? err.message : String(error)),
  };
}

async function request(
  port: number,
  method: "GET" | "POST",
  pathName: string,
  options: BridgeClientOptions & { payload?: unknown; timeoutMs?: number },
): Promise<HttpResult> {
  const host = options.host ?? BRIDGE_LISTEN_HOST;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const headers = new Headers({ accept: "application/json" });
  const init: RequestInit = {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers,
  };
  if (options.payload !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.payload);
  }

  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}${pathName}`, init);
  } catch (error) {
    const cause = errorCause(error);
    if (cause.name === "TimeoutError" || cause.name === "AbortError") {
      throw new BridgeClientError("TIMEOUT", `请求 ${pathName} 超时（${timeoutMs}ms）`);
    }
    if (
      cause.code === "ECONNREFUSED" ||
      cause.code === "ECONNRESET" ||
      cause.code === "EHOSTUNREACH" ||
      cause.code === "ENOTFOUND"
    ) {
      throw new BridgeClientError(
        "NO_BRIDGE",
        `端口 ${port} 没有可用的 bridge（${cause.message}）`,
      );
    }
    throw new BridgeClientError(
      "PROTOCOL",
      `无法确认 ${host}:${port}${pathName} 的连接状态：${cause.message}`,
    );
  }

  const text = await response.text();
  let data: unknown = null;
  if (text.trim() !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      throw new BridgeClientError(
        "PROTOCOL",
        `响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`,
      );
    }
  }
  return { status: response.status, data };
}

function asRecord(data: unknown): Record<string, unknown> | null {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

/** 按端口区间逐端口探测，返回第一个 `service === easyeda-bridge` 的实例。 */
export async function discover(
  options: BridgeDiscoveryOptions = {},
): Promise<BridgeEndpoint | null> {
  const portFirst = options.portFirst ?? BRIDGE_PORT_START;
  const portLast = options.portLast ?? BRIDGE_PORT_END;
  for (let port = portFirst; port <= portLast; port += 1) {
    try {
      const state = await health(port, {
        ...options,
        timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      });
      return { port, host: options.host ?? BRIDGE_LISTEN_HOST, health: state };
    } catch {
      // 该端口没有同款服务，继续下一个
    }
  }
  return null;
}

/** 读 `/health` 并校验服务身份。 */
export async function health(
  port: number,
  options: BridgeClientOptions = {},
): Promise<BridgeHealthResponse> {
  const { status, data } = await request(port, "GET", "/health", options);
  const record = asRecord(data);
  if (record === null || record.service !== BRIDGE_SERVICE_ID) {
    throw new BridgeClientError("NO_BRIDGE", `端口 ${port} 的服务身份不是 ${BRIDGE_SERVICE_ID}`);
  }
  if (status !== 200) {
    throw new BridgeClientError("PROTOCOL", `GET /health 返回 HTTP ${status}`);
  }
  return record as unknown as BridgeHealthResponse;
}

/** 列出已连接的 EDA 窗口。 */
export async function windows(
  port: number,
  options: BridgeClientOptions = {},
): Promise<BridgeWindowsResponse> {
  const { status, data } = await request(port, "GET", "/eda-windows", options);
  const record = asRecord(data);
  if (record === null || !Array.isArray(record.windows)) {
    throw new BridgeClientError("PROTOCOL", `GET /eda-windows 返回结构异常（HTTP ${status}）`);
  }
  return record as unknown as BridgeWindowsResponse;
}

/** 切换当前激活窗口。 */
export async function selectWindow(
  port: number,
  windowId: string,
  options: BridgeClientOptions = {},
): Promise<BridgeSelectWindowResponse> {
  const { status, data } = await request(port, "POST", "/eda-windows/select", {
    ...options,
    payload: { windowId },
  });
  const record = asRecord(data);
  if (record === null) {
    throw new BridgeClientError(
      "PROTOCOL",
      `POST /eda-windows/select 返回结构异常（HTTP ${status}）`,
    );
  }
  if (status === 404) {
    throw new BridgeClientError(
      "NOT_CONNECTED",
      typeof record.error === "string" ? record.error : `窗口 ${windowId} 不存在`,
    );
  }
  if (record.success !== true) {
    throw new BridgeClientError("PROTOCOL", `切换窗口失败：${JSON.stringify(record)}`);
  }
  return record as unknown as BridgeSelectWindowResponse;
}

/**
 * 在目标窗口执行代码并返回结果。
 * 返回体里的业务错误一律转成 BridgeClientError：消息带 "not connected" 的算未连接。
 */
export async function execute(
  port: number,
  code: string,
  options: BridgeExecuteOptions = {},
): Promise<unknown> {
  const payload: Record<string, unknown> = { code };
  if (options.windowId) payload.windowId = options.windowId;
  const { status, data } = await request(port, "POST", "/execute", {
    ...options,
    payload,
    timeoutMs: options.timeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS,
  });
  const record = asRecord(data);
  if (record === null) {
    throw new BridgeClientError("PROTOCOL", `POST /execute 返回结构异常（HTTP ${status}）`);
  }
  if (record.success === true) return record.result;
  const message = typeof record.error === "string" ? record.error : "未知错误";
  if (status === 503 || message.toLowerCase().includes("not connected")) {
    throw new BridgeClientError("NOT_CONNECTED", message);
  }
  throw new BridgeClientError("PROTOCOL", message);
}

/** 一次拿到端口 + 健康状态；拿不到时按 python 版语义报 NO_BRIDGE。 */
export async function requireEndpoint(
  options: BridgeDiscoveryOptions = {},
): Promise<BridgeEndpoint> {
  const endpoint = await discover(options);
  if (!endpoint) {
    throw new BridgeClientError(
      "NO_BRIDGE",
      `端口区间 ${options.portFirst ?? BRIDGE_PORT_START}-${options.portLast ?? BRIDGE_PORT_END} 里没有 ${BRIDGE_SERVICE_ID}`,
    );
  }
  return endpoint;
}

/** 确认至少有一个 EDA 窗口连着；否则按 NOT_CONNECTED 报错。 */
export async function requireConnected(
  port: number,
  options: BridgeClientOptions = {},
): Promise<BridgeHealthResponse> {
  const state = await health(port, options);
  if (!state.edaConnected) {
    throw new BridgeClientError("NOT_CONNECTED", "bridge 在跑，但没有 EDA 窗口连接");
  }
  return state;
}

/**
 * 绑定某个端口的客户端对象。方法名与 bridge_client.py 一致：
 * `discover()` 找端口，之后 `health() / windows() / selectWindow() / execute(code, {windowId, timeoutMs})`。
 */
export class BridgeClient {
  readonly port: number;
  readonly host: string;
  private readonly defaultTimeoutMs: number | undefined;

  constructor(port: number, options: BridgeClientOptions = {}) {
    this.port = port;
    this.host = options.host ?? BRIDGE_LISTEN_HOST;
    this.defaultTimeoutMs = options.timeoutMs;
  }

  static async discover(options: BridgeDiscoveryOptions = {}): Promise<BridgeClient | null> {
    const endpoint = await discover(options);
    if (!endpoint) return null;
    return new BridgeClient(endpoint.port, { host: endpoint.host, timeoutMs: options.timeoutMs });
  }

  private options(): BridgeClientOptions {
    return {
      host: this.host,
      ...(this.defaultTimeoutMs ? { timeoutMs: this.defaultTimeoutMs } : {}),
    };
  }

  async health(): Promise<BridgeHealthResponse> {
    return await health(this.port, this.options());
  }

  async windows(): Promise<BridgeWindowsResponse> {
    return await windows(this.port, this.options());
  }

  async selectWindow(windowId: string): Promise<BridgeSelectWindowResponse> {
    return await selectWindow(this.port, windowId, this.options());
  }

  async execute(code: string, options: BridgeExecuteOptions = {}): Promise<unknown> {
    return await execute(this.port, code, {
      host: this.host,
      windowId: options.windowId,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
    });
  }
}
