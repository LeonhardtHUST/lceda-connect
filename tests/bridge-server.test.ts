import { expect, test } from "vite-plus/test";
import WebSocket from "ws";
import { runBridgeClientCommand } from "../src/bridge/cli.ts";
import {
  BridgeClient,
  BridgeClientError,
  discover,
  execute,
  health,
  requireConnected,
  requireEndpoint,
  selectWindow,
  windows,
} from "../src/bridge/client.ts";
import { createMemoryIo } from "../src/core/io.ts";
import {
  BRIDGE_SERVICE_ID,
  rawDataText,
  type BridgeExecuteResponse,
  type BridgeHealthResponse,
} from "../src/bridge/protocol.ts";
import { startBridgeServer, type BridgeServerHandle } from "../src/bridge/server.ts";

// 集成测试：真的起 HTTP + WS 服务，用 ws 包模拟编辑器端。
// 端口用 0 让系统挑，避免和本机正在跑的 bridge 抢 49620-49629。

interface FakeEditor {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  waitMessage: (
    predicate: (msg: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>;
  send: (message: unknown) => void;
  close: () => void;
  /** 收到 execute 时怎么回；返回 null 表示不回（用来测超时）。 */
  onExecute: ((message: Record<string, unknown>) => Record<string, unknown> | null) | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor<T>(probe: () => Promise<T | null> | T | null, timeoutMs = 4000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor 超时");
    await delay(20);
  }
}

async function startServer(
  options: Parameters<typeof startBridgeServer>[0] = {},
): Promise<BridgeServerHandle> {
  return await startBridgeServer({ port: 0, logger: () => {}, ...options });
}

async function connectEditor(port: number, windowId?: string): Promise<FakeEditor> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/eda`);
  const messages: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (msg: Record<string, unknown>) => boolean;
    resolve: (msg: Record<string, unknown>) => void;
    timer: NodeJS.Timeout;
  }[] = [];

  const editor: FakeEditor = {
    ws,
    messages,
    onExecute: null,
    waitMessage: (predicate) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const seen = messages.find((message) => predicate(message));
        if (seen) {
          resolve(seen);
          return;
        }
        const timer = setTimeout(() => reject(new Error("等待 WS 消息超时")), 4000);
        waiters.push({ predicate, resolve, timer });
      }),
    send: (message) => {
      ws.send(JSON.stringify(message));
    },
    close: () => {
      ws.terminate();
    },
  };

  ws.on("message", (raw) => {
    const message = JSON.parse(rawDataText(raw)) as Record<string, unknown>;
    messages.push(message);
    for (const waiter of waiters.slice()) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
    if (message.type === "execute" && editor.onExecute) {
      const reply = editor.onExecute(message);
      if (reply) ws.send(JSON.stringify(reply));
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const handshake = await editor.waitMessage((msg) => msg.type === "handshake");
  expect(handshake.service).toBe(BRIDGE_SERVICE_ID);
  expect(handshake.clientType).toBe("eda");
  if (windowId) editor.send({ type: "register", windowId });
  return editor;
}

function baseUrl(server: BridgeServerHandle): string {
  return `http://127.0.0.1:${server.port}`;
}

async function getJson<T>(url: string): Promise<{ status: number; headers: Headers; body: T }> {
  const response = await fetch(url);
  return { status: response.status, headers: response.headers, body: (await response.json()) as T };
}

async function postJson<T>(url: string, payload: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as T };
}

test("GET /health 字段与顺序、CORS、OPTIONS 与 404", async () => {
  const server = await startServer();
  try {
    const healthRes = await getJson<BridgeHealthResponse>(`${baseUrl(server)}/health`);
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("access-control-allow-origin")).toBe("*");
    expect(Object.keys(healthRes.body)).toEqual([
      "service",
      "status",
      "edaConnected",
      "edaWindowCount",
      "activeWindowId",
      "pendingRequests",
      "timestamp",
    ]);
    expect(healthRes.body.service).toBe(BRIDGE_SERVICE_ID);
    expect(healthRes.body.status).toBe("ok");
    expect(healthRes.body.edaConnected).toBe(false);
    expect(healthRes.body.edaWindowCount).toBe(0);
    expect(healthRes.body.activeWindowId).toBeNull();
    expect(healthRes.body.pendingRequests).toBe(0);
    expect(typeof healthRes.body.timestamp).toBe("number");

    const optionsRes = await fetch(`${baseUrl(server)}/health`, { method: "OPTIONS" });
    expect(optionsRes.status).toBe(204);
    expect(optionsRes.headers.get("access-control-allow-methods")).toContain("POST");

    const notFound = await getJson<{ error: string }>(`${baseUrl(server)}/nope`);
    expect(notFound.status).toBe(404);
    expect(notFound.body).toEqual({ error: "Not found" });
  } finally {
    await server.close();
  }
});

test("编辑器注册窗口、/eda-windows、切换窗口与 /execute 往返", async () => {
  const server = await startServer();
  const editorA = await connectEditor(server.port, "win-a");
  const editorB = await connectEditor(server.port, "win-b");
  try {
    await waitFor(async () => {
      const state = await health(server.port);
      return state.edaWindowCount === 2 ? state : null;
    });

    const list = await windows(server.port);
    expect(list).toEqual({
      windows: [
        { windowId: "win-a", connected: true, active: true },
        { windowId: "win-b", connected: true, active: false },
      ],
      activeWindowId: "win-a",
      count: 2,
    });

    const missing = await postJson<{ error: string }>(`${baseUrl(server)}/eda-windows/select`, {
      windowId: "nope",
    });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'EDA window "nope" not found' });

    const selected = await postJson<{ success: boolean; activeWindowId: string }>(
      `${baseUrl(server)}/eda-windows/select`,
      { windowId: "win-b" },
    );
    expect(selected.status).toBe(200);
    expect(selected.body).toEqual({ success: true, activeWindowId: "win-b" });

    // 显式指定窗口：结果由 win-a 回，响应里的 windowId 也必须是 win-a
    editorA.onExecute = (message) => ({
      type: "result",
      id: message.id,
      result: { echo: message.code, window: message.windowId },
      timestamp: Date.now(),
    });
    const executed = await postJson<BridgeExecuteResponse>(`${baseUrl(server)}/execute`, {
      code: "return 42;",
      windowId: "win-a",
    });
    expect(executed.status).toBe(200);
    expect(executed.body).toEqual({
      success: true,
      result: { echo: "return 42;", window: "win-a" },
      windowId: "win-a",
    });

    // 不带 windowId：打到当前激活窗口 win-b
    editorB.onExecute = (message) => ({
      type: "result",
      id: message.id,
      result: "from-b",
      timestamp: Date.now(),
    });
    const active = await postJson<BridgeExecuteResponse>(`${baseUrl(server)}/execute`, {
      code: "return 1;",
    });
    expect(active.body).toEqual({ success: true, result: "from-b", windowId: "win-b" });
    expect(editorA.messages.filter((message) => message.type === "execute")).toHaveLength(1);
  } finally {
    editorA.close();
    editorB.close();
    await server.close();
  }
});

test("未连接 / 缺 code / 非法 JSON 的状态码", async () => {
  const server = await startServer();
  try {
    const noWindow = await postJson<BridgeExecuteResponse>(`${baseUrl(server)}/execute`, {
      code: "return 1;",
    });
    expect(noWindow.status).toBe(503);
    expect(noWindow.body.success).toBe(false);
    expect(noWindow.body.error).toContain("No EDA window connected");

    const missingCode = await postJson<{ error: string }>(`${baseUrl(server)}/execute`, {});
    expect(missingCode.status).toBe(400);
    expect(missingCode.body).toEqual({ error: 'Missing "code" field (string)' });

    const badBody = await postJson<{ error: string }>(`${baseUrl(server)}/execute`, {
      code: 123,
    });
    expect(badBody.status).toBe(400);

    const badJson = await fetch(`${baseUrl(server)}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ 不是 json",
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ error: "Invalid request body" });

    // 指定一个不存在的窗口也是「未连接」语义
    const ghost = await postJson<BridgeExecuteResponse>(`${baseUrl(server)}/execute`, {
      code: "return 1;",
      windowId: "ghost",
    });
    expect(ghost.status).toBe(503);
  } finally {
    await server.close();
  }
});

test("编辑器不应答时 /execute 超时返回 500", async () => {
  const server = await startServer({ requestTimeoutMs: 120 });
  const editor = await connectEditor(server.port, "win-slow");
  editor.onExecute = () => null;
  try {
    await waitFor(async () => {
      const state = await health(server.port);
      return state.edaConnected ? state : null;
    });
    const started = Date.now();
    const result = await postJson<BridgeExecuteResponse>(`${baseUrl(server)}/execute`, {
      code: "return 1;",
    });
    expect(result.status).toBe(500);
    expect(result.body.success).toBe(false);
    expect(result.body.error).toContain("timed out after 120ms");
    expect(Date.now() - started).toBeLessThan(2000);

    const state = await health(server.port);
    expect(state.pendingRequests).toBe(0);
  } finally {
    editor.close();
    await server.close();
  }
});

test("编辑器断线时拒绝该窗口的 pending 请求，并重选激活窗口", async () => {
  const server = await startServer();
  const editorA = await connectEditor(server.port, "win-1");
  const editorB = await connectEditor(server.port, "win-2");
  editorA.onExecute = () => null;
  try {
    await waitFor(async () => {
      const state = await health(server.port);
      return state.edaWindowCount === 2 ? state : null;
    });

    const pending = postJson<BridgeExecuteResponse>(`${baseUrl(server)}/execute`, {
      code: "return 1;",
      windowId: "win-1",
    });
    // 等编辑器真的收到请求，再断线，确保走的是断线拒绝分支
    await editorA.waitMessage((message) => message.type === "execute");
    await waitFor(async () => {
      const state = await health(server.port);
      return state.pendingRequests === 1 ? state : null;
    });

    editorA.close();
    const result = await pending;
    expect(result.status).toBe(500);
    expect(result.body.success).toBe(false);
    expect(result.body.error).toContain('EDA window "win-1" disconnected');

    const state = await waitFor(async () => {
      const current = await health(server.port);
      return current.activeWindowId === "win-2" ? current : null;
    });
    expect(state.edaWindowCount).toBe(1);
    expect(state.activeWindowId).toBe("win-2");
  } finally {
    editorA.close();
    editorB.close();
    await server.close();
  }
});

test("已有实例时 startBridgeServer 直接复用，不重复监听", async () => {
  const first = await startServer();
  try {
    const second = await startBridgeServer({
      portFirst: first.port,
      portLast: first.port,
      logger: () => {},
    });
    expect(second.reused).toBe(true);
    expect(second.port).toBe(first.port);
    await second.close();

    const state = await health(first.port);
    expect(state.service).toBe(BRIDGE_SERVICE_ID);
  } finally {
    await first.close();
  }
});

test("client.ts 全流程：discover / health / windows / select / execute 与错误码", async () => {
  const server = await startServer();
  const editor = await connectEditor(server.port, "win-c");
  editor.onExecute = (message) => {
    const code = String(message.code);
    if (code.includes("boom")) {
      return { type: "error", id: message.id, error: "编辑器内部错误", timestamp: Date.now() };
    }
    if (code.includes("slow")) return null;
    return { type: "result", id: message.id, result: `ok:${code}`, timestamp: Date.now() };
  };
  try {
    const found = await discover({ portFirst: server.port, portLast: server.port });
    expect(found?.port).toBe(server.port);
    expect(found?.health.service).toBe(BRIDGE_SERVICE_ID);

    // 绑定端口的客户端对象与函数式 API 等价
    const client = await BridgeClient.discover({ portFirst: server.port, portLast: server.port });
    expect(client?.port).toBe(server.port);
    expect((await client!.health()).service).toBe(BRIDGE_SERVICE_ID);
    expect(await client!.execute("return 5;")).toBe("ok:return 5;");

    const state = await requireConnected(server.port);
    expect(state.edaConnected).toBe(true);

    const list = await windows(server.port);
    expect(list.windows[0]).toEqual({ windowId: "win-c", connected: true, active: true });

    await selectWindow(server.port, "win-c");

    const result = await execute(server.port, "return 42;");
    expect(result).toBe("ok:return 42;");

    const error = await execute(server.port, "return boom;").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BridgeClientError);
    expect((error as BridgeClientError).code).toBe("PROTOCOL");
    expect((error as BridgeClientError).exitCode).toBe(4);

    const timeout = await execute(server.port, "return slow;", { timeoutMs: 100 }).catch(
      (caught: unknown) => caught,
    );
    expect((timeout as BridgeClientError).code).toBe("TIMEOUT");
    expect((timeout as BridgeClientError).exitCode).toBe(5);

    // 编辑器侧报 "not connected" 时按未连接处理
    editor.onExecute = (message) => ({
      type: "error",
      id: message.id,
      error: "window is not connected",
      timestamp: Date.now(),
    });
    const notConnected = await execute(server.port, "return 1;").catch((caught: unknown) => caught);
    expect((notConnected as BridgeClientError).code).toBe("NOT_CONNECTED");
    expect((notConnected as BridgeClientError).exitCode).toBe(3);
  } finally {
    editor.close();
    await server.close();
  }

  // 服务关掉后：discover 找不到，requireEndpoint 报 NO_BRIDGE
  const afterClose = await discover({ portFirst: server.port, portLast: server.port });
  expect(afterClose).toBeNull();
  const missing = await requireEndpoint({ portFirst: server.port, portLast: server.port }).catch(
    (caught: unknown) => caught,
  );
  expect(missing).toBeInstanceOf(BridgeClientError);
  expect((missing as BridgeClientError).code).toBe("NO_BRIDGE");
  expect((missing as BridgeClientError).exitCode).toBe(2);
});

test("agent 端 WS：ping/pong 与 execute 结果帧", async () => {
  const server = await startServer();
  const editor = await connectEditor(server.port, "win-ws");
  editor.onExecute = (message) => ({
    type: "result",
    id: message.id,
    result: "via-ws",
    timestamp: Date.now(),
  });
  const agent = new WebSocket(`ws://127.0.0.1:${server.port}/agent`);
  try {
    const frames: Record<string, unknown>[] = [];
    agent.on("message", (raw) => {
      frames.push(JSON.parse(rawDataText(raw)) as Record<string, unknown>);
    });
    await new Promise<void>((resolve, reject) => {
      agent.once("open", () => resolve());
      agent.once("error", reject);
    });
    await waitFor(() => (frames.length > 0 ? frames[0] : null));
    expect(frames[0]).toMatchObject({
      type: "handshake",
      service: BRIDGE_SERVICE_ID,
      clientType: "agent",
    });

    agent.send(JSON.stringify({ type: "ping", id: "p1" }));
    const pong = await waitFor(() => frames.find((frame) => frame.type === "pong") ?? null);
    expect(pong.id).toBe("p1");

    agent.send(JSON.stringify({ type: "execute", id: "e1", code: "return 1;" }));
    const result = await waitFor(() => frames.find((frame) => frame.type === "result") ?? null);
    expect(result).toMatchObject({ id: "e1", result: "via-ws" });
  } finally {
    agent.terminate();
    editor.close();
    await server.close();
  }
});

test("bridge 客户端 CLI：windows / select / exec 与参数校验", async () => {
  const server = await startServer();
  const editor = await connectEditor(server.port, "win-cli");
  editor.onExecute = (message) => ({
    type: "result",
    id: message.id,
    result: `cli:${String(message.code)}`,
    timestamp: Date.now(),
  });
  const env = { ...process.env, LCEDA_BRIDGE_PORT: String(server.port) };
  try {
    const windowsIo = createMemoryIo();
    expect(await runBridgeClientCommand(["windows"], windowsIo, env)).toBe(0);
    const listed = JSON.parse(windowsIo.lines.join("\n")) as {
      port: number;
      count: number;
      windows: { windowId: string }[];
    };
    expect(listed.port).toBe(server.port);
    expect(listed.count).toBe(1);
    expect(listed.windows[0]?.windowId).toBe("win-cli");

    const selectIo = createMemoryIo();
    expect(await runBridgeClientCommand(["select", "--window", "win-cli"], selectIo, env)).toBe(0);
    expect(JSON.parse(selectIo.lines.join("\n"))).toMatchObject({ activeWindowId: "win-cli" });

    const execIo = createMemoryIo();
    expect(await runBridgeClientCommand(["exec", "--code", "return 7;"], execIo, env)).toBe(0);
    expect(JSON.parse(execIo.lines.join("\n"))).toMatchObject({ result: "cli:return 7;" });

    // 缺 code/file 是用法错误（退出码 1），不会打到服务端
    const usageIo = createMemoryIo();
    expect(await runBridgeClientCommand(["exec"], usageIo, env)).toBe(1);
    expect(usageIo.errors.join("\n")).toContain("--code 或 --file");

    // 服务关掉后按 NO_BRIDGE 退出码 2
    await server.close();
    const offlineIo = createMemoryIo();
    expect(await runBridgeClientCommand(["windows"], offlineIo, env)).toBe(2);
    expect(offlineIo.errors.join("\n")).toContain("没有发现运行中的 bridge");
  } finally {
    editor.close();
    await server.close();
  }
});
