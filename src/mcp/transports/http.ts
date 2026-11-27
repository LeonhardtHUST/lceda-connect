import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../../core/config.ts";
import { isLoopbackAddress } from "../../core/environment.ts";
import { packageVersion } from "../../core/version.ts";
import { createServerFactory, SERVER_NAME } from "../server.ts";
import type { TransportHandle, TransportStartOptions } from "./types.ts";

/**
 * MCP Streamable HTTP 传输（2025-03-26 规范）。
 *
 * 默认只监听 127.0.0.1；要跨 WSL/宿主访问必须显式 `--host`（建议只绑 WSL 虚拟网卡
 * 地址，不要 0.0.0.0）。可选 `--token` 要求 Authorization: Bearer。
 * 规范要求：Host/Origin 校验、未知 session 返回 404、无 SSE 能力时对 GET 返回 405、
 * 请求体超限返回 413（连接不 reset）。`/health` 只返回非敏感状态。
 */

export interface HttpTransportOptions extends TransportStartOptions {
  /** 监听地址；默认 127.0.0.1。 */
  host?: string;
  /** 监听端口；默认 3939，0 表示随机端口。 */
  port?: number;
  /** MCP 端点路径；默认 /mcp。 */
  path?: string;
  /** 可选的 Bearer token。 */
  token?: string;
  /** 无状态模式：每个 POST 独立 server，不下发 session id。 */
  stateless?: boolean;
  /** 诊断日志出口，默认 stderr。 */
  log?: (line: string) => void;
}

export interface HttpTransportHandle extends TransportHandle {
  kind: "http";
  url: string;
  host: string;
  port: number;
  path: string;
}

const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 3939;
export const DEFAULT_HTTP_PATH = "/mcp";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** 空闲会话回收时间；SDK 的 close 不会自动 DELETE，常驻服务必须自己收。 */
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 64;
const SESSION_SWEEP_MS = 60 * 1000;
const TRUSTED_LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

function normalizePath(value: string | undefined): string {
  const raw = (value ?? DEFAULT_HTTP_PATH).trim() || DEFAULT_HTTP_PATH;
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

function hostnameOf(hostHeader: string | undefined): string {
  const value = (hostHeader ?? "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end >= 0 ? value.slice(0, end + 1) : value;
  }
  return value.split(":")[0] ?? "";
}

function ipv4Literal(name: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(name);
}

function ipv6Literal(name: string): boolean {
  const inner = name.replace(/^\[|\]$/g, "");
  return inner.includes(":") && /^[0-9a-f:.%]+$/i.test(inner);
}

/** Host 头校验：只接受回环与显式绑定地址，降低 DNS rebinding 风险。 */
export function isAllowedHostHeader(hostHeader: string | undefined, bindHost: string): boolean {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  const allowed = new Set(TRUSTED_LOOPBACK);
  const bind = bindHost.trim().toLowerCase();
  if (bind && bind !== "0.0.0.0" && bind !== "::") {
    allowed.add(bind.replace(/^\[|\]$/g, ""));
    return allowed.has(name);
  }
  // 通配地址：允许回环、IPv4/IPv6 字面量，拒绝域名，降低 DNS rebinding 面。
  if (allowed.has(name)) return true;
  return ipv4Literal(name) || ipv6Literal(name);
}

/** Origin 校验（规范 Security Warning 要求 MUST）。没有 Origin 的本地客户端放行。 */
export function isAllowedOrigin(origin: string | undefined, bindHost: string): boolean {
  if (origin === undefined || origin.trim() === "") return true;
  if (origin.trim().toLowerCase() === "null") return false;
  try {
    const url = new URL(origin);
    return isAllowedHostHeader(url.host, bindHost);
  } catch {
    return false;
  }
}

function jsonResponse(res: ServerResponse, status: number, payload: unknown, headers = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function bearerOf(header: string | undefined): string | null {
  const match = /^bearer\s+(.+)$/i.exec((header ?? "").trim());
  return match?.[1] ?? null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function authOk(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const presented = bearerOf(req.headers.authorization);
  return presented !== null && constantTimeEqual(presented, token);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return; // 继续消费剩余数据，避免直接 reset 让 413 发不出去
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new Error("BODY_TOO_LARGE"));
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("BAD_JSON"));
      }
    });
    req.on("error", reject);
  });
}

export async function startHttpTransport(
  options: HttpTransportOptions,
): Promise<HttpTransportHandle> {
  const env = options.env;
  const host = (options.host ?? DEFAULT_HTTP_HOST).trim() || DEFAULT_HTTP_HOST;
  const port = options.port ?? DEFAULT_HTTP_PORT;
  const mcpPath = normalizePath(options.path);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const serverFactory = options.serverFactory ?? createServerFactory(options);
  const sessions = new Map<string, SessionEntry>();
  const stateless = options.stateless === true;
  let actualPort = port;

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`HTTP 端口不合法：${port}`);
  }
  // 防呆：非回环绑定必须有鉴权，避免一个参数失误就把 MCP 暴露到虚拟网卡/局域网。
  if (!isLoopbackAddress(host) && !options.token) {
    throw new Error(
      "绑定非回环地址必须提供 Bearer token（--token / LCEDA_HTTP_TOKEN / 配置 mcp.http.token）",
    );
  }
  if (!isLoopbackAddress(host) && host !== "0.0.0.0" && host !== "::") {
    log(
      `[${SERVER_NAME}] 警告：HTTP MCP 绑定在非回环地址 ${host}；请仅绑定 WSL 虚拟网卡地址，并考虑加 --token`,
    );
  }

  const closeEntry = async (entry: SessionEntry): Promise<void> => {
    try {
      await entry.transport.close();
    } catch {
      // 已关闭的会话忽略
    }
    try {
      await entry.server.close();
    } catch {
      // 同上
    }
  };

  const evictOldest = async (): Promise<void> => {
    const first = sessions.entries().next();
    if (first.done) return;
    const [sessionId, entry] = first.value;
    sessions.delete(sessionId);
    await closeEntry(entry);
    log(`[${SERVER_NAME}] 会话数达到上限 ${MAX_SESSIONS}，已回收最早会话 ${sessionId}`);
  };

  const buildSession = async (): Promise<SessionEntry> => {
    if (!stateless && sessions.size >= MAX_SESSIONS) await evictOldest();
    const server = serverFactory();
    let entry: SessionEntry | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: stateless ? undefined : () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        if (entry) {
          entry.lastSeen = Date.now();
          sessions.set(sessionId, entry);
        }
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    await server.connect(transport);
    entry = { transport, server, lastSeen: Date.now() };
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) sessions.delete(sessionId);
    };
    return entry;
  };

  /** 常驻服务的会话回收：客户端 close() 不会发 DELETE，只能按空闲时间收。 */
  const sweeper = stateless
    ? null
    : setInterval(() => {
        const now = Date.now();
        for (const [sessionId, entry] of sessions) {
          if (now - entry.lastSeen > SESSION_IDLE_TTL_MS) {
            sessions.delete(sessionId);
            void closeEntry(entry);
            log(`[${SERVER_NAME}] 会话 ${sessionId} 空闲超时，已回收`);
          }
        }
      }, SESSION_SWEEP_MS);
  sweeper?.unref();

  const httpServer: Server = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
      if (url.pathname === "/health") {
        if (!isAllowedHostHeader(req.headers.host, host)) {
          jsonResponse(res, 403, { error: "forbidden_host" });
          return;
        }
        const cfg = loadConfig(env);
        jsonResponse(res, 200, {
          status: "ok",
          name: SERVER_NAME,
          version: packageVersion(),
          transport: "streamable-http",
          host,
          port: actualPort,
          path: mcpPath,
          stateless,
          sessions: sessions.size,
          environment: {
            kind: cfg.environment.kind,
            hostOs: cfg.environment.hostOs,
            networkingMode: cfg.environment.networkingMode,
            clientLocations: cfg.environment.clientLocations,
          },
        });
        return;
      }
      if (url.pathname !== mcpPath) {
        jsonResponse(res, 404, { error: "not_found", path: url.pathname, mcpPath });
        return;
      }
      if (!isAllowedHostHeader(req.headers.host, host)) {
        jsonResponse(res, 403, { error: "forbidden_host", host: req.headers.host ?? null });
        return;
      }
      if (!isAllowedOrigin(req.headers.origin, host)) {
        jsonResponse(res, 403, { error: "forbidden_origin", origin: req.headers.origin ?? null });
        return;
      }
      if (!authOk(req, options.token)) {
        jsonResponse(
          res,
          401,
          { error: "unauthorized" },
          { "www-authenticate": 'Bearer realm="lceda-connect"' },
        );
        return;
      }

      const rawSessionId = req.headers["mcp-session-id"];
      const sessionHeader = typeof rawSessionId === "string" ? rawSessionId : undefined;

      if (req.method === "POST") {
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (error) {
          const code = error instanceof Error ? error.message : String(error);
          jsonResponse(res, code === "BODY_TOO_LARGE" ? 413 : 400, { error: code.toLowerCase() });
          return;
        }
        if (stateless) {
          const entry = await buildSession();
          try {
            await entry.transport.handleRequest(req, res, body);
          } finally {
            await closeEntry(entry);
          }
          return;
        }
        if (sessionHeader) {
          const entry = sessions.get(sessionHeader);
          if (!entry) {
            jsonResponse(res, 404, {
              jsonrpc: "2.0",
              error: { code: -32_000, message: "Session not found" },
              id: null,
            });
            return;
          }
          entry.lastSeen = Date.now();
          await entry.transport.handleRequest(req, res, body);
          return;
        }
        if (isInitializeRequest(body)) {
          const entry = await buildSession();
          await entry.transport.handleRequest(req, res, body);
          return;
        }
        jsonResponse(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32_000, message: "Bad Request: No valid session ID" },
          id: null,
        });
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (stateless) {
          res.setHeader("allow", "POST");
          jsonResponse(res, 405, { error: "method_not_allowed" });
          return;
        }
        if (!sessionHeader) {
          jsonResponse(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32_000, message: "Missing session ID" },
            id: null,
          });
          return;
        }
        const entry = sessions.get(sessionHeader);
        if (!entry) {
          jsonResponse(res, 404, {
            jsonrpc: "2.0",
            error: { code: -32_000, message: "Session not found" },
            id: null,
          });
          return;
        }
        entry.lastSeen = Date.now();
        await entry.transport.handleRequest(req, res);
        if (req.method === "DELETE") {
          sessions.delete(sessionHeader);
          await closeEntry(entry);
        }
        return;
      }

      res.setHeader("allow", "GET, POST, DELETE");
      jsonResponse(res, 405, { error: "method_not_allowed" });
    })().catch((error: unknown) => {
      log(
        `[${SERVER_NAME}] HTTP 请求处理失败：${error instanceof Error ? error.message : String(error)}`,
      );
      if (!res.headersSent) jsonResponse(res, 500, { error: "internal_error" });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  actualPort = typeof address === "object" && address !== null ? address.port : port;
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const displayHostForUrl = displayHost.includes(":") ? `[${displayHost}]` : displayHost;
  const url = `http://${displayHostForUrl}:${actualPort}${mcpPath}`;
  log(
    `[${SERVER_NAME}] HTTP MCP 已监听 ${host}:${actualPort}（端点 ${mcpPath}，${stateless ? "无状态" : `有状态，空闲 ${Math.round(SESSION_IDLE_TTL_MS / 60_000)} 分钟后回收`}${options.token ? "，需要 Bearer token" : ""}）`,
  );
  log(`[${SERVER_NAME}] 本机客户端: ${url}`);
  if (isLoopbackAddress(host)) {
    log(
      `[${SERVER_NAME}] 提示：只绑回环时 WSL/其它命名空间不可达；跨 WSL 请用 --host <WSL 虚拟网卡地址> 或 --host wsl`,
    );
  }

  return {
    kind: "http",
    url,
    host,
    port: actualPort,
    path: mcpPath,
    close: async () => {
      if (sweeper) clearInterval(sweeper);
      for (const entry of sessions.values()) await closeEntry(entry);
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/** 兼容旧函数名（内部调用已改用 startHttpTransport）。 */
export const startHttpServer = startHttpTransport;
