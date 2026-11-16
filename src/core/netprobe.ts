import { run } from "./exec.ts";
import type { BridgeHealth, CdpInfo, TcpListener } from "./types.ts";

/**
 * 解析 `netstat -ano` 输出，挑出端口区间内的 LISTENING 行。
 * 兼容 IPv4 与 IPv6（`[::]:49620`）两种地址写法。
 */
export function parseNetstat(text: string, portFirst: number, portLast: number): TcpListener[] {
  const found: TcpListener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!match) continue;
    const port = Number.parseInt(match[1] ?? "", 10);
    const pid = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
    if (port < portFirst || port > portLast) continue;
    found.push({ port, pid });
  }
  found.sort((left, right) => left.port - right.port || left.pid - right.pid);
  return found.filter((item, index) => {
    const previous = found[index - 1];
    return !previous || previous.port !== item.port || previous.pid !== item.pid;
  });
}

export async function listListeners(portFirst: number, portLast: number): Promise<TcpListener[]> {
  const result = await run("netstat.exe", ["-ano"], { timeoutMs: 15_000 });
  if (result.code !== 0) return [];
  return parseNetstat(result.stdout, portFirst, portLast);
}

/** `DevToolsActivePort` 文件首行就是端口号。 */
export function parseDevToolsActivePort(text: string): number {
  const first = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (!first) return 0;
  const port = Number.parseInt(first, 10);
  return Number.isFinite(port) && port > 0 ? port : 0;
}

export async function probeHttpJson<T>(url: string, timeoutMs = 2500): Promise<T | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      // 本地探测不应该被系统代理接管
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** CDP 端点探测：`GET /json/version`。 */
export async function probeCdpVersion(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 2500,
): Promise<CdpInfo | null> {
  if (port <= 0) return null;
  const info = await probeHttpJson<CdpInfo>(`http://${host}:${port}/json/version`, timeoutMs);
  if (!info || typeof info !== "object") return null;
  return typeof info.Browser === "string" && info.Browser !== "" ? info : null;
}

/**
 * bridge 健康检查：本地探测抖动很常见，重试几次再判定「无响应」，避免状态误报。
 */
export async function probeHealth(
  port: number,
  host = "127.0.0.1",
  attempts = 3,
): Promise<BridgeHealth | null> {
  if (port <= 0) return null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const health = await probeHttpJson<BridgeHealth>(`http://${host}:${port}/health`, 2500);
    if (health && typeof health === "object") return health;
    if (attempt < attempts) {
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
  }
  return null;
}
