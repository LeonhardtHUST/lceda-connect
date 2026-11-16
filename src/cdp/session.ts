import { CdpError } from "./errors.ts";
import { DEFAULT_CDP_PORT, requireLoopbackHost } from "./discover.ts";
import { WsClient } from "./wsClient.ts";

/**
 * 一条绑在单个 target 上的 CDP 会话：按 id 匹配响应，error 抛错，超时可调。
 *
 * 超时口径沿用源仓库：环境变量 `EASYEDA_CDP_TIMEOUT`（秒，默认 20）。
 * 长求值（一次性爬菜单、批量读图元）会超过 20 秒，调用方自己放宽即可。
 */

export const DEFAULT_CDP_TIMEOUT_MS = 20_000;

/** 从环境变量读超时（秒 → 毫秒）；非法值退回 20 秒。 */
export function cdpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EASYEDA_CDP_TIMEOUT;
  if (!raw) return DEFAULT_CDP_TIMEOUT_MS;
  const seconds = Number.parseFloat(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_CDP_TIMEOUT_MS;
  return Math.round(seconds * 1000);
}

export interface CdpSessionOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface CdpResponse {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  [key: string]: unknown;
}

export class CdpSession {
  private readonly ws: WsClient;
  private readonly timeoutMs: number;
  private nextId = 1;
  private closed = false;
  private failure: CdpError | null = null;

  private constructor(ws: WsClient, timeoutMs: number) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
  }

  /**
   * 用 `/json/list` 给的 `webSocketDebuggerUrl` 建会话。
   * 只接受 ws:// 回环地址——源仓库的硬边界，不做 TLS、不连别的机器。
   */
  static async connect(wsUrl: string, options: CdpSessionOptions = {}): Promise<CdpSession> {
    let url: URL;
    try {
      url = new URL(wsUrl);
    } catch {
      throw new CdpError("WS_PROTOCOL", `WebSocket 地址不合法：${wsUrl}`, { exitCode: 4 });
    }
    if (url.protocol !== "ws:") {
      throw new CdpError(
        "WS_PROTOCOL",
        `只支持 ws:// 回环地址，收到 ${url.protocol}//${url.host}`,
        { exitCode: 3 },
      );
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    requireLoopbackHost(host);
    const port = url.port ? Number.parseInt(url.port, 10) : DEFAULT_CDP_PORT;
    const timeoutMs = options.timeoutMs ?? cdpTimeoutMs(options.env ?? process.env);
    const ws = await WsClient.connect({
      host,
      port,
      path: `${url.pathname}${url.search}`,
      timeoutMs,
    });
    return new CdpSession(ws, timeoutMs);
  }

  /** 调用一个 CDP 方法并返回 result；错误响应抛 `CDP_ERROR`。 */
  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.closed) throw new CdpError("WS_CLOSED", "CDP 会话已关闭");
    if (this.failure) throw this.failure;

    const id = this.nextId;
    this.nextId += 1;

    const timer = setTimeout(() => {
      const error = new CdpError(
        "CDP_TIMEOUT",
        `CDP 调用超时（${this.timeoutMs}ms）：${method}；可用环境变量 EASYEDA_CDP_TIMEOUT 放宽`,
        { exitCode: 4 },
      );
      this.failure = error;
      this.ws.close();
    }, this.timeoutMs);
    timer.unref();

    try {
      this.ws.sendText(JSON.stringify({ id, method, params }));
      for (;;) {
        const message = parseResponse(await this.ws.recvText());
        // 事件（没有 id）和别的请求的响应直接跳过，CDP 允许交错下发。
        if (message.id !== id) continue;
        if (message.error) {
          throw new CdpError(
            "CDP_ERROR",
            `CDP 调用失败 ${method}：${message.error.message ?? JSON.stringify(message.error)}`,
            { details: message.error },
          );
        }
        return (message.result ?? {}) as T;
      }
    } catch (error) {
      if (this.failure) throw this.failure;
      if (error instanceof CdpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new CdpError("CDP_PROTOCOL", `CDP 传输失败：${message}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 关闭会话；重复调用无害。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

function parseResponse(raw: string): CdpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CdpError("CDP_PROTOCOL", `CDP 返回的不是 JSON：${raw.slice(0, 120)}`, {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CdpError("CDP_PROTOCOL", "CDP 返回的 JSON 不是对象");
  }
  return parsed as CdpResponse;
}
