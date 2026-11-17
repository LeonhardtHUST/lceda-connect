import fs from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "vite-plus/test";

import {
  Board,
  detectState,
  judgeState,
  modalDetail,
  normalizeState,
  topModal,
  type EditorState,
} from "../src/cdp/board.ts";
import { runCdpClientCommand } from "../src/cdp/cli.ts";
import { parseDevToolsActivePortRecord } from "../src/commands/cdp.ts";
import {
  DEFAULT_CDP_HOST,
  browserUuid,
  discover,
  endpointUrl,
  isLoopbackHost,
  looksLikeCdp,
  parseDevToolsActivePortText,
  parsePortRange,
  profileRoots,
  readDevToolsActivePorts,
  requireLoopbackHost,
  resolveEndpoint,
  versionWebSocketUrl,
} from "../src/cdp/discover.ts";
import {
  DocumentError,
  listDocuments,
  openDocument,
  selectDocument,
  type ApiBoard,
  type DocumentInfo,
} from "../src/cdp/docs.ts";
import { CdpError } from "../src/cdp/errors.ts";
import { CdpSession } from "../src/cdp/session.ts";
import { EvalError, evaluateInContext, planEval } from "../src/cdp/eval.ts";
import {
  BUTTON_KINDS,
  CLICK_MODAL_BUTTON_JS,
  DETECT_JS,
  MODAL_FIELDS,
  MODAL_PROBE_JS,
  STATE_KEYS,
  clickModalButtonExpression,
} from "../src/cdp/modalProbe.ts";
import { PageSelectionError, pickPage } from "../src/cdp/pickPage.ts";
import { redact, redactDeep } from "../src/cdp/redact.ts";
import { screenshotToFile } from "../src/cdp/screenshot.ts";
import { SIDE_EFFECT_PATTERNS, hasSideEffects } from "../src/cdp/sideEffects.ts";
import { listTargets } from "../src/cdp/targets.ts";
import { UiShellError, uiShellProbeExpression, uiShellVerdict } from "../src/cdp/uiShell.ts";
import {
  WS_OPCODE,
  WsClient,
  WsFrameParser,
  decodeWsFrame,
  encodeWsFrame,
  maskPayload,
  webSocketAccept,
} from "../src/cdp/wsClient.ts";
import { parseDevToolsActivePort } from "../src/core/netprobe.ts";
import { createMemoryIo } from "../src/core/io.ts";
import { loadConfig } from "../src/core/config.ts";
import { cdpTools } from "../src/cdp/mcpTools.ts";
import { createServer, invokeTool } from "../src/mcp/server.ts";

// 全部用本地假 CDP 服务与纯函数，不依赖真实立创EDA，也不碰真实进程。

const FAKE_UUID = "fake-browser-uuid";
const FAKE_TARGETS = [
  {
    id: "PAGE-1",
    type: "page",
    title: "工程 A - 立创EDA专业版",
    url: "https://client/editor?token=SECRET-TOKEN",
  },
  { id: "IFRAME-1", type: "iframe", title: "passport", url: "https://passport/login" },
  { id: "WORKER-1", type: "worker", title: "", url: "" },
];

interface FakeCdpOptions {
  /** 把 Runtime.evaluate 的响应拆成两个分片。 */
  fragmentResponses?: boolean;
  /** 响应前先发一个 ping，验证客户端会回 pong。 */
  pingBeforeResponse?: boolean;
  /** Runtime.evaluate 不响应，用于测超时。 */
  ignoreEvaluate?: boolean;
  /** 顶层 UI 探测返回的挂载点。 */
  uiMarkers?: string[];
}

interface FakeCdpServer {
  port: number;
  close: () => Promise<void>;
  pongCount: () => number;
  evaluateCount: () => number;
}

function evaluateReply(
  id: number,
  expression: string,
  options: FakeCdpOptions,
): Record<string, unknown> {
  if (expression === "1+1") {
    return { id, result: { result: { type: "number", value: 2 } } };
  }
  if (expression.includes("canvas-work-space")) {
    return {
      id,
      result: {
        result: {
          type: "object",
          value: {
            ui_shell: true,
            markers: options.uiMarkers ?? ["#main", "#top-wrap"],
            marker_total: 4,
            href: "https://client/editor?token=SECRET",
            ready_state: "complete",
            modal_like: 0,
            ext_api: true,
          },
        },
      },
    };
  }
  if (expression.includes("document.title")) {
    return { id, result: { result: { type: "string", value: "Fake EDA" } } };
  }
  if (expression.includes("getAllNets")) {
    return { id, result: { result: { type: "string", value: '[{"name":"GND"}]' } } };
  }
  if (expression.includes("_EXTAPI_ROOT_")) {
    return { id, result: { result: { type: "number", value: 42 } } };
  }
  if (expression.includes("throw-me")) {
    return {
      id,
      result: {
        exceptionDetails: {
          text: "Uncaught",
          exception: { description: "Error: throw-me" },
        },
      },
    };
  }
  return { id, result: { result: { type: "object", value: null } } };
}

async function startFakeCdp(options: FakeCdpOptions = {}): Promise<FakeCdpServer> {
  let pongCount = 0;
  let evaluateCount = 0;
  let serverPort = 0;
  const sockets = new Set<Socket>();

  const server = http.createServer((request, response) => {
    if (request.url === "/json/version") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          Browser: "Chrome/146.0.7680.178",
          "Protocol-Version": "1.3",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/41.2.1 JLCEDAPro/4.1.78",
          "V8-Version": "14.6",
          webSocketDebuggerUrl: `ws://127.0.0.1:${serverPort}/devtools/browser/${FAKE_UUID}`,
        }),
      );
      return;
    }
    if (request.url === "/json/list") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          FAKE_TARGETS.map((target) => ({
            ...target,
            webSocketDebuggerUrl:
              target.id === "PAGE-1"
                ? `ws://127.0.0.1:${serverPort}/devtools/page/PAGE-1`
                : undefined,
          })),
        ),
      );
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });

  server.on("upgrade", (request, socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const key = String(request.headers["sec-websocket-key"] ?? "");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${webSocketAccept(key)}\r\n\r\n`,
    );

    const parser = new WsFrameParser();
    const sendText = (text: string): void => {
      const payload = Buffer.from(text, "utf8");
      if (!options.fragmentResponses) {
        socket.write(encodeWsFrame(WS_OPCODE.text, payload));
        return;
      }
      const half = Math.max(1, Math.floor(payload.length / 2));
      socket.write(encodeWsFrame(WS_OPCODE.text, payload.subarray(0, half), { fin: false }));
      socket.write(encodeWsFrame(WS_OPCODE.continuation, payload.subarray(half), { fin: true }));
    };

    socket.on("data", (chunk: Buffer) => {
      parser.push(chunk);
      for (;;) {
        const frame = parser.next();
        if (!frame) break;
        if (frame.opcode === WS_OPCODE.pong) {
          pongCount += 1;
          continue;
        }
        if (frame.opcode !== WS_OPCODE.text) continue;
        const request2 = JSON.parse(frame.payload.toString("utf8")) as {
          id: number;
          method: string;
          params?: { expression?: string; format?: string };
        };
        if (request2.method === "Page.enable") {
          sendText(JSON.stringify({ id: request2.id, result: {} }));
          continue;
        }
        if (request2.method === "Page.getFrameTree") {
          sendText(
            JSON.stringify({
              id: request2.id,
              result: {
                frameTree: {
                  frame: { id: "MAIN", name: "", url: "https://client/editor" },
                  childFrames: [
                    {
                      frame: {
                        id: "CHILD",
                        name: "pcb",
                        url: "https://client/pcb?token=SECRET",
                      },
                    },
                  ],
                },
              },
            }),
          );
          continue;
        }
        if (request2.method === "Page.captureScreenshot") {
          sendText(
            JSON.stringify({
              id: request2.id,
              result: { data: Buffer.from("fake-png-bytes").toString("base64") },
            }),
          );
          continue;
        }
        if (request2.method === "Runtime.evaluate") {
          evaluateCount += 1;
          if (options.ignoreEvaluate) continue;
          if (options.pingBeforeResponse) {
            socket.write(encodeWsFrame(WS_OPCODE.ping, Buffer.from("hb")));
          }
          sendText(
            JSON.stringify(evaluateReply(request2.id, request2.params?.expression ?? "", options)),
          );
          continue;
        }
        sendText(JSON.stringify({ id: request2.id, result: {} }));
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, DEFAULT_CDP_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("假 CDP 服务没有拿到端口");
  serverPort = address.port;

  return {
    port: serverPort,
    pongCount: () => pongCount,
    evaluateCount: () => evaluateCount,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function catchError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

// ─── WebSocket 帧 ────────────────────────────────────────────────────

test("WebSocket 帧编码：小帧头与掩码往返", () => {
  const plain = encodeWsFrame(WS_OPCODE.text, Buffer.from("hi", "utf8"));
  expect([...plain]).toEqual([0x81, 0x02, 0x68, 0x69]);

  const maskKey = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const frame = encodeWsFrame(WS_OPCODE.text, Buffer.from("hello", "utf8"), {
    mask: true,
    maskKey,
  });
  expect(frame[0]).toBe(0x81);
  // 0x80（掩码位）+ 5 字节长度
  expect(frame[1]).toBe(0x85);
  expect([...frame.subarray(2, 6)]).toEqual([...maskKey]);
  expect(maskPayload(maskPayload(Buffer.from("hello"), maskKey), maskKey).toString()).toBe("hello");

  const decoded = decodeWsFrame(frame);
  expect(decoded).not.toBeNull();
  expect(decoded?.frame.fin).toBe(true);
  expect(decoded?.frame.opcode).toBe(WS_OPCODE.text);
  expect(decoded?.frame.payload.toString("utf8")).toBe("hello");
  expect(decoded?.rest.length).toBe(0);
});

test("WebSocket 帧编码：126 与 127 扩展长度、半包与分片", () => {
  const medium = Buffer.alloc(200, 0x41);
  const mediumFrame = encodeWsFrame(WS_OPCODE.text, medium);
  expect(mediumFrame[1]).toBe(126);
  expect(mediumFrame.readUInt16BE(2)).toBe(200);
  expect(decodeWsFrame(mediumFrame)?.frame.payload.equals(medium)).toBe(true);

  const large = Buffer.alloc(70_000, 0x42);
  const largeFrame = encodeWsFrame(WS_OPCODE.binary, large, { mask: true });
  expect(largeFrame[1]).toBe(0x80 | 127);
  expect(Number(largeFrame.readBigUInt64BE(2))).toBe(70_000);
  expect(decodeWsFrame(largeFrame)?.frame.payload.equals(large)).toBe(true);

  // 半包：帧头都没收全时返回 null
  expect(decodeWsFrame(mediumFrame.subarray(0, 3))).toBeNull();
  const parser = new WsFrameParser();
  parser.push(mediumFrame.subarray(0, 50));
  expect(parser.next()).toBeNull();
  parser.push(mediumFrame.subarray(50));
  const parsed = parser.next();
  expect(parsed?.payload.toString("utf8")).toBe("A".repeat(200));
  expect(parser.next()).toBeNull();
});

test("WebSocket 分片响应、ping→pong 与显式关闭", async () => {
  const server = await startFakeCdp({ fragmentResponses: true, pingBeforeResponse: true });
  const session = await CdpSession.connect(`ws://127.0.0.1:${server.port}/devtools/page/PAGE-1`, {
    timeoutMs: 3000,
  });
  try {
    const result = await session.call<{ result: { value: number } }>("Runtime.evaluate", {
      expression: "1+1",
    });
    expect(result.result.value).toBe(2);
    expect(await waitFor(() => server.pongCount() === 1)).toBe(true);
  } finally {
    session.close();
  }
  await server.close();
});

test("Session 显式关闭后调用报 WS_CLOSED", async () => {
  const server = await startFakeCdp();
  const client = await WsClient.connect({
    host: DEFAULT_CDP_HOST,
    port: server.port,
    path: "/devtools/page/PAGE-1",
    timeoutMs: 2000,
  });
  client.close();
  const error = await catchError(() => client.recvText());
  expect(error).toBeInstanceOf(CdpError);
  expect((error as CdpError).code).toBe("WS_CLOSED");
  await server.close();
});

test("Session 超时抛 CDP_TIMEOUT", async () => {
  const server = await startFakeCdp({ ignoreEvaluate: true });
  const session = await CdpSession.connect(`ws://127.0.0.1:${server.port}/devtools/page/PAGE-1`, {
    timeoutMs: 200,
  });
  try {
    const error = await catchError(() =>
      session.call("Runtime.evaluate", { expression: "await new Promise(()=>{})" }),
    );
    expect(error).toBeInstanceOf(CdpError);
    expect((error as CdpError).code).toBe("CDP_TIMEOUT");
    expect(errorMessage(error)).toContain("EASYEDA_CDP_TIMEOUT");
  } finally {
    session.close();
    await server.close();
  }
});

// ─── 发现 ────────────────────────────────────────────────────────────

test("discover 只认同时带 Browser 与 Protocol-Version 的返回，uuid 匹配优先", async () => {
  const server = await startFakeCdp();
  try {
    expect(looksLikeCdp({ Browser: "Chrome/146" })).toBe(false);
    expect(looksLikeCdp({ Browser: "", "Protocol-Version": "1.3" })).toBe(false);
    expect(looksLikeCdp({ Browser: "Chrome/146", "Protocol-Version": "1.3" })).toBe(true);

    const matching = await discover(DEFAULT_CDP_HOST, {
      port: server.port,
      records: [
        { port: server.port, file: "C:\\profile\\cache.1\\DevToolsActivePort", uuid: FAKE_UUID },
      ],
    });
    // 一条来自端口文件，一条来自 cli 候选（同端口，所以 /json/version 只探一次）
    expect(matching.results).toHaveLength(2);
    expect(matching.results[0]).toMatchObject({ port: server.port, cdp: true, uuidMatch: true });
    expect(matching.usable[0]?.port).toBe(server.port);
    expect(matching.usable[0]?.source).toBe("DevToolsActivePort");
    expect(browserUuid(matching.results[0]?.version)).toBe(FAKE_UUID);
    expect(endpointUrl(DEFAULT_CDP_HOST, server.port)).toBe(`http://127.0.0.1:${server.port}`);

    // 端口文件记录的是别的实例：uuidMatch=false；没有 authentic 匹配时仍作为 usable 候选
    const stale = await discover(DEFAULT_CDP_HOST, {
      port: server.port,
      records: [
        { port: server.port, file: "C:\\profile\\cache.1\\DevToolsActivePort", uuid: "stale" },
      ],
    });
    expect(stale.results[0]).toMatchObject({ uuidMatch: false, cdp: true });
    expect(stale.usable[0]).toMatchObject({ source: "DevToolsActivePort", uuidMatch: false });

    const resolved = await resolveEndpoint(DEFAULT_CDP_HOST, {
      port: server.port,
      records: [],
    });
    expect(resolved?.port).toBe(server.port);

    const targets = await listTargets(DEFAULT_CDP_HOST, server.port);
    expect(targets.map((target) => target.id)).toEqual(["PAGE-1", "IFRAME-1", "WORKER-1"]);
  } finally {
    await server.close();
  }
});

test("端到端：discover → Session → Runtime.evaluate，api/ui 两种上下文", async () => {
  const server = await startFakeCdp();
  try {
    const endpoint = await resolveEndpoint(DEFAULT_CDP_HOST, {
      port: server.port,
      records: [],
    });
    expect(endpoint).not.toBeNull();
    const url = endpoint ? versionWebSocketUrl(endpoint.version) : "";
    expect(url).toContain(`/devtools/browser/${FAKE_UUID}`);

    const session = await CdpSession.connect(url, { timeoutMs: 3000 });
    try {
      const plain = await session.call<{ result: { value: number } }>("Runtime.evaluate", {
        expression: "1+1",
      });
      expect(plain.result.value).toBe(2);
    } finally {
      session.close();
    }

    const board = await Board.open({ port: server.port, env: { LOCALAPPDATA: "" } });
    try {
      expect(board.title).toContain("立创EDA专业版");
      const nets = await board.nets();
      expect(nets).toEqual([{ name: "GND" }]);
    } finally {
      board.close();
    }

    const apiSession = await CdpSession.connect(url, { timeoutMs: 3000 });
    try {
      const apiPlan = planEval({ apiBody: "return 42;" });
      expect(apiPlan.wantDocType).toBe("pcb");
      const apiOutcome = await evaluateInContext(apiSession, apiPlan);
      expect(apiOutcome.value).toBe(42);

      const uiPlan = planEval({ context: "ui", expression: "document.title" });
      expect(uiPlan.wantDocType).toBeNull();
      expect(uiPlan.expression).toBe("document.title");
      const uiOutcome = await evaluateInContext(apiSession, uiPlan);
      expect(uiOutcome.value).toBe("Fake EDA");
    } finally {
      apiSession.close();
    }
  } finally {
    await server.close();
  }
});

test("截图：Page.captureScreenshot 落盘，fit 与隐藏层走后复原", async () => {
  const server = await startFakeCdp();
  const dir = tempDir("lceda-cdp-shot-");
  try {
    const session = await CdpSession.connect(`ws://127.0.0.1:${server.port}/devtools/page/PAGE-1`, {
      timeoutMs: 3000,
    });
    try {
      const out = path.join(dir, "nested", "page.png");
      const result = await screenshotToFile(session, out, { fit: true, hideLayers: [1, 2] });
      expect(result.path).toBe(path.resolve(out));
      expect(result.bytes).toBe(Buffer.byteLength("fake-png-bytes"));
      expect(result.fit).toBe(true);
      expect(result.hidden).toEqual([1, 2]);
      expect(result.restored).toBe(true);
      expect(fs.readFileSync(out, "utf8")).toBe("fake-png-bytes");
    } finally {
      session.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test("frame 树：Page.getFrameTree 压平并保留层级", async () => {
  const server = await startFakeCdp();
  try {
    const session = await CdpSession.connect(`ws://127.0.0.1:${server.port}/devtools/page/PAGE-1`, {
      timeoutMs: 3000,
    });
    try {
      const { fetchFrameTree, flattenFrameTree, formatFrameTree } =
        await import("../src/cdp/targets.ts");
      const tree = await fetchFrameTree(session);
      const rows = flattenFrameTree(tree);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ depth: 0, name: "(main)", url: "https://client/editor" });
      expect(rows[1]).toMatchObject({ depth: 1, name: "pcb" });
      expect(formatFrameTree(rows)).toEqual([
        "- (main)",
        "  https://client/editor",
        "  - pcb",
        "    https://client/pcb?token=SECRET",
      ]);
    } finally {
      session.close();
    }
  } finally {
    await server.close();
  }
});

test("Runtime.evaluate 抛异常时转成 EvalError", async () => {
  const server = await startFakeCdp();
  try {
    const session = await CdpSession.connect(`ws://127.0.0.1:${server.port}/devtools/page/PAGE-1`, {
      timeoutMs: 3000,
    });
    try {
      const plan = planEval({ expression: "throw-me" });
      const error = await catchError(() => evaluateInContext(session, plan));
      expect(error).toBeInstanceOf(EvalError);
      expect(errorMessage(error)).toContain("throw-me");
    } finally {
      session.close();
    }
  } finally {
    await server.close();
  }
});

// ─── profile 与 DevToolsActivePort ───────────────────────────────────

test("DevToolsActivePort 两行解析：端口与 browser uuid（含 BOM/CRLF）", () => {
  expect(parseDevToolsActivePortText("9222\n/devtools/browser/abc-123\n")).toEqual({
    port: 9222,
    uuid: "abc-123",
  });
  expect(parseDevToolsActivePortText("\uFEFF9333\r\n/devtools/browser/def/\r\n")).toEqual({
    port: 9333,
    uuid: "def",
  });
  expect(parseDevToolsActivePortText("9444\n")).toEqual({ port: 9444, uuid: "" });
  expect(parseDevToolsActivePortText("not-a-port\n/devtools/browser/x\n")).toEqual({
    port: 0,
    uuid: "x",
  });
  expect(parseDevToolsActivePortText("")).toEqual({ port: 0, uuid: "" });

  // commands/cdp.ts 的新解析器与 core/netprobe 的端口口径一致
  const record = parseDevToolsActivePortRecord("9222\n/devtools/browser/abc\n");
  expect(record).toEqual({ port: 9222, uuid: "abc" });
  expect(record.port).toBe(parseDevToolsActivePort("9222\n/devtools/browser/abc\n"));
  expect(parseDevToolsActivePortRecord("9222\n").uuid).toBe("");
  expect(parseDevToolsActivePortRecord("garbage").port).toBe(0);

  expect(parsePortRange("9200-9300")).toEqual([9200, 9300]);
  expect(parsePortRange("9200 - 9300")).toEqual([9200, 9300]);
  expect(parsePortRange("9300-9200")).toBeNull();
  expect(parsePortRange("abc")).toBeNull();
});

test("profileRoots 只认 LCEDA / EasyEDA 前缀，readDevToolsActivePorts 读 cache.*", () => {
  const root = tempDir("lceda-cdp-profile-");
  try {
    for (const name of ["LCEDA Pro", "easyeda", "OtherVendor"]) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
    }
    const lcedaCache = path.join(root, "LCEDA Pro", "cache.1");
    fs.mkdirSync(lcedaCache, { recursive: true });
    fs.writeFileSync(
      path.join(lcedaCache, "DevToolsActivePort"),
      "9222\n/devtools/browser/aaa\n",
      "utf8",
    );
    const easyedaCache = path.join(root, "easyeda", "cache.2");
    fs.mkdirSync(easyedaCache, { recursive: true });
    fs.writeFileSync(
      path.join(easyedaCache, "DevToolsActivePort"),
      "9333\n/devtools/browser/bbb\n",
      "utf8",
    );
    // 目录名不匹配或端口文件缺失，都不该进候选
    fs.mkdirSync(path.join(root, "OtherVendor", "cache.3"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "OtherVendor", "cache.3", "DevToolsActivePort"),
      "9555\n/devtools/browser/ccc\n",
      "utf8",
    );

    const roots = profileRoots({ LOCALAPPDATA: root }, "win32");
    expect(roots.sort()).toEqual([path.join(root, "easyeda"), path.join(root, "LCEDA Pro")].sort());
    expect(profileRoots({ LOCALAPPDATA: "" }, "win32")).toEqual([]);
    expect(profileRoots({ HOME: path.join(root, "missing-home") }, "linux")).toEqual([]);

    const records = readDevToolsActivePorts(roots);
    expect(records.map((record) => ({ port: record.port, uuid: record.uuid }))).toEqual([
      { port: 9222, uuid: "aaa" },
      { port: 9333, uuid: "bbb" },
    ]);
    expect(readDevToolsActivePorts([path.join(root, "missing")])).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── 选页守卫 ────────────────────────────────────────────────────────

function page(id: string, title = "proj-board", docType?: unknown): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id,
    type: "page",
    title,
    url: "https://client/editor",
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${id}`,
  };
  if (docType !== undefined) item.doc_type = docType;
  return item;
}

function noise(): Record<string, unknown>[] {
  return [
    { id: "IFRAME-1", type: "iframe", url: "https://client/frame" },
    ...Array.from({ length: 4 }, (_item, index) => ({ id: `WORKER-${index}`, type: "worker" })),
  ];
}

test("pickPage 守卫：命中数不等于 1 报错，不静默取首个", () => {
  const twoWindows = [page("WIN-A"), page("WIN-B"), ...noise()];
  const error = (() => {
    try {
      return pickPage(twoWindows, { match: "proj" });
    } catch (caught) {
      return caught;
    }
  })();
  expect(error).toBeInstanceOf(PageSelectionError);
  expect(errorMessage(error)).toContain("命中数=2");
  expect(errorMessage(error)).not.toContain("WIN-A");

  const one = [page("WIN-A"), ...noise()];
  expect(pickPage(one).id).toBe("WIN-A");
  expect(pickPage(one, { match: "proj" }).id).toBe("WIN-A");
  expect(pickPage(one, { match: "https://client/editor" }).id).toBe("WIN-A");
  expect(() => pickPage(one, { match: "不存在的片段" })).toThrow(/命中数=0/);
});

test("pickPage 守卫：显式 index 跳过唯一性断言，越界仍报错", () => {
  const twoWindows = [page("WIN-A"), page("WIN-B"), ...noise()];
  expect(pickPage(twoWindows, { index: 0 }).id).toBe("WIN-A");
  expect(pickPage(twoWindows, { index: 1 }).id).toBe("WIN-B");
  expect(() => pickPage(twoWindows, { index: 99 })).toThrow(/越界/);
  expect(() => pickPage(twoWindows, { index: 1.5 })).toThrow(/不是整数/);
});

test("pickPage 守卫：文档类型前置过滤与未知类型保留", () => {
  const mixed = [page("WIN-A", "proj", "pcb"), page("WIN-B", "proj", "schematic"), ...noise()];
  expect(pickPage(mixed, { match: "proj", wantDocType: "pcb" }).id).toBe("WIN-A");

  const bothPcb = [page("WIN-A", "proj", "pcb"), page("WIN-B", "proj", "pcb"), ...noise()];
  expect(() => pickPage(bothPcb, { match: "proj", wantDocType: "pcb" })).toThrow(/命中数=2/);

  // 文档类型未知时不静默排除，交给唯一性断言兜底
  const unknown = [page("WIN-A", "proj", "pcb"), page("WIN-B", "proj"), ...noise()];
  expect(() => pickPage(unknown, { match: "proj", wantDocType: "pcb" })).toThrow(/命中数=2/);
  expect(
    pickPage([page("WIN-A", "proj", "pcb"), page("WIN-B", "proj", "schematic")], {
      wantDocType: "schematic",
    }).id,
  ).toBe("WIN-B");

  // 只有 page 且带 webSocketDebuggerUrl 的项才参与
  expect(() => pickPage([...noise(), { id: "P", type: "page", title: "x" }])).toThrow(/命中数=0/);
  const onlyPageWithoutWs = [{ id: "P", type: "page", title: "x" }];
  expect(() => pickPage(onlyPageWithoutWs)).toThrow(/命中数=0/);
});

// ─── 脱敏与副作用 ────────────────────────────────────────────────────

test("redact 抹掉敏感参数、邮箱与手机号，普通文本不动", () => {
  const url =
    "https://client/editor?token=abc123&email=leon@example.com&username=leon&customer_code=42&x=1";
  const masked = redact(url);
  expect(masked).toContain("token=<REDACTED>");
  expect(masked).toContain("email=<REDACTED>");
  expect(masked).toContain("username=<REDACTED>");
  expect(masked).toContain("customer_code=<REDACTED>");
  expect(masked).toContain("x=1");
  expect(masked).not.toContain("abc123");
  expect(masked).not.toContain("leon@example.com");

  expect(redact("联系 a.b+c@example.com 或 13812345678")).toBe("联系 <REDACTED> 或 <REDACTED>");
  expect(redact("PCB1 线宽 0.2mm")).toBe("PCB1 线宽 0.2mm");
  expect(redact("")).toBe("");
  expect(redactDeep({ url, nested: ["token=x"] })).toEqual({
    url: masked,
    nested: ["token=<REDACTED>"],
  });
});

test("hasSideEffects 命中黑名单模式，只读表达式放行", () => {
  for (const expression of [
    "el.click()",
    "el.dispatchEvent(new Event('x'))",
    "input.value = 'x'",
    "form.submit()",
    "node.remove()",
    "parent.appendChild(child)",
    "el.innerHTML = 'x'",
    "document.write('x')",
    "fetch('/api')",
    "new XMLHttpRequest()",
    "require('fs')",
    "localStorage.setItem('k','v')",
    "sessionStorage.setItem('k','v')",
    "eval('1+1')",
  ]) {
    expect(hasSideEffects(expression)).toBe(true);
  }
  expect(hasSideEffects("document.title")).toBe(false);
  expect(hasSideEffects("a.value === b")).toBe(false);
  expect(hasSideEffects("")).toBe(false);
  expect(SIDE_EFFECT_PATTERNS.length).toBeGreaterThanOrEqual(14);
});

// ─── 顶层 UI 判据与探针 ──────────────────────────────────────────────

test("uiShell 判据：至少命中两个挂载点，href 脱敏在错误文案里", async () => {
  expect(uiShellVerdict({ markers: ["#main", "#top-wrap"], marker_total: 4 }).ok).toBe(true);
  expect(uiShellVerdict({ markers: ["#main"], marker_total: 4 })).toMatchObject({ ok: false });
  expect(uiShellVerdict({ markers: ["#main"], marker_total: 4 }).reason).toContain("只命中 1/4");
  expect(uiShellVerdict(null).ok).toBe(false);

  const expression = uiShellProbeExpression();
  expect(expression).toContain("#canvas-work-space");
  expect(() => new vm.Script(expression)).not.toThrow();

  const server = await startFakeCdp({ uiMarkers: ["#main"] });
  try {
    const session = await CdpSession.connect(`ws://127.0.0.1:${server.port}/devtools/page/PAGE-1`, {
      timeoutMs: 3000,
    });
    try {
      const plan = planEval({ context: "ui", expression: "document.title" });
      const error = await catchError(() => evaluateInContext(session, plan));
      expect(error).toBeInstanceOf(UiShellError);
      expect((error as CdpError).code).toBe("UI_SHELL");
    } finally {
      session.close();
    }
  } finally {
    await server.close();
  }
});

test("modalProbe 载荷可编译，DETECT_JS 与 CLICK 共用同一份探针", () => {
  expect(() => new vm.Script(DETECT_JS)).not.toThrow();
  expect(() => new vm.Script(CLICK_MODAL_BUTTON_JS)).not.toThrow();
  expect(DETECT_JS.includes(MODAL_PROBE_JS)).toBe(true);
  expect(CLICK_MODAL_BUTTON_JS.includes(MODAL_PROBE_JS)).toBe(true);
  expect(MODAL_PROBE_JS).toContain("__mModals");
  expect(DETECT_JS).toContain("topTabTip");

  const click = clickModalButtonExpression(2, "#dlg", 1);
  expect(click).toContain("const modalIndex = 2;");
  expect(click).toContain('const modalSel = "#dlg";');
  expect(click).toContain("const btnIndex = 1;");
  expect(() => new vm.Script(click)).not.toThrow();

  expect(STATE_KEYS).toEqual([
    "history_preview",
    "banner_text",
    "history_panel",
    "modals",
    "writable",
    "blocked",
    "project",
    "docType",
  ]);
  expect(MODAL_FIELDS).toContain("stack_index");
  expect(BUTTON_KINDS).toEqual(["primary", "cancel", "other"]);
});

// ─── 可写性守卫 ─────────────────────────────────────────────────────

const modalState: EditorState = {
  history_preview: false,
  modals: [
    {
      title: "退出确认",
      selector: "#dlg",
      stack_index: 2,
      buttons: [
        { text: "确定", kind: "primary", clickable: true },
        { text: "取消", kind: "cancel", clickable: true },
        { text: "默认", kind: "other", clickable: false },
      ],
    },
    {
      title: "设计规则",
      selector: "#rules",
      stack_index: 1,
      buttons: [{ text: "应用", kind: "primary", clickable: true }],
    },
  ],
};

test("judgeState：历史预览态与模态框拦写，历史面板本身不拦", () => {
  expect(judgeState({ history_preview: true })).toMatchObject({
    writable: false,
    blocked: ["历史预览态：写操作全部禁用（菜单灰、RPC 写入静默失败）"],
  });
  expect(judgeState({ history_preview: false })).toEqual({ writable: true, blocked: [] });
  expect(judgeState({ history_panel: true }).writable).toBe(true);

  const verdict = judgeState(modalState);
  expect(verdict.writable).toBe(false);
  expect(verdict.blocked[0]).toContain("存在模态对话框");
  expect(verdict.blocked[0]).toContain("安全关闭：取消");
  expect(verdict.blocked[0]).toContain("提交类（勿点）：确定");
  expect(verdict.blocked[0]).toContain("提交类（勿点）：应用");

  const normalized = normalizeState(modalState);
  expect(Object.keys(normalized).slice(0, STATE_KEYS.length)).toEqual([...STATE_KEYS]);
  expect(normalized.writable).toBe(false);
  expect(normalized.blocked?.length).toBe(1);
});

test("topModal 取 stack_index 最小者，modalDetail 只列可点按钮", () => {
  expect(topModal(modalState)?.title).toBe("设计规则");
  expect(topModal({ modals: [] })).toBeNull();
  expect(topModal({})).toBeNull();
  expect(modalDetail(modalState)).toContain("设计规则");
  expect(modalDetail(modalState)).toContain("应用");
  expect(modalDetail(modalState)).not.toContain("默认");
});

test("detectState 解析 DETECT_JS 返回的 JSON 字符串，读不到时报 UNWRITABLE", async () => {
  const state = await detectState({
    evalJs: async () => JSON.stringify({ history_preview: true, modals: [] }),
  });
  expect(state.history_preview).toBe(true);

  const error = await catchError(() => detectState({ evalJs: async () => "not-json" }));
  expect(error).toBeInstanceOf(CdpError);
  expect((error as CdpError).code).toBe("UNWRITABLE");
});

// ─── 文档选择与切换 ──────────────────────────────────────────────────

const DOCS: DocumentInfo[] = [
  { kind: "pcb", name: "PCB1", uuid: "uuid-pcb-1", project: "proj" },
  { kind: "pcb", name: "PCB2", uuid: "uuid-pcb-2", project: "proj" },
  { kind: "sch", name: "P1", uuid: "uuid-sch-1", project: "proj" },
  { kind: "sch", name: "电源页", uuid: "uuid-sch-2", project: "proj" },
];

test("selectDocument：精确、模糊、多义与 uuid 直开", () => {
  expect(selectDocument(DOCS, { name: "PCB1" }).uuid).toBe("uuid-pcb-1");
  expect(selectDocument(DOCS, { name: "P1" }).uuid).toBe("uuid-sch-1");
  // 唯一模糊命中
  expect(selectDocument(DOCS, { name: "电源" }).uuid).toBe("uuid-sch-2");
  expect(() => selectDocument(DOCS, { name: "PCB" })).toThrow(/模糊匹配到多个/);
  expect(() => selectDocument(DOCS, { name: "不存在" })).toThrow(/没找到文档/);
  expect(() => selectDocument(DOCS, {})).toThrow(/--name 或 --uuid/);
  expect(() => selectDocument(DOCS, { name: "PCB1", uuid: "x" })).toThrow(/只能给一个/);

  const direct = selectDocument(DOCS, { uuid: "uuid-pcb-2", kind: "pcb" });
  expect(direct.name).toBe("PCB2");
  const unsynced = selectDocument([], { uuid: "uuid-new", kind: "pcb" });
  expect(unsynced).toEqual({ kind: "pcb", name: null, uuid: "uuid-new" });

  const ambiguous = (() => {
    try {
      selectDocument([...DOCS, { kind: "pcb", name: "PCB1", uuid: "uuid-pcb-3" }], {
        name: "PCB1",
      });
    } catch (error) {
      return error;
    }
    return null;
  })();
  expect(ambiguous).toBeInstanceOf(DocumentError);
  expect((ambiguous as DocumentError).code).toBe("DOC_AMBIGUOUS");
});

test("openDocument：activate 后回读 active_after，焦点不一致抛 DOC_FOCUS_MISMATCH", async () => {
  function fakeBoard(activeUuid: string): ApiBoard {
    return {
      api: async (body) => {
        if (body.includes("getAllPcbsInfo")) {
          return JSON.stringify({ documents: [{ kind: "pcb", name: "PCB1", uuid: "uuid-pcb-1" }] });
        }
        if (body.includes("openDocument")) {
          return JSON.stringify({ opened: true, tab_id: "TAB-1", activated: true });
        }
        if (body.includes("waitForDocumentReady")) {
          return JSON.stringify({ ready: false, via: "waitForDocumentReady" });
        }
        if (body.includes("getCurrentPcbInfo")) {
          return JSON.stringify({
            kind: "pcb",
            name: "PCB1",
            uuid: activeUuid,
            via: "getCurrentPcbInfo",
          });
        }
        throw new Error(`假 Board 不认识这段载荷：${body.slice(0, 60)}`);
      },
    };
  }

  const board = fakeBoard("uuid-pcb-1");
  const listed = await listDocuments(board);
  expect(listed.documents).toHaveLength(1);

  const opened = await openDocument(board, { name: "PCB1" });
  expect(opened).toMatchObject({
    opened: true,
    tab_id: "TAB-1",
    uuid: "uuid-pcb-1",
    activated: true,
    focus_verified: true,
  });
  expect(opened.active_after?.uuid).toBe("uuid-pcb-1");
  expect(String(opened.ready?.note)).toContain("waitForDocumentReady");

  const mismatch = await catchError(() => openDocument(fakeBoard("uuid-other"), { name: "PCB1" }));
  expect(mismatch).toBeInstanceOf(DocumentError);
  expect((mismatch as DocumentError).code).toBe("DOC_FOCUS_MISMATCH");
  expect((mismatch as DocumentError).details).toMatchObject({ uuid: "uuid-pcb-1" });
});

// ─── 回环地址与 CLI ──────────────────────────────────────────────────

test("回环地址校验：只放行 127.*、localhost、::1", () => {
  for (const host of ["127.0.0.1", "127.9.9.9", "localhost", "LOCALHOST", "::1", "[::1]"]) {
    expect(isLoopbackHost(host)).toBe(true);
    expect(() => requireLoopbackHost(host)).not.toThrow();
  }
  for (const host of ["10.0.0.1", "192.168.1.2", "example.com", "0.0.0.0", "127.0.0.1.evil"]) {
    expect(isLoopbackHost(host)).toBe(false);
    const error = (() => {
      try {
        requireLoopbackHost(host);
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(CdpError);
    expect((error as CdpError).code).toBe("LOOPBACK_ONLY");
  }
});

test("cdp-client CLI：help 与用法错误不连接客户端", async () => {
  const helpIo = createMemoryIo();
  expect(await runCdpClientCommand(["help"], helpIo, {})).toBe(0);
  expect(helpIo.lines.join("\n")).toContain("discover");
  expect(helpIo.lines.join("\n")).toContain("cdp start");

  const shotIo = createMemoryIo();
  expect(await runCdpClientCommand(["shot"], shotIo, {})).toBe(1);
  expect(shotIo.errors.join("\n")).toContain("--out");

  const badHostIo = createMemoryIo();
  expect(await runCdpClientCommand(["discover", "--host", "10.0.0.1"], badHostIo, {})).toBe(3);
  expect(badHostIo.errors.join("\n")).toContain("回环");

  const badActionIo = createMemoryIo();
  expect(await runCdpClientCommand(["nope"], badActionIo, {})).toBe(1);
  expect(badActionIo.errors.join("\n")).toContain("不认识的 cdp-client 动作");
});

// ─── MCP 工具包装 ────────────────────────────────────────────────────

test("cdpTools 导出 8 个工具，名称与参数 schema 完整", () => {
  expect(cdpTools.map((tool) => tool.name)).toEqual([
    "cdp_discover",
    "cdp_targets",
    "cdp_eval",
    "cdp_screenshot",
    "cdp_doc_list",
    "cdp_doc_active",
    "cdp_doc_open",
    "cdp_ui_state",
  ]);
  for (const tool of cdpTools) {
    expect(tool.description.length).toBeGreaterThan(20);
    expect(Object.keys(tool.input).length).toBeGreaterThan(0);
    if (tool.name !== "cdp_eval") expect(tool.input).not.toHaveProperty("confirm");
  }
});

test("cdpTools 能被 MCP SDK 注册并列出（zod schema 可转换）", async () => {
  const server = createServer({ tools: cdpTools, env: {} });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(cdpTools.map((tool) => tool.name));
    const screenshot = tools.find((tool) => tool.name === "cdp_screenshot");
    expect(screenshot?.inputSchema.required).toContain("outPath");
    const evalTool = tools.find((tool) => tool.name === "cdp_eval");
    expect(evalTool?.inputSchema.required).toContain("expression");
  } finally {
    await client.close();
  }
});

test("cdp_discover 工具走本地假服务；没有端点时返回 CDP_NOT_FOUND", async () => {
  const server = await startFakeCdp();
  try {
    const tool = cdpTools.find((item) => item.name === "cdp_discover");
    expect(tool).toBeDefined();
    if (!tool) return;
    const ctx = {
      cfg: loadConfig({}, { cdp: { port: server.port } }),
      env: { LOCALAPPDATA: "" },
    };
    const result = await invokeTool(tool, {}, ctx);
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      found: boolean;
      endpoint: string;
      webSocketDebuggerUrl: string;
    };
    expect(payload.found).toBe(true);
    expect(payload.endpoint).toBe(`http://127.0.0.1:${server.port}`);
    expect(payload.webSocketDebuggerUrl).toContain(FAKE_UUID);

    const missing = await invokeTool(
      tool,
      {},
      { cfg: loadConfig({}, { cdp: { port: 1 } }), env: { LOCALAPPDATA: "" } },
    );
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("CDP_NOT_FOUND");
  } finally {
    await server.close();
  }
});

test("cdp_eval 与 cdp_doc_open 的领域错误在连接客户端之前返回", async () => {
  const ctx = { cfg: loadConfig({}), env: {} };

  const evalTool = cdpTools.find((tool) => tool.name === "cdp_eval");
  expect(evalTool).toBeDefined();
  if (!evalTool) return;
  const evalResult = await invokeTool(
    evalTool,
    { expression: "document.body.innerHTML = 'x'" },
    ctx,
  );
  expect(evalResult.isError).toBe(true);
  expect(evalResult.content[0]?.text).toContain("CONFIRM_REQUIRED");

  const docTool = cdpTools.find((tool) => tool.name === "cdp_doc_open");
  expect(docTool).toBeDefined();
  if (!docTool) return;
  const docResult = await invokeTool(docTool, {}, ctx);
  expect(docResult.isError).toBe(true);
  expect(docResult.content[0]?.text).toContain("DOC_USAGE");
});
