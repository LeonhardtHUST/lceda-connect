import { ToolError } from "../mcp/types.ts";
import { CdpError } from "./errors.ts";
import { DEFAULT_CDP_PORT, requireLoopbackHost } from "./discover.ts";
import { WsClient } from "./wsClient.ts";

export const DEFAULT_CDP_TIMEOUT_MS = 20_000;

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
  signal?: AbortSignal;
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
  private readonly signal: AbortSignal | undefined;
  private nextId = 1;
  private closed = false;
  private failure: CdpError | null = null;

  private constructor(ws: WsClient, timeoutMs: number, signal?: AbortSignal) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
  }

  static async connect(wsUrl: string, options: CdpSessionOptions = {}): Promise<CdpSession> {
    if (options.signal?.aborted) throw new ToolError("CANCELLED", "CDP 请求已取消");
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
      signal: options.signal,
    });
    return new CdpSession(ws, timeoutMs, options.signal);
  }

  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const activeSignal =
      signal && this.signal ? AbortSignal.any([signal, this.signal]) : (signal ?? this.signal);
    if (activeSignal?.aborted) throw new ToolError("CANCELLED", "CDP 请求已取消");
    if (this.closed) throw new CdpError("WS_CLOSED", "CDP 会话已关闭");
    if (this.failure) throw this.failure;
    const id = this.nextId;
    this.nextId += 1;
    const timer = setTimeout(() => {
      this.failure = new CdpError(
        "CDP_TIMEOUT",
        `CDP 调用超时（${this.timeoutMs}ms）：${method}；可用环境变量 EASYEDA_CDP_TIMEOUT 放宽`,
        { exitCode: 4 },
      );
      this.ws.close();
    }, this.timeoutMs);
    timer.unref();
    const onAbort = (): void => this.ws.close();
    activeSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (activeSignal?.aborted) throw new ToolError("CANCELLED", "CDP 请求已取消");
      this.ws.sendText(JSON.stringify({ id, method, params }));
      for (;;) {
        const message = parseResponse(await this.ws.recvText(activeSignal));
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
      if (activeSignal?.aborted) throw new ToolError("CANCELLED", "CDP 请求已取消");
      if (this.failure) throw this.failure;
      if (error instanceof CdpError || error instanceof ToolError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new CdpError("CDP_PROTOCOL", `CDP 传输失败：${message}`, { cause: error });
    } finally {
      clearTimeout(timer);
      activeSignal?.removeEventListener("abort", onAbort);
    }
  }

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
