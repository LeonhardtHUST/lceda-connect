import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import {
  BRIDGE_ALLOWED_ORIGINS_ENV,
  BRIDGE_AUTH_ENV,
  BRIDGE_EDA_PATH,
  BRIDGE_EXECUTE_PATH,
  BRIDGE_HEALTH_PATH,
  BRIDGE_LISTEN_HOST,
  BRIDGE_MAX_BODY_BYTES,
  BRIDGE_MAX_CODE_BYTES,
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_WS_PAYLOAD_BYTES,
  BRIDGE_PORT_END,
  BRIDGE_PORT_START,
  BRIDGE_REQUEST_TIMEOUT_MS,
  BRIDGE_RUNTIME_ENV,
  BRIDGE_SELECT_WINDOW_PATH,
  BRIDGE_SERVICE_ID,
  BRIDGE_TOKEN_ENV,
  BRIDGE_TOKEN_FILE_PREFIX,
  BRIDGE_TOKEN_FILE_SUFFIX,
  BRIDGE_TOKEN_HEADER,
  BRIDGE_WINDOWS_PATH,
  asBridgeMessage,
  rawDataText,
  type BridgeClientType,
  type BridgeExecuteResponse,
  type BridgeHealthResponse,
  type BridgeWindowsResponse,
} from "./protocol.ts";

/**
 * 内置的 EasyEDA AI Bridge 服务。
 *
 * 协议、端口、路径、状态码与 easyeda-api-skill/scripts/bridge-server.mjs 保持一致，
 * 差别只有：状态不再放模块级（测试能反复起停）、日志写到 stderr（交给注入的 logger）、
 * 返回 {port, close()} 而不是直接 process.exit。
 */

export interface BridgeServerHandle {
  /** 实际监听端口（复用已有实例时是那个实例的端口）。 */
  port: number;
  host: string;
  /** true 表示命中已有实例，没有真的启动新服务。 */
  reused: boolean;
  close: () => Promise<void>;
}

export interface BridgeServerOptions {
  host?: string;
  portFirst?: number;
  portLast?: number;
  /** 固定端口，0 表示让系统挑；指定后不再扫描端口区间、也不复用已有实例（测试用）。 */
  port?: number;
  requestTimeoutMs?: number;
  logger?: (line: string) => void;
  /** 启动前先扫区间里有没有同款服务，默认 true；指定 port 时不扫。 */
  reuseExisting?: boolean;
  /** 仅供明确的远程部署使用；CLI 不暴露该开关。 */
  allowRemote?: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  windowId: string;
}

/** 没有任何可用的编辑器窗口 / 目标窗口已断开。HTTP 层要把它映射成 503。 */
class EdaNotConnectedError extends Error {}

function defaultLogger(line: string): void {
  process.stderr.write(`${line}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."))
  );
}

function requestHostMatches(req: IncomingMessage, port: number): boolean {
  const value = req.headers.host?.toLowerCase();
  return (
    value === `127.0.0.1:${port}` || value === `localhost:${port}` || value === `[::1]:${port}`
  );
}

function configuredOrigins(): Set<string> {
  return new Set(
    (process.env[BRIDGE_ALLOWED_ORIGINS_ENV] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

function agentOriginAllowed(origin: string | undefined, allowlist: Set<string>): boolean {
  return origin === undefined || allowlist.has(origin);
}

function edaOriginAllowed(origin: string | undefined, allowlist: Set<string>): boolean {
  if (origin === undefined || origin === "null" || allowlist.has(origin)) return true;
  try {
    const parsed = new URL(origin);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return true;
    const hostname = parsed.hostname.toLowerCase();
    return (
      isLoopbackHost(hostname) ||
      hostname === "lceda.cn" ||
      hostname.endsWith(".lceda.cn") ||
      hostname === "easyeda.com" ||
      hostname.endsWith(".easyeda.com")
    );
  } catch {
    return false;
  }
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const received = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

function authDisabled(): boolean {
  return process.env[BRIDGE_AUTH_ENV]?.toLowerCase() === "off";
}

function unauthorized(res: ServerResponse): void {
  replyJson(res, 401, {
    errorCode: "BRIDGE_UNAUTHORIZED",
    error: "bridge token required (set X-Lceda-Bridge-Token or LCEDA_BRIDGE_AUTH=off)",
  });
}

function forbidden(res: ServerResponse, status = 403): void {
  replyJson(res, status, { error: "Forbidden" });
}

function replyJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

class BodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > BRIDGE_MAX_BODY_BYTES) {
    req.resume();
    throw new BodyTooLargeError("Request body exceeds 4 MiB limit");
  }
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > BRIDGE_MAX_BODY_BYTES) {
        failed = true;
        chunks.length = 0;
        reject(new BodyTooLargeError("Request body exceeds 4 MiB limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.once("error", reject);
    req.once("aborted", () => reject(new Error("Request aborted")));
  });
}

/** 探测端口有没有人在监听（连得上就算占用，不管对面是什么服务）。 */
function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** 端口上是不是已经有一份同款 bridge（除了 /health 正常还要确认 service）。 */
async function isBridgeRunning(port: number, host: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}${BRIDGE_HEALTH_PATH}`, {
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { service?: unknown };
    return data.service === BRIDGE_SERVICE_ID;
  } catch {
    return false;
  }
}

async function findExistingInstance(
  portFirst: number,
  portLast: number,
  host: string,
): Promise<number | null> {
  for (let port = portFirst; port <= portLast; port += 1) {
    if (await isBridgeRunning(port, host)) return port;
  }
  return null;
}

async function findAvailablePort(
  portFirst: number,
  portLast: number,
  host: string,
): Promise<number> {
  for (let port = portFirst; port <= portLast; port += 1) {
    if (!(await isPortInUse(port, host))) return port;
  }
  throw new Error(`端口区间 ${portFirst}-${portLast} 全被占用`);
}

function listenOnce(server: Server, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * 启动 bridge 服务。
 *
 * - 默认先在 49620-49629 里找已有实例，命中就返回 `{ reused: true, close(): 空操作 }`；
 * - 否则从区间第一个空闲端口起监听，HTTP 与 WebSocket 共用同一个 server；
 * - `/eda` 是编辑器端，其它路径是 agent 端。
 */
export async function startBridgeServer(
  options: BridgeServerOptions = {},
): Promise<BridgeServerHandle> {
  const host = options.host ?? BRIDGE_LISTEN_HOST;
  const portFirst = options.portFirst ?? BRIDGE_PORT_START;
  const portLast = options.portLast ?? BRIDGE_PORT_END;
  const requestTimeoutMs = options.requestTimeoutMs ?? BRIDGE_REQUEST_TIMEOUT_MS;
  const logger = options.logger ?? defaultLogger;
  if (!options.allowRemote && !isLoopbackHost(host)) {
    throw new Error(
      `bridge 只能监听回环地址，收到 host=${host}；如确需远程部署请显式 allowRemote=true`,
    );
  }
  const allowlist = configuredOrigins();

  const edaClients = new Map<string, WebSocket>();
  const pendingRequests = new Map<string, PendingRequest>();
  let activeEdaWindowId: string | null = null;
  let actualPort = 0;
  let token = "";
  let tokenFilePath: string | null = null;

  if (options.port === undefined && options.reuseExisting !== false) {
    const existing = await findExistingInstance(portFirst, portLast, host);
    if (existing !== null) {
      logger(`✅ 端口 ${existing} 上已经有 ${BRIDGE_SERVICE_ID} 在跑，不再重复启动。`);
      return { port: existing, host, reused: true, close: async () => {} };
    }
  }

  function sendToEda(windowId: string, msg: unknown): void {
    const client = edaClients.get(windowId);
    if (!client)
      throw new EdaNotConnectedError(`EDA window "${windowId}" not found in connected clients`);
    if (client.readyState !== 1) {
      throw new EdaNotConnectedError(
        `EDA window "${windowId}" is not in connected state (readyState: ${client.readyState})`,
      );
    }
    try {
      client.send(JSON.stringify(msg));
    } catch (error) {
      throw new Error(`Failed to send to EDA window "${windowId}": ${errorMessage(error)}`);
    }
  }

  function executeOnEda(code: string, windowId?: string): Promise<unknown> {
    if (Buffer.byteLength(code, "utf8") > BRIDGE_MAX_CODE_BYTES) {
      return Promise.reject(new Error("BRIDGE_CODE_TOO_LARGE: code exceeds 1 MiB limit"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const targetWindowId = windowId || activeEdaWindowId;
      if (!targetWindowId) {
        reject(
          new EdaNotConnectedError("No EDA window connected. Please connect an EDA window first."),
        );
        return;
      }
      const client = edaClients.get(targetWindowId);
      if (!client || client.readyState !== 1) {
        reject(
          new EdaNotConnectedError(
            `EDA window "${targetWindowId}" is no longer connected. Please select another window.`,
          ),
        );
        return;
      }

      if (pendingRequests.size >= BRIDGE_MAX_PENDING_REQUESTS) {
        reject(new Error("BRIDGE_PENDING_LIMIT: too many pending requests"));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Request ${id} timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);

      pendingRequests.set(id, {
        resolve,
        reject,
        timer,
        windowId: targetWindowId,
      });

      try {
        sendToEda(targetWindowId, {
          type: "execute",
          id,
          code,
          windowId: targetWindowId,
          timestamp: Date.now(),
        });
      } catch (error) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function handleEdaMessage(message: Record<string, unknown>, windowId: string): void {
    if (message.type === "ping") {
      logger(`[WS] Ping received from ${windowId}, sending pong`);
      const client = edaClients.get(windowId);
      if (client && client.readyState === 1) {
        try {
          client.send(JSON.stringify({ type: "pong", id: message.id, timestamp: Date.now() }));
        } catch (error) {
          logger(`[WS] Failed to send pong to ${windowId}: ${errorMessage(error)}`);
        }
      } else {
        logger(`[WS] Cannot send pong: window ${windowId} not found or disconnected`);
      }
      return;
    }

    if (message.type === "pong") {
      logger(`[EDA] Pong received from window ${windowId} - connection healthy`);
      return;
    }

    if (message.type === "result" || message.type === "error") {
      const id = typeof message.id === "string" ? message.id : "";
      const pending = pendingRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRequests.delete(id);
      if (message.type === "result") {
        pending.resolve(message.result);
      } else {
        const text = typeof message.error === "string" ? message.error : "Unknown EDA error";
        pending.reject(new Error(text));
      }
      return;
    }

    logger(`[EDA] Unknown message type: ${String(message.type)} from window: ${windowId}`);
  }

  function registerEdaWindow(windowId: string, client: WebSocket): void {
    const previous = edaClients.get(windowId);
    if (previous && previous !== client) {
      logger(`[WS] EDA window ${windowId} replaced by a new connection`);
    }
    edaClients.set(windowId, client);
    if (edaClients.size === 1 || !activeEdaWindowId) activeEdaWindowId = windowId;
    logger(`[WS] EDA window registered: ${windowId}, total: ${edaClients.size}`);
  }

  function dropEdaWindow(windowId: string, client?: WebSocket): void {
    if (client && edaClients.get(windowId) !== client) return;
    edaClients.delete(windowId);
    if (activeEdaWindowId === windowId) {
      activeEdaWindowId = edaClients.keys().next().value ?? null;
    }
    for (const [id, pending] of pendingRequests) {
      if (pending.windowId !== windowId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(`EDA window "${windowId}" disconnected`));
      pendingRequests.delete(id);
    }
  }

  const httpServer = createServer((req, res) => {
    void handleHttp(req, res).catch((error: unknown) => {
      if (!res.headersSent) replyJson(res, 500, { error: errorMessage(error) });
      else res.end();
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!requestHostMatches(req, actualPort)) {
      replyJson(res, 421, { error: "Misdirected Request" });
      return;
    }

    if (req.method === "OPTIONS") {
      forbidden(res);
      return;
    }

    if (req.method === "GET" && req.url === BRIDGE_HEALTH_PATH) {
      const health: BridgeHealthResponse = {
        service: BRIDGE_SERVICE_ID,
        status: "ok",
        edaConnected: edaClients.size > 0,
        edaWindowCount: edaClients.size,
        activeWindowId: activeEdaWindowId,
        pendingRequests: pendingRequests.size,
        timestamp: Date.now(),
      };
      replyJson(res, 200, health);
      return;
    }

    const origin = req.headers.origin;
    if (!agentOriginAllowed(origin, allowlist)) {
      logger(`[HTTP] Rejected agent Origin: ${origin ?? "(none)"}`);
      forbidden(res);
      return;
    }
    const tokenHeader = req.headers[BRIDGE_TOKEN_HEADER.toLowerCase()];
    const providedToken = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    if (!authDisabled() && !tokenMatches(providedToken, token)) {
      unauthorized(res);
      return;
    }

    if (req.method === "GET" && req.url === BRIDGE_WINDOWS_PATH) {
      const windows: BridgeWindowsResponse = {
        windows: [...edaClients.entries()].map(([windowId, client]) => ({
          windowId,
          connected: client.readyState === 1,
          active: windowId === activeEdaWindowId,
        })),
        activeWindowId: activeEdaWindowId,
        count: edaClients.size,
      };
      replyJson(res, 200, windows);
      return;
    }

    if (req.method === "POST" && req.url === BRIDGE_SELECT_WINDOW_PATH) {
      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          replyJson(res, 413, { error: error.message });
          return;
        }
        replyJson(res, 400, { error: "Invalid request body" });
        return;
      }
      const windowId =
        typeof payload === "object" && payload !== null
          ? (payload as { windowId?: unknown }).windowId
          : undefined;
      if (typeof windowId !== "string" || !edaClients.has(windowId)) {
        replyJson(res, 404, { error: `EDA window "${String(windowId)}" not found` });
        return;
      }
      activeEdaWindowId = windowId;
      replyJson(res, 200, { success: true, activeWindowId: windowId });
      return;
    }

    if (req.method === "POST" && req.url === BRIDGE_EXECUTE_PATH) {
      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          replyJson(res, 413, { error: error.message });
          return;
        }
        replyJson(res, 400, { error: "Invalid request body" });
        return;
      }
      const record =
        typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const code = record.code;
      const windowId = typeof record.windowId === "string" ? record.windowId : undefined;
      if (typeof code !== "string" || code === "") {
        replyJson(res, 400, { error: 'Missing "code" field (string)' });
        return;
      }
      if (Buffer.byteLength(code, "utf8") > BRIDGE_MAX_CODE_BYTES) {
        replyJson(res, 413, { error: "BRIDGE_CODE_TOO_LARGE: code exceeds 1 MiB limit" });
        return;
      }
      try {
        const result = await executeOnEda(code, windowId);
        const body: BridgeExecuteResponse = {
          success: true,
          result,
          windowId: windowId || activeEdaWindowId || undefined,
        };
        replyJson(res, 200, body);
      } catch (error) {
        const message = errorMessage(error);
        const status =
          error instanceof EdaNotConnectedError ||
          message.includes("not connected") ||
          message.startsWith("BRIDGE_PENDING_LIMIT:")
            ? 503
            : 500;
        const body: BridgeExecuteResponse = { success: false, error: message };
        replyJson(res, status, body);
      }
      return;
    }

    replyJson(res, 404, { error: "Not found" });
  }

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: BRIDGE_MAX_WS_PAYLOAD_BYTES,
    verifyClient: ({ req }, done) => {
      if (!requestHostMatches(req, actualPort)) {
        done(false, 421, "Misdirected Request");
        return;
      }
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const isEda = requestUrl.pathname === BRIDGE_EDA_PATH;
      const origin = req.headers.origin;
      if (!(isEda ? edaOriginAllowed(origin, allowlist) : agentOriginAllowed(origin, allowlist))) {
        logger(`[WS] Rejected ${isEda ? "EDA" : "agent"} Origin: ${origin ?? "(none)"}`);
        done(false, 403, "Forbidden Origin");
        return;
      }
      const header = req.headers[BRIDGE_TOKEN_HEADER.toLowerCase()];
      const headerToken = Array.isArray(header) ? header[0] : header;
      const queryToken = requestUrl.searchParams.get("token") ?? undefined;
      if (
        !isEda &&
        !authDisabled() &&
        !tokenMatches(headerToken, token) &&
        !tokenMatches(queryToken, token)
      ) {
        done(false, 401, "BRIDGE_UNAUTHORIZED");
        return;
      }
      done(true);
    },
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const clientType: BridgeClientType = requestUrl.pathname === BRIDGE_EDA_PATH ? "eda" : "agent";
    logger(`[WS] New ${clientType} connection from ${req.socket.remoteAddress ?? "?"}`);

    ws.send(
      JSON.stringify({
        type: "handshake",
        service: BRIDGE_SERVICE_ID,
        clientType,
        timestamp: Date.now(),
      }),
    );

    if (clientType === "eda") {
      let registeredWindowId: string | null = null;

      ws.on("message", (raw) => {
        try {
          const message = asBridgeMessage(JSON.parse(rawDataText(raw)));
          if (!message) return;
          if (
            message.type === "register" &&
            typeof message.windowId === "string" &&
            message.windowId
          ) {
            registeredWindowId = message.windowId;
            registerEdaWindow(message.windowId, ws);
            return;
          }
          handleEdaMessage(message, registeredWindowId ?? "unregistered");
        } catch (error) {
          logger(`[WS] Failed to parse EDA message: ${errorMessage(error)}`);
        }
      });

      ws.on("close", (code, reason) => {
        logger(
          `[WS] EDA window disconnected: ${registeredWindowId ?? "?"} (${code} ${reason.toString()})`,
        );
        if (registeredWindowId) dropEdaWindow(registeredWindowId);
      });

      ws.on("error", (error: Error) => {
        logger(`[WS] EDA client error: ${error.message}`);
      });
      return;
    }

    ws.on("message", (raw) => {
      void (async (): Promise<void> => {
        try {
          const message = asBridgeMessage(JSON.parse(rawDataText(raw)));
          if (!message) return;
          if (message.type === "execute") {
            const code = typeof message.code === "string" ? message.code : "";
            const windowId = typeof message.windowId === "string" ? message.windowId : undefined;
            if (Buffer.byteLength(code, "utf8") > BRIDGE_MAX_CODE_BYTES) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  id: message.id,
                  error: "BRIDGE_CODE_TOO_LARGE: code exceeds 1 MiB limit",
                  timestamp: Date.now(),
                }),
              );
              return;
            }
            try {
              const result = await executeOnEda(code, windowId);
              ws.send(
                JSON.stringify({ type: "result", id: message.id, result, timestamp: Date.now() }),
              );
            } catch (error) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  id: message.id,
                  error: errorMessage(error),
                  timestamp: Date.now(),
                }),
              );
            }
          } else if (message.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", id: message.id, timestamp: Date.now() }));
          }
        } catch (error) {
          logger(`[WS] Failed to parse agent message: ${errorMessage(error)}`);
        }
      })();
    });

    ws.on("close", () => {
      logger("[WS] Agent client disconnected");
    });
  });

  const candidates: number[] = [];
  if (options.port === undefined) {
    const available = await findAvailablePort(portFirst, portLast, host);
    for (let port = available; port <= portLast; port += 1) candidates.push(port);
  } else {
    candidates.push(options.port);
  }

  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      actualPort = await listenOnce(httpServer, candidate, host);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        await new Promise<void>((resolve) => {
          wss.close(() => resolve());
        });
        throw lastError;
      }
    }
  }

  if (actualPort === 0) {
    throw lastError ?? new Error(`端口区间 ${portFirst}-${portLast} 全被占用`);
  }

  token = process.env[BRIDGE_TOKEN_ENV]?.trim() || randomBytes(32).toString("hex");
  const runtimeDir =
    process.env[BRIDGE_RUNTIME_ENV] ??
    path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"),
      "lceda-bridge",
    );
  tokenFilePath = path.join(
    runtimeDir,
    `${BRIDGE_TOKEN_FILE_PREFIX}${actualPort}${BRIDGE_TOKEN_FILE_SUFFIX}`,
  );
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(tokenFilePath, `${token}\n`, { encoding: "utf8", mode: 0o600 });

  logger(
    [
      "",
      "╔══════════════════════════════════════════════════════════════╗",
      "║         EasyEDA WebSocket Bridge Server（内置）              ║",
      "╠══════════════════════════════════════════════════════════════╣",
      `  端口        : ${actualPort}`,
      `  监听地址    : ${host} (localhost only)`,
      `  端口区间    : ${portFirst}-${portLast}`,
      `  Service ID  : ${BRIDGE_SERVICE_ID}`,
      `  HTTP API    : http://localhost:${actualPort}`,
      `  WS (EDA)    : ws://localhost:${actualPort}${BRIDGE_EDA_PATH}`,
      `  WS (Agent)  : ws://localhost:${actualPort}/agent`,
      "  Endpoints   : GET /health · GET /eda-windows",
      "                POST /eda-windows/select · POST /execute",
      "╚══════════════════════════════════════════════════════════════╝",
      "",
    ].join("\n"),
  );

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("bridge server closed"));
    }
    pendingRequests.clear();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    const done = new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    httpServer.closeAllConnections();
    await done;
    if (tokenFilePath) {
      try {
        await unlink(tokenFilePath);
      } catch {
        // token 文件可能已由外部清理
      }
    }
  }

  return { port: actualPort, host, reused: false, close };
}
