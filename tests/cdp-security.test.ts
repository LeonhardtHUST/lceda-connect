import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

import { bridgeExecuteTool } from "../src/bridge/mcpTools.ts";
import { BRIDGE_MAX_CODE_BYTES } from "../src/bridge/protocol.ts";
import {
  cdpDiscoverTool,
  cdpEvalTool,
  cdpScreenshotTool,
  cdpTargetsTool,
} from "../src/cdp/mcpTools.ts";
import { redact, SENSITIVE_PARAMS } from "../src/cdp/redact.ts";
import { CdpSession } from "../src/cdp/session.ts";
import { classifyEval, stripJavaScriptLiterals } from "../src/cdp/sideEffects.ts";
import { decodeWsFrame, encodeWsFrame, WS_OPCODE, WsClient } from "../src/cdp/wsClient.ts";
import { runCdpAction, writePidRecord } from "../src/commands/cdp.ts";
import { loadConfig } from "../src/core/config.ts";
import { createMemoryIo } from "../src/core/io.ts";
import { invokeTool } from "../src/mcp/server.ts";
import { ToolError } from "../src/mcp/types.ts";

const processMocks = vi.hoisted(() => ({
  isPidAlive: vi.fn(() => true),
  terminateProcess: vi.fn(),
  run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
}));

vi.mock("../src/core/windows.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/windows.ts")>()),
  isPidAlive: processMocks.isPidAlive,
  terminateProcess: processMocks.terminateProcess,
}));

vi.mock("../src/core/exec.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/exec.ts")>()),
  run: processMocks.run,
}));

const requiresConfirm = [
  "A.pcb_PrimitiveLine.delete(...)",
  "A.pcb_Document.autoRouting(...)",
  "const x=A; x.pcb_Document.getCurrentProjectInfo()",
  'A["pcb_Document"]',
  "globalThis.eda",
  'location="https://example.invalid"',
  "A.x.getY().then(x=>x.delete())",
  "A.x.getY().setThing()",
  String.raw`\u0041.pcb_Document.autoRouting()`,
  "with(A.x.getY()){autoRouting()}",
  "A.x.getY(),sideEffect()",
  "sideEffect`x`",
  "Object.assign(document.body,{innerHTML:1})",
  "tag`x`",
  "A.x.getY(()=>1)",
  "A.x.getY({innerHTML:1})",
  "A.x.getY(innerHTML)",
  "A.x.getY(); sideEffect()",
  "A.x.getY()\nsideEffect()",
  "A.x.getY();;",
  "document.body",
  "document.title + 1",
  "document.title.x",
  'A.x.getY("/*") ; sideEffect()',
];

test("classifyEval 与 cdp_eval 对 API 绕过一律要求确认", async () => {
  for (const expression of requiresConfirm) {
    expect(classifyEval(expression).readonly, expression).toBe(false);
    expect(classifyEval(expression).reasons.length, expression).toBeGreaterThan(0);
    const result = await invokeTool(cdpEvalTool, { expression }, { cfg: loadConfig({}), env: {} });
    expect(result.isError, expression).toBe(true);
    expect(result.content[0]?.text).toContain("CONFIRM_REQUIRED");
    expect(result.content[0]?.text).toContain("reasons");
  }
});

test("classifyEval 只放行严格白名单：document 只读属性、单条查询、纯 JSON", () => {
  const allowed = [
    "document.title",
    "document.URL",
    "document.documentURI",
    "document.readyState",
    "A.dmt_Project.getCurrentProjectInfo()",
    'A.x.getY("quoted value")',
    "eda.api.getCurrentProjectInfo()",
    "return await A.pcb_Net.getAllNets();",
    "await A.pcb_Net.getAllNets()",
    "123",
    "true",
    "null",
    '{"a":1}',
    '[1,"x"]',
    '"plain string"',
    'A.x.getY(") ; sideEffect()")',
    "/* comment */ A.x.getY(/* args */) // tail",
  ];
  for (const expression of allowed) {
    expect(classifyEval(expression).readonly, expression).toBe(true);
  }
});

test("classifyEval 剥离注释但不吞字符串，多语句与比较表达式默认拒绝", () => {
  const expression = `
    // fetch('/bad')
    /* document.cookie */
    return await A.pcb_Net.getAllNets();
  `;
  expect(classifyEval(expression).readonly).toBe(true);
  expect(stripJavaScriptLiterals(expression)).not.toContain("fetch");

  // 字符串语句 + return await 是多语句，旧实现的宽容口径不再放行。
  const multiStatement = `
    // fetch('/bad')
    "location = 'x'";
    /* document.cookie */
    return await A.pcb_Net.getAllNets();
  `;
  expect(classifyEval(multiStatement).readonly).toBe(false);

  for (const code of ["a=1", "a+=1", "a++", "a--", "a<<=1", "a>>=1", "a&&=1", "a??=1"]) {
    expect(classifyEval(code).readonly, code).toBe(false);
  }
  for (const code of ["a==b", "a===b", "a!=b", "a!==b", "a<=b", "a>=b", "()=>1"]) {
    expect(classifyEval(code).readonly, code).toBe(false);
  }
  expect(classifyEval('`${fetch("/x")}`').readonly).toBe(false);
});

test("JS Unicode 行终止符不能把后续代码藏进行注释", async () => {
  for (const terminator of ["\u2028", "\u2029"]) {
    const expression = `document.title // comment${terminator};globalThis.hit=true`;
    expect(classifyEval(expression).readonly).toBe(false);
    expect(stripJavaScriptLiterals(expression)).toContain("globalThis.hit=true");
    const result = await invokeTool(cdpEvalTool, { expression }, { cfg: loadConfig({}), env: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("CONFIRM_REQUIRED");
  }
});

test("redact 大小写不敏感、先解码并覆盖扩展敏感名单", () => {
  for (const parameter of SENSITIVE_PARAMS) {
    const encoded = encodeURIComponent(parameter.toUpperCase());
    expect(redact(`https://x.test/?${encoded}=s%65cret&ok=1`)).toContain(
      `${parameter.toUpperCase()}=<REDACTED>`,
    );
  }
  expect(redact("https://x.test/?%61pi%5fkey=hidden&ok=1")).toBe(
    "https://x.test/?api_key=<REDACTED>&ok=1",
  );
});

test("cdp_discover 和 cdp_targets 只公开白名单并脱敏 URL", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const pathname = new URL(requestUrl).pathname;
    const body =
      pathname === "/json/list"
        ? [
            {
              id: "page",
              type: "page",
              title: "board",
              url: "https://x/?AUTH=secret",
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/page?Token=hidden",
              devtoolsFrontendUrl: "https://x/?token=never",
              extra: "never",
            },
          ]
        : {
            Browser: "Test",
            "Protocol-Version": "1.3",
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/browser?Token=hidden",
            devtoolsFrontendUrl: "https://x/?token=never",
            extra: "never",
          };
    return new Response(JSON.stringify(body));
  });
  try {
    const ctx = { cfg: loadConfig({}), env: {} };
    const discovered = JSON.stringify(await cdpDiscoverTool.run({ port: 9222 }, ctx));
    const targets = JSON.stringify(await cdpTargetsTool.run({ port: 9222 }, ctx));
    for (const output of [discovered, targets]) {
      expect(output).not.toContain("devtoolsFrontendUrl");
      expect(output).not.toContain("extra");
      expect(output).not.toContain("secret");
      expect(output).not.toContain("hidden");
      expect(output).toContain("<REDACTED>");
    }
  } finally {
    fetchMock.mockRestore();
  }
});

test("cdp_screenshot 先校验 resolveWritePath，越界不连接 CDP", async () => {
  const result = await invokeTool(
    cdpScreenshotTool,
    { outPath: "../outside.png" },
    {
      cfg: loadConfig({}),
      env: {},
      resolveWritePath: async () => {
        throw new ToolError("PATH_NOT_ALLOWED", "越界路径");
      },
    },
  );
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain("PATH_NOT_ALLOWED");
});

test("bridge_execute 提前拒绝超限代码", async () => {
  await expect(
    bridgeExecuteTool.run(
      { code: "return '" + "x".repeat(BRIDGE_MAX_CODE_BYTES) + "';", confirm: true },
      {
        cfg: loadConfig({}),
        env: {},
      },
    ),
  ).rejects.toMatchObject({ code: "CODE_TOO_LARGE" });
});

class FakeSocket extends EventEmitter {
  writable = true;
  writes: Buffer[] = [];
  destroyed = false;
  write(buffer: Buffer): boolean {
    this.writes.push(buffer);
    return true;
  }
  end(): this {
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function clientFixture(): { client: WsClient; socket: FakeSocket } {
  const socket = new FakeSocket();
  const Constructor = WsClient as unknown as new (socket: Socket, leftover: Buffer) => WsClient;
  return { client: new Constructor(socket as unknown as Socket, Buffer.alloc(0)), socket };
}

function closeCode(socket: FakeSocket): number | undefined {
  const close = socket.writes
    .map((buffer) => decodeWsFrame(buffer)?.frame)
    .find((frame) => frame?.opcode === WS_OPCODE.close);
  return close?.payload.length === 2 ? close.payload.readUInt16BE(0) : undefined;
}

test("WebSocket 恶意帧以 1002 关闭并 reject 待决调用", async () => {
  const rsv = encodeWsFrame(WS_OPCODE.text, Buffer.from("x"));
  rsv[0] |= 0x40;
  const cases = [
    rsv,
    encodeWsFrame(WS_OPCODE.ping, Buffer.alloc(0), { fin: false }),
    encodeWsFrame(WS_OPCODE.ping, Buffer.alloc(126)),
    encodeWsFrame(WS_OPCODE.continuation, Buffer.alloc(0)),
    Buffer.concat([
      encodeWsFrame(WS_OPCODE.text, Buffer.from("x"), { fin: false }),
      encodeWsFrame(WS_OPCODE.text, Buffer.from("y")),
    ]),
    encodeWsFrame(0x3, Buffer.from("x")),
  ];
  for (const malicious of cases) {
    const { client, socket } = clientFixture();
    const result = expect(client.recvText()).rejects.toMatchObject({ code: "WS_PROTOCOL" });
    socket.emit("data", malicious);
    await result;
    expect(closeCode(socket)).toBe(1002);
    expect(socket.destroyed).toBe(true);
  }
});

test("WebSocket 分片累计超过 64 MiB 时关闭并 reject", async () => {
  const { client, socket } = clientFixture();
  const result = expect(client.recvText()).rejects.toMatchObject({ code: "WS_PROTOCOL" });
  const payload = Buffer.alloc(32 * 1024 * 1024);
  socket.emit("data", encodeWsFrame(WS_OPCODE.text, payload, { fin: false }));
  socket.emit("data", encodeWsFrame(WS_OPCODE.continuation, payload, { fin: false }));
  socket.emit("data", encodeWsFrame(WS_OPCODE.continuation, Buffer.from("x")));
  await result;
  expect(closeCode(socket)).toBe(1002);
});

test("WebSocket 未消费消息队列超过 1024 条时断开", async () => {
  const { client, socket } = clientFixture();
  const frame = encodeWsFrame(WS_OPCODE.text, Buffer.from("x"));
  socket.emit("data", Buffer.concat(Array.from({ length: 1025 }, () => frame)));
  await expect(client.recvText()).rejects.toMatchObject({ code: "WS_PROTOCOL" });
  expect(closeCode(socket)).toBe(1002);
});

test("CDP 正在等待的求值被取消时立即返回 ToolError CANCELLED", async () => {
  const { client } = clientFixture();
  const connect = vi.spyOn(WsClient, "connect").mockResolvedValue(client);
  const controller = new AbortController();
  try {
    const session = await CdpSession.connect("ws://127.0.0.1:9222/page", {
      signal: controller.signal,
    });
    const result = expect(
      session.call("Runtime.evaluate", { expression: "pending()" }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    controller.abort();
    await result;
    session.close();
  } finally {
    connect.mockRestore();
  }
});

test("cdp stop 对 imagePath=null 拒绝结束进程并保留 pid 文件", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-stop-security-"));
  const cfg = loadConfig({ LCEDA_CONNECT_HOME: directory });
  const io = createMemoryIo();
  try {
    writePidRecord(cfg.cdp.pidFile, { pid: 12345, exe: "C:\\lceda.exe" });
    const exit = await runCdpAction(
      "stop",
      { json: true, yes: true, force: false, waitOnlineSec: 0, keepProxyEnv: true },
      { cfg, io, env: {} },
    );
    expect(exit).toBe(2);
    expect(io.lines.join("\n")).toContain("--force");
    expect(fs.existsSync(cfg.cdp.pidFile)).toBe(true);
    expect(processMocks.terminateProcess).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
