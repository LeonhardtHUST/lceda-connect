import vm from "node:vm";

import { expect, test, vi } from "vite-plus/test";

import type { CdpTarget } from "../src/cdp/targets.ts";
import type { CdpSession } from "../src/cdp/session.ts";
import {
  INPUT_EDITOR_ORIGINS,
  INPUT_EDITOR_PATH,
  INPUT_KEY_CODES,
  INPUT_MAX_TEXT_LENGTH,
  INPUT_MODAL_SELECTOR,
  dispatchCdpInput,
  inputGuardExpression,
  selectInputTarget,
  sendCdpInput,
  validateCdpInputRequest,
  type CdpInputAction,
  type CdpInputRequest,
} from "../src/cdp/input.ts";

// 全部用假 session 与假 /json/list，不连真实客户端、不发送真实输入、不碰 Windows GUI。

const TARGET_ID = "0123456789abcdef0123456789abcdef";
const DOC_UUID = "0123456789abcdef";
const PORT = 9222;
const WS_URL = `ws://127.0.0.1:${PORT}/devtools/page/${TARGET_ID}`;
const PAGE_TITLE = "嘉立创EDA(专业版) - V3.2.10";
const PAGE_URL = `https://pro.lceda.cn/editor#id=${TARGET_ID}`;

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

type Handler = (method: string, params: Record<string, unknown>, index: number) => unknown;

const GUARD_OK = { result: { value: { ok: true } } };

function guardResult(ok: boolean, reason = "focus"): unknown {
  return { result: { value: ok ? { ok: true } : { ok: false, reason } } };
}

function defaultHandler(method: string): unknown {
  return method === "Runtime.evaluate" ? GUARD_OK : {};
}

function fakeSession(handler: Handler = defaultHandler): {
  session: Pick<CdpSession, "call">;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const call = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    calls.push({ method, params });
    const outcome = await handler(method, params, calls.length - 1);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { session: { call } as unknown as Pick<CdpSession, "call">, calls };
}

function request(
  action: CdpInputAction,
  overrides: Partial<CdpInputRequest> = {},
): CdpInputRequest {
  return {
    port: PORT,
    target: TARGET_ID,
    documentUuid: DOC_UUID,
    confirm: true,
    action,
    ...overrides,
  };
}

function page(overrides: Partial<CdpTarget> = {}): CdpTarget {
  return {
    id: TARGET_ID,
    type: "page",
    title: PAGE_TITLE,
    url: PAGE_URL,
    webSocketDebuggerUrl: WS_URL,
    ...overrides,
  };
}

async function errorOf(promise: Promise<unknown>): Promise<CdpErrorLike> {
  try {
    await promise;
  } catch (error) {
    return error as CdpErrorLike;
  }
  throw new Error("期望 Promise 拒绝，但它成功了");
}

interface CdpErrorLike {
  code?: string;
  exitCode?: number;
  message?: string;
  details?: unknown;
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
  exitCode?: number,
): Promise<CdpErrorLike> {
  const error = await errorOf(promise);
  expect(error.code, error.message).toBe(code);
  if (exitCode !== undefined) expect(error.exitCode, error.message).toBe(exitCode);
  return error;
}

function validationError(input: CdpInputRequest): CdpErrorLike {
  try {
    validateCdpInputRequest(input);
  } catch (error) {
    return error as CdpErrorLike;
  }
  throw new Error("期望请求校验拒绝，但它通过了");
}

function inputCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method.startsWith("Input."));
}

/** 真实点击事件；忽略可选的初始 mouseMoved（契约允许，但不强制）。 */
function mouseEvents(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (call) => call.method === "Input.dispatchMouseEvent" && call.params.type !== "mouseMoved",
  );
}

function keyEvents(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method === "Input.dispatchKeyEvent");
}

function evaluateCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method === "Runtime.evaluate");
}

function withFetch<T>(targets: unknown, run: (urls: string[]) => Promise<T>): Promise<T> {
  const urls: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    urls.push(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    return { ok: true, json: async () => targets } as Response;
  });
  return run(urls).finally(() => spy.mockRestore());
}

// ─── 请求校验与 confirm：必须在 fetch / 连接 / Input 之前 ─────────────

test("confirm 不是 true 时在 fetch 与 Input 之前拒绝", async () => {
  const keyAction: CdpInputAction = { kind: "key", key: "Escape" };
  const missing: CdpInputRequest = {
    port: PORT,
    target: TARGET_ID,
    documentUuid: DOC_UUID,
    action: keyAction,
  };

  await withFetch([page()], async (urls) => {
    for (const input of [request(keyAction, { confirm: false }), missing]) {
      const error = await expectCode(sendCdpInput(input), "CDP_INPUT_CONFIRM", 3);
      expect(error.message).toContain("confirm");
    }
    // 连 /json/list 都没发，更不可能建立 CDP 会话或发 Input。
    expect(urls).toEqual([]);
  });
});

test("dispatchCdpInput 也独立校验 confirm，且不产生任何 session 调用", async () => {
  const { session, calls } = fakeSession();
  await expectCode(
    dispatchCdpInput(session, request({ kind: "text", text: "10k" }, { confirm: false })),
    "CDP_INPUT_CONFIRM",
    3,
  );
  expect(calls).toEqual([]);
});

test("非法请求在任何副作用之前按 CDP_INPUT_INVALID 拒绝", async () => {
  const invalid: CdpInputRequest[] = [
    request({ kind: "key", key: "Escape" }, { port: 0 }),
    request({ kind: "key", key: "Escape" }, { port: 65_536 }),
    request({ kind: "key", key: "Escape" }, { port: 1.5 }),
    request({ kind: "key", key: "Escape" }, { target: "not-a-target" }),
    request({ kind: "key", key: "Escape" }, { target: `${TARGET_ID}0` }),
    request({ kind: "key", key: "Escape" }, { documentUuid: "0123" }),
    request({ kind: "key", key: "Escape" }, { documentUuid: `zz${DOC_UUID}` }),
    request({ kind: "key", key: "Escape" }, { documentUuid: `${DOC_UUID}${"a".repeat(49)}` }),
    request({ kind: "click", x: 10, y: 10, clickCount: 3 as 1 | 2 }),
    request({ kind: "click", x: 10, y: 10, button: "middle" as "left" }),
    request({ kind: "click", x: Number.NaN, y: 10 }),
    request({ kind: "click", x: -1, y: 10 }),
    request({ kind: "click", x: 65_536, y: 10 }),
    request({ kind: "key", key: "F1" as "Escape" }),
    request({ kind: "text", text: "" }),
    request({ kind: "text", text: "x".repeat(INPUT_MAX_TEXT_LENGTH + 1) }),
    request({ kind: "text", text: "a\u0007b" }),
    request({ kind: "text", text: "a\u007fb" }),
    request({ kind: "scroll" as "text", text: "x" }),
  ];

  for (const input of invalid) {
    expect(validationError(input).code, JSON.stringify(input)).toBe("CDP_INPUT_INVALID");
  }

  // 边界合法值不应被误杀。
  const valid: CdpInputRequest[] = [
    request({ kind: "click", x: 0, y: 0 }),
    request({ kind: "click", x: 65_535, y: 65_535, button: "right", clickCount: 2 }),
    request({ kind: "text", text: "a".repeat(INPUT_MAX_TEXT_LENGTH) }),
    request({ kind: "text", text: "10k\t\n中文" }),
    request({ kind: "key", key: "Backspace" }),
    request({ kind: "key", key: "Escape" }, { documentUuid: "a".repeat(64) }),
  ];
  for (const input of valid) {
    expect(() => validateCdpInputRequest(input), JSON.stringify(input)).not.toThrow();
  }

  // 校验失败的 sendCdpInput 绝不发 HTTP，也不建立 CDP 会话。
  await withFetch([page()], async (urls) => {
    await expectCode(sendCdpInput(request({ kind: "click", x: -1, y: 0 })), "CDP_INPUT_INVALID", 2);
    expect(urls).toEqual([]);
  });
});

// ─── 精确选目标：loopback / port / id / origin / title / WS 路径 ──────

test("selectInputTarget 只接受精确匹配的 page、编辑器 origin 与同端口回环 WS", () => {
  expect(INPUT_EDITOR_ORIGINS).toEqual(["https://pro.lceda.cn", "https://client"]);
  expect(INPUT_EDITOR_PATH).toBe("/editor");

  expect(selectInputTarget([page()], PORT, TARGET_ID)).toBe(WS_URL);

  // 页面 URL 允许 query / hash；标题允许带「 | 」前缀；第二个受信 origin 也接受。
  const clientTarget = page({
    url: `https://client/editor?doc=${DOC_UUID}#id=${TARGET_ID}`,
    title: `PCB | ${PAGE_TITLE}`,
  });
  expect(selectInputTarget([clientTarget], PORT, TARGET_ID)).toBe(WS_URL);

  // 大小写不改变 id 语义（精确字符串匹配），WS 原样返回。
  const upper = page({ id: TARGET_ID.toUpperCase() });
  const upperWs = `ws://127.0.0.1:${PORT}/devtools/page/${TARGET_ID.toUpperCase()}`;
  expect(
    selectInputTarget(
      [page({ ...upper, webSocketDebuggerUrl: upperWs })],
      PORT,
      TARGET_ID.toUpperCase(),
    ),
  ).toBe(upperWs);
});

test("selectInputTarget 拒绝不确定目标：id 不存在/不唯一/非 page/非编辑器", () => {
  const cases: Array<[string, CdpTarget[]]> = [
    ["id 不存在", [page({ id: "f".repeat(32) })]],
    ["id 重复", [page(), page()]],
    [
      "id 重复且另一个不同端口",
      [page(), page({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/x" })],
    ],
    ["非 page", [page({ type: "iframe" })]],
    ["非 https origin", [page({ url: `http://pro.lceda.cn/editor#id=${TARGET_ID}` })]],
    ["未授权 origin", [page({ url: `https://easyeda.com/editor#id=${TARGET_ID}` })]],
    ["错误 pathname", [page({ url: `https://pro.lceda.cn/editor2#id=${TARGET_ID}` })]],
    ["页面 URL 带凭据", [page({ url: `https://user:pass@pro.lceda.cn/editor#id=${TARGET_ID}` })]],
    ["英文标题", [page({ title: "EasyEDA Pro - V3.2.10" })]],
    ["标题缺 V", [page({ title: "嘉立创EDA(专业版) - 3.2.10" })]],
    ["标题带后缀", [page({ title: "嘉立创EDA(专业版) - V3.2.10 (beta)" })]],
    ["缺少 WS URL", [page({ webSocketDebuggerUrl: "" })]],
    [
      "WS localhost",
      [page({ webSocketDebuggerUrl: `ws://localhost:${PORT}/devtools/page/${TARGET_ID}` })],
    ],
    [
      "WS 非回环",
      [page({ webSocketDebuggerUrl: `ws://192.168.1.2:${PORT}/devtools/page/${TARGET_ID}` })],
    ],
    [
      "WS 端口不一致",
      [page({ webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${TARGET_ID}` })],
    ],
    [
      "WS 路径不是该 target",
      [page({ webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/${"f".repeat(32)}` })],
    ],
    ["WS 带 query", [page({ webSocketDebuggerUrl: `${WS_URL}?x=1` })]],
    [
      "WS 非 ws",
      [page({ webSocketDebuggerUrl: `wss://127.0.0.1:${PORT}/devtools/page/${TARGET_ID}` })],
    ],
    [
      "WS 带凭据",
      [page({ webSocketDebuggerUrl: `ws://u:p@127.0.0.1:${PORT}/devtools/page/${TARGET_ID}` })],
    ],
    ["空目标列表", []],
  ];
  for (const [label, targets] of cases) {
    let caught: CdpErrorLike | null = null;
    try {
      selectInputTarget(targets, PORT, TARGET_ID);
    } catch (error) {
      caught = error as CdpErrorLike;
    }
    expect(caught, label).not.toBeNull();
    expect(caught?.code, label).toBe("CDP_INPUT_TARGET");
    expect(caught?.exitCode, label).toBe(2);
  }
});

test("selectInputTarget 的 port 与 target token 本身非法时报 CDP_INPUT_INVALID", () => {
  const cases: Array<[number, string]> = [
    [0, TARGET_ID],
    [65_536, TARGET_ID],
    [Number.NaN, TARGET_ID],
    [PORT, "not-hex"],
    [PORT, TARGET_ID.slice(0, 31)],
    [PORT, `${TARGET_ID}0`],
  ];
  for (const [port, target] of cases) {
    let caught: CdpErrorLike | null = null;
    try {
      selectInputTarget([page()], port, target);
    } catch (error) {
      caught = error as CdpErrorLike;
    }
    expect(caught, `${port}/${target}`).not.toBeNull();
    expect(caught?.code, `${port}/${target}`).toBe("CDP_INPUT_INVALID");
    expect(caught?.exitCode, `${port}/${target}`).toBe(2);
  }
});

test("sendCdpInput 先按端口拉 /json/list，目标不符则不连 WS", async () => {
  await withFetch(
    [page({ webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${TARGET_ID}` })],
    async (urls) => {
      await expectCode(
        sendCdpInput(request({ kind: "key", key: "Escape" })),
        "CDP_INPUT_TARGET",
        2,
      );
      expect(urls).toEqual([`http://127.0.0.1:${PORT}/json/list`]);
    },
  );

  await withFetch(null, async () => {
    await expectCode(sendCdpInput(request({ kind: "text", text: "10k" })), "CDP_INPUT_TARGET", 2);
  });
});

// ─── 点击：press/release 与双击计数 ─────────────────────────────────

test("单击只发 press/release，mouseMoved 可有可无，全程不碰窗口激活", async () => {
  const { session, calls } = fakeSession();
  const result = await dispatchCdpInput(session, request({ kind: "click", x: 120, y: 340 }));

  expect(result).toEqual({
    target: TARGET_ID,
    documentUuid: DOC_UUID,
    dispatched: 2,
    delivery: "protocol-acknowledged",
  });

  expect(mouseEvents(calls).map((call) => call.params)).toEqual([
    { type: "mousePressed", x: 120, y: 340, button: "left", clickCount: 1, buttons: 1 },
    { type: "mouseReleased", x: 120, y: 340, button: "left", clickCount: 1, buttons: 0 },
  ]);
  expect(mouseEvents(calls).every((call) => !("modifiers" in call.params))).toBe(true);
  expect(evaluateCalls(calls)).toHaveLength(2);
  // 只有守卫求值与 Input 域；没有 Page.bringToFront / Target.activateTarget / 系统键鼠。
  expect(
    calls.every((call) => call.method === "Runtime.evaluate" || call.method.startsWith("Input.")),
    calls.map((call) => call.method).join(","),
  ).toBe(true);
});

test("右键 press 的 buttons=2，release 归零", async () => {
  const { session, calls } = fakeSession();
  await dispatchCdpInput(session, request({ kind: "click", x: 8, y: 9, button: "right" }));
  expect(mouseEvents(calls).map((call) => call.params)).toEqual([
    { type: "mousePressed", x: 8, y: 9, button: "right", clickCount: 1, buttons: 2 },
    { type: "mouseReleased", x: 8, y: 9, button: "right", clickCount: 1, buttons: 0 },
  ]);
});

test("双击按 1/1/2/2 发送四条，两对之间重跑 click 守卫", async () => {
  const { session, calls } = fakeSession();
  const result = await dispatchCdpInput(
    session,
    request({ kind: "click", x: 600, y: 320, clickCount: 2 }),
  );

  expect(result.dispatched).toBe(4);
  expect(
    mouseEvents(calls).map((call) => [
      call.params.type,
      call.params.clickCount,
      call.params.buttons,
    ]),
  ).toEqual([
    ["mousePressed", 1, 1],
    ["mouseReleased", 1, 0],
    ["mousePressed", 2, 1],
    ["mouseReleased", 2, 0],
  ]);
  // 3 次守卫：pre(click) → 第一对 → click 复检 → 第二对 → post(identity)。
  expect(evaluateCalls(calls)).toHaveLength(3);
  expect(calls.map((call) => call.method)).toEqual([
    "Runtime.evaluate",
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "Runtime.evaluate",
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "Runtime.evaluate",
  ]);
  const middle = calls[3];
  expect(middle?.method).toBe("Runtime.evaluate");
  expect(calls[2]?.params.type).toBe("mouseReleased");
  expect(calls[4]?.params.type).toBe("mousePressed");
  expect(String(middle?.params.expression)).toContain("elementFromPoint");
});

test("双击中间守卫失败时已发出 2 条事件，报 UNCERTAIN 且不继续第二对", async () => {
  const { session, calls } = fakeSession((method, _params, index) => {
    if (method !== "Runtime.evaluate") return {};
    // 第 2 次 evaluate 是两对之间的 click 复检。
    return index === 3 ? guardResult(false, "hit") : GUARD_OK;
  });

  const error = await expectCode(
    dispatchCdpInput(session, request({ kind: "click", x: 600, y: 320, clickCount: 2 })),
    "CDP_INPUT_UNCERTAIN",
    4,
  );
  expect(mouseEvents(calls).map((call) => call.params.clickCount)).toEqual([1, 1]);
  expect((error.details as { dispatched?: number } | undefined)?.dispatched).toBe(2);
  expect(evaluateCalls(calls)).toHaveLength(2);
});

// ─── 固定键盘对与 insertText ────────────────────────────────────────

test("八个固定键各发一对 keyDown/keyUp，VK 表固定", async () => {
  expect(Object.keys(INPUT_KEY_CODES).sort()).toEqual(
    [
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "Backspace",
      "Enter",
      "Escape",
      "Tab",
    ].sort(),
  );
  const keys = [
    ["Escape", 27],
    ["Enter", 13],
    ["Tab", 9],
    ["ArrowUp", 38],
    ["ArrowDown", 40],
    ["ArrowLeft", 37],
    ["ArrowRight", 39],
    ["Backspace", 8],
  ] as const;

  for (const [key, vk] of keys) {
    const { session, calls } = fakeSession();
    const result = await dispatchCdpInput(session, request({ kind: "key", key }));

    expect(result.dispatched, key).toBe(2);
    expect(result.delivery, key).toBe("protocol-acknowledged");
    expect(evaluateCalls(calls), key).toHaveLength(2);
    expect(
      keyEvents(calls).map((call) => call.params),
      key,
    ).toEqual([
      { type: "keyDown", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk },
      { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk },
    ]);
    expect(
      keyEvents(calls).every((call) => !("text" in call.params) && !("modifiers" in call.params)),
      key,
    ).toBe(true);
  }
});

test("text 只发一条 Input.insertText，参数原样", async () => {
  const { session, calls } = fakeSession();
  const text = "10k\t\n中文";
  const result = await dispatchCdpInput(session, request({ kind: "text", text }));

  expect(result.dispatched).toBe(1);
  expect(inputCalls(calls).map((call) => [call.method, call.params])).toEqual([
    ["Input.insertText", { text }],
  ]);
  expect(evaluateCalls(calls)).toHaveLength(2);
});

// ─── 前后守卫与失败边界：不重试、不重放、不宣称业务失败 ─────────────

test("preflight 守卫失败时零 Input 调用并报 CDP_INPUT_GUARD", async () => {
  for (const reason of [
    "location",
    "document",
    "frame",
    "hit",
    "focus",
    "editable",
    "ui",
    "modal",
    "api",
    "viewport",
    "unknown",
  ]) {
    const { session, calls } = fakeSession((method) =>
      method === "Runtime.evaluate" ? guardResult(false, reason) : {},
    );
    const error = await expectCode(
      dispatchCdpInput(session, request({ kind: "key", key: "Escape" })),
      "CDP_INPUT_GUARD",
      3,
    );
    expect(inputCalls(calls), reason).toEqual([]);
    expect(evaluateCalls(calls), reason).toHaveLength(1);
    expect((error.details as { reason?: string } | undefined)?.reason, reason).toBe(reason);
  }
});

test("preflight 求值异常、异常返回与错误形状一律 fail closed", async () => {
  const failures: Handler[] = [
    (method) => {
      if (method === "Runtime.evaluate") throw new Error("transport down");
      return {};
    },
    (method) => (method === "Runtime.evaluate" ? { exceptionDetails: { text: "boom" } } : {}),
    (method) => (method === "Runtime.evaluate" ? { result: { value: null } } : {}),
    (method) => (method === "Runtime.evaluate" ? { result: { value: { ok: "yes" } } } : {}),
    (method) => (method === "Runtime.evaluate" ? { result: {} } : {}),
  ];
  for (const handler of failures) {
    const { session, calls } = fakeSession(handler);
    await expectCode(
      dispatchCdpInput(session, request({ kind: "click", x: 1, y: 2 })),
      "CDP_INPUT_GUARD",
      3,
    );
    expect(inputCalls(calls)).toEqual([]);
  }
});

test("post 守卫失败：Input 已发出，报 UNCERTAIN 且不重放", async () => {
  const { session, calls } = fakeSession((method, _params, index) => {
    if (method !== "Runtime.evaluate") return {};
    // index 0=pre，之后=post
    return guardResult(index === 0, "document");
  });

  const error = await expectCode(
    dispatchCdpInput(session, request({ kind: "key", key: "Escape" })),
    "CDP_INPUT_UNCERTAIN",
    4,
  );
  expect(keyEvents(calls)).toHaveLength(2);
  expect(keyEvents(calls).filter((call) => call.params.type === "keyDown")).toHaveLength(1);
  expect(evaluateCalls(calls)).toHaveLength(2);
  expect((error.details as { dispatched?: number } | undefined)?.dispatched).toBe(2);
});

test("post 守卫求值异常同样报 UNCERTAIN，不补发任何事件", async () => {
  let guardCalls = 0;
  const { session, calls } = fakeSession((method) => {
    if (method !== "Runtime.evaluate") return {};
    guardCalls += 1;
    // 双击有 pre + 中间复检两次成功守卫；第三次（post identity）抛传输异常。
    if (guardCalls <= 2) return GUARD_OK;
    throw new Error("guard transport down");
  });

  await expectCode(
    dispatchCdpInput(session, request({ kind: "click", x: 10, y: 20, clickCount: 2 })),
    "CDP_INPUT_UNCERTAIN",
    4,
  );
  // 双击的四条已全部成功 ack，post 守卫异常后不重放。
  expect(mouseEvents(calls)).toHaveLength(4);
  expect(mouseEvents(calls).filter((call) => call.params.type === "mousePressed")).toHaveLength(2);
  expect(evaluateCalls(calls)).toHaveLength(3);
});

test("keyUp 传输失败：press 成功则不重放，报 UNCERTAIN", async () => {
  const { session, calls } = fakeSession((method, params) => {
    if (method === "Runtime.evaluate") return GUARD_OK;
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") {
      return new Error("socket closed");
    }
    return {};
  });

  const error = await expectCode(
    dispatchCdpInput(session, request({ kind: "key", key: "Enter" })),
    "CDP_INPUT_UNCERTAIN",
    4,
  );
  expect(keyEvents(calls).map((call) => call.params.type)).toEqual(["keyDown", "keyUp"]);
  expect((error.details as { dispatched?: number } | undefined)?.dispatched).toBe(1);
});

test("mouseReleased 失败时只尝试一次 release，不补发、不重放 press", async () => {
  const { session, calls } = fakeSession((method, params) => {
    if (method === "Runtime.evaluate") return GUARD_OK;
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
      return new Error("send failed");
    }
    return {};
  });

  const error = await expectCode(
    dispatchCdpInput(session, request({ kind: "click", x: 30, y: 40 })),
    "CDP_INPUT_UNCERTAIN",
    4,
  );
  const events = mouseEvents(calls);
  expect(events.filter((call) => call.params.type === "mousePressed")).toHaveLength(1);
  // press 已 ack、release 只尝试一次；不再补发 release。
  expect(events.filter((call) => call.params.type === "mouseReleased")).toHaveLength(1);
  expect(events.filter((call) => call.params.type === "mousePressed")[0]?.params.clickCount).toBe(
    1,
  );
  expect((error.details as { dispatched?: number } | undefined)?.dispatched).toBe(1);
});

test("首条 Input 就失败（0 条 ack）时报 UNCERTAIN，不尝试 release", async () => {
  const failure = Object.assign(new Error("transport"), { code: "CDP_ERROR", exitCode: 4 });
  const { session, calls } = fakeSession((method) => {
    if (method === "Runtime.evaluate") return GUARD_OK;
    if (method === "Input.dispatchMouseEvent") return failure;
    return {};
  });

  const error = await expectCode(
    dispatchCdpInput(session, request({ kind: "click", x: 1, y: 1 })),
    "CDP_INPUT_UNCERTAIN",
    4,
  );
  expect((error.details as { dispatched?: number } | undefined)?.dispatched).toBe(0);
  // press 未被 ack，因此没有可补发的 release；事件只尝试过一次。
  expect(mouseEvents(calls).map((call) => call.params.type)).toEqual(["mousePressed"]);
});

test("取消：调用前 abort 报 CANCELLED 且零调用；已发出后 abort 归 UNCERTAIN", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const { session: idleSession, calls: idleCalls } = fakeSession();
  const cancelled = await expectCode(
    dispatchCdpInput(idleSession, request({ kind: "key", key: "Escape" }), aborted.signal),
    "CANCELLED",
  );
  expect(cancelled.message).toContain("取消");
  expect(idleCalls).toEqual([]);

  const controller = new AbortController();
  const { session, calls } = fakeSession((method, params) => {
    if (method === "Runtime.evaluate") return GUARD_OK;
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") {
      controller.abort();
      return Object.assign(new Error("cancelled"), { code: "CANCELLED", exitCode: 1 });
    }
    return {};
  });
  await expectCode(
    dispatchCdpInput(session, request({ kind: "key", key: "Tab" }), controller.signal),
    "CDP_INPUT_UNCERTAIN",
    4,
  );
  expect(keyEvents(calls).filter((call) => call.params.type === "keyDown")).toHaveLength(1);
});

test("同一 session 并发 dispatch 被拒绝，不产生第二条输入通道", async () => {
  let releaseGuard: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGuard = resolve;
  });
  let firstGuard = true;
  const { session, calls } = fakeSession(async (method) => {
    if (method === "Runtime.evaluate" && firstGuard) {
      firstGuard = false;
      await gate;
      return GUARD_OK;
    }
    return method === "Runtime.evaluate" ? GUARD_OK : {};
  });

  const first = dispatchCdpInput(session, request({ kind: "text", text: "a" }));
  for (let attempt = 0; attempt < 20 && calls.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  expect(calls).toHaveLength(1);

  await expectCode(
    dispatchCdpInput(session, request({ kind: "text", text: "b" })),
    "CDP_INPUT_GUARD",
    3,
  );
  releaseGuard?.();
  await expect(first).resolves.toMatchObject({ dispatched: 1 });
  // 第二个请求没有进入 session。
  expect(calls.filter((call) => call.method === "Input.insertText")).toHaveLength(1);
  expect(calls.filter((call) => call.params.text === "b")).toEqual([]);
});

test("守卫表达式是 async IIFE 且按 pre/post 模式生成", () => {
  const click = inputGuardExpression({ mode: "click", documentUuid: DOC_UUID, x: 12, y: 34 });
  const key = inputGuardExpression({ mode: "key", documentUuid: DOC_UUID });
  const text = inputGuardExpression({ mode: "text", documentUuid: DOC_UUID });
  const identity = inputGuardExpression({ mode: "identity", documentUuid: DOC_UUID });

  for (const expression of [click, key, text, identity]) {
    expect(expression).toContain(DOC_UUID);
    expect(expression).toContain("_EXTAPI_ROOT_");
    expect(expression).toContain("async");
    expect(expression).toContain("hasVisibleModal");
    expect(expression).toContain("lc_modal");
    expect(expression).not.toContain("bringToFront");
  }
  expect(click).toContain("12");
  expect(click).toContain("34");
  expect(click).toContain("elementFromPoint");
  expect(click).toContain("CANVAS");
  expect(key).toContain("activeElement");
  expect(key).not.toContain("elementFromPoint");
  expect(text).toContain("activeElement");
  expect(text).not.toContain("elementFromPoint");
  expect(identity).not.toContain("activeElement");
  expect(identity).not.toContain("elementFromPoint");
});

// ─── 用假 DOM 实跑守卫表达式：命中/焦点/可编辑/身份前后置语义 ─────────

interface GuardDomOptions {
  origin?: string;
  pathname?: string;
  readyState?: string;
  readyStateAfterAwait?: string;
  markerCount?: number;
  api?: "ok" | "missing" | "throws";
  missingApi?: "pcb" | "select";
  pcbUuid?: string;
  docUuid?: string;
  documentType?: number;
  pcbParentProjectUuid?: string;
  docParentProjectUuid?: string;
  driftLocation?: boolean;
  modal?: boolean;
  modalAfterAwait?: boolean;
  modalHidden?: boolean;
  innerModal?: boolean;
  frameCount?: number;
  frameSrc?: string;
  frameUrl?: string;
  frameReadyState?: string;
  frameSrcdoc?: boolean;
  smallModal?: boolean;
  frameClientWidth?: number;
  frameClientHeight?: number;
  width?: number;
  height?: number;
  outerActive?: "frame" | "elsewhere";
  innerActive?: {
    tagName: string;
    isContentEditable?: boolean;
    type?: string;
    disabled?: boolean;
    readOnly?: boolean;
    hidden?: boolean;
    ariaDisabled?: boolean;
    inert?: boolean;
  };
  hit?: "frame" | "none";
  innerHit?: "plain" | "none" | "blocked" | "panel";
}

function guardSandbox(options: GuardDomOptions = {}): Record<string, unknown> {
  const innerBody = { tagName: "BODY" };
  const modalNode = {
    checkVisibility: () => options.modalHidden !== true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 640,
      bottom: 480,
      width: options.smallModal ? 20 : 640,
      height: options.smallModal ? 10 : 480,
    }),
    innerText: options.smallModal ? "" : "确认",
  };
  let modalVisible = options.modal === true;
  const innerActive = options.innerActive
    ? {
        ...options.innerActive,
        hidden: options.innerActive.hidden === true,
        closest: () => (options.innerActive?.inert ? { tagName: "DIV" } : null),
        getAttribute: (name: string) =>
          name === "aria-disabled" && options.innerActive?.ariaDisabled ? "true" : null,
      }
    : innerBody;
  const innerHit =
    options.innerHit === "none"
      ? null
      : {
          tagName: options.innerHit === "panel" ? "DIV" : "CANVAS",
          closest: () => (options.innerHit === "blocked" ? { tagName: "BUTTON" } : null),
        };
  const innerDocument = {
    URL: options.frameUrl ?? "https://pro.lceda.cn/editframe",
    readyState: options.frameReadyState ?? "complete",
    visibilityState: "visible",
    activeElement: innerActive,
    body: innerBody,
    elementFromPoint: () => innerHit,
    querySelectorAll: (selector: string) =>
      selector === INPUT_MODAL_SELECTOR && options.innerModal === true ? [modalNode] : [],
  };
  const frame = {
    src: options.frameSrc ?? "https://pro.lceda.cn/editframe",
    hasAttribute: (name: string) => name === "srcdoc" && options.frameSrcdoc === true,
    clientWidth: options.frameClientWidth ?? 1200,
    clientHeight: options.frameClientHeight ?? 900,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 1200,
      bottom: 900,
      width: 1200,
      height: 900,
    }),
    contentDocument: innerDocument,
  };
  const markers = ["#main", "#top-wrap", "#canvas-work-space", "#toolbar-bottom"].slice(
    0,
    options.markerCount ?? 2,
  );
  const frames = Array.from({ length: options.frameCount ?? 1 }, (_, index) =>
    index === 0 ? frame : { ...frame },
  );
  const location = {
    origin: options.origin ?? "https://pro.lceda.cn",
    pathname: options.pathname ?? "/editor",
    href: "https://pro.lceda.cn/editor",
  };
  const document = {
    visibilityState: "visible",
    readyState: options.readyState ?? "complete",
    activeElement: options.outerActive === "elsewhere" ? { tagName: "DIV" } : frame,
    body: innerBody,
    querySelector: (selector: string) => (markers.includes(selector) ? {} : null),
    querySelectorAll: (selector: string) => {
      if (selector === "iframe.editframe") return frames;
      if (selector === INPUT_MODAL_SELECTOR) return modalVisible ? [modalNode] : [];
      return [];
    },
    elementFromPoint: () => (options.hit === "none" ? null : frame),
  };
  const sandbox: Record<string, unknown> = {
    location,
    document,
    innerWidth: options.width ?? 1600,
    innerHeight: options.height ?? 1000,
    URL,
  };
  if (options.api !== "missing") {
    sandbox._EXTAPI_ROOT_ = {
      ...(options.missingApi === "pcb"
        ? {}
        : {
            dmt_Pcb: {
              getCurrentPcbInfo: async () => {
                if (options.api === "throws") throw new Error("pcb api boom");
                return {
                  uuid: options.pcbUuid ?? DOC_UUID,
                  ...(options.pcbParentProjectUuid === undefined
                    ? {}
                    : { parentProjectUuid: options.pcbParentProjectUuid }),
                };
              },
            },
          }),
      ...(options.missingApi === "select"
        ? {}
        : {
            dmt_SelectControl: {
              getCurrentDocumentInfo: async () => {
                if (options.api === "throws") throw new Error("select api boom");
                if (options.driftLocation) location.origin = "https://evil.test";
                // 模拟 await 期间页面变化：弹层在 API 返回前才挂上。
                if (options.modalAfterAwait) modalVisible = true;
                if (options.readyStateAfterAwait)
                  document.readyState = options.readyStateAfterAwait;
                return {
                  uuid: options.docUuid ?? DOC_UUID,
                  documentType: options.documentType ?? 3,
                  ...(options.docParentProjectUuid === undefined
                    ? {}
                    : { parentProjectUuid: options.docParentProjectUuid }),
                };
              },
            },
          }),
    };
  }
  return sandbox;
}

async function runGuardOnFakeDom(
  mode: "click" | "key" | "text" | "identity",
  options: GuardDomOptions = {},
  point: { x: number; y: number } = { x: 100, y: 100 },
): Promise<{ ok?: boolean; reason?: string }> {
  const expression = inputGuardExpression({
    mode,
    documentUuid: DOC_UUID,
    ...(mode === "click" ? point : {}),
  });
  return (await vm.runInNewContext(expression, guardSandbox(options))) as {
    ok?: boolean;
    reason?: string;
  };
}

test("所有动作拒绝仍带旧 src 但已导航、未就绪或切为 srcdoc 的画布", async () => {
  for (const mode of ["click", "key", "text", "identity"] as const) {
    for (const options of [
      { frameUrl: "https://pro.lceda.cn/unrelated-page" },
      { frameUrl: "https://pro.lceda.cn/editframe?entry=other" },
      { frameUrl: "https://other.test/editframe" },
      { frameUrl: "about:blank" },
      { frameReadyState: "loading" },
      { frameSrcdoc: true },
    ]) {
      expect(await runGuardOnFakeDom(mode, options)).toEqual({ ok: false, reason: "frame" });
    }
  }
});

test("输入守卫拒绝尺寸很小且不含文字的可见模态框", async () => {
  for (const mode of ["click", "key", "text"] as const) {
    expect(await runGuardOnFakeDom(mode, { modal: true, smallModal: true })).toEqual({
      ok: false,
      reason: "modal",
    });
    expect(await runGuardOnFakeDom(mode, { innerModal: true, smallModal: true })).toEqual({
      ok: false,
      reason: "modal",
    });
  }
});

test("守卫表达式在假 DOM 上按 click 命中、内层命中与视口判定", async () => {
  expect(await runGuardOnFakeDom("click")).toEqual({ ok: true });
  expect(await runGuardOnFakeDom("click", {}, { x: 2000, y: 100 })).toEqual({
    ok: false,
    reason: "viewport",
  });
  expect(await runGuardOnFakeDom("click", {}, { x: 100, y: 950 })).toEqual({
    ok: false,
    reason: "viewport",
  });
  expect(await runGuardOnFakeDom("click", { hit: "none" })).toEqual({ ok: false, reason: "hit" });
  // 内层画布视口尺寸无效 / 坐标超出 clientWidth 都算 viewport。
  expect(await runGuardOnFakeDom("click", { frameClientWidth: 0 })).toEqual({
    ok: false,
    reason: "viewport",
  });
  expect(await runGuardOnFakeDom("click", { frameClientWidth: 50 })).toEqual({
    ok: false,
    reason: "viewport",
  });
  // iframe 内没有命中元素，或命中交互控件/弹层，都算 hit。
  expect(await runGuardOnFakeDom("click", { innerHit: "none" })).toEqual({
    ok: false,
    reason: "hit",
  });
  expect(await runGuardOnFakeDom("click", { innerHit: "blocked" })).toEqual({
    ok: false,
    reason: "hit",
  });
  // 内层普通 DIV 浮层/面板也不算命中，只接受真正的 CANVAS。
  expect(await runGuardOnFakeDom("click", { innerHit: "panel" })).toEqual({
    ok: false,
    reason: "hit",
  });
  // 有可见模态弹层时 click 前置守卫直接拒绝；隐藏弹层不算。
  expect(await runGuardOnFakeDom("click", { modal: true })).toEqual({
    ok: false,
    reason: "modal",
  });
  expect(await runGuardOnFakeDom("click", { modalHidden: true })).toEqual({ ok: true });
  // iframe 内的可见弹层同样拒绝。
  expect(await runGuardOnFakeDom("click", { innerModal: true })).toEqual({
    ok: false,
    reason: "modal",
  });
});

test("守卫表达式在假 DOM 上按 key/text 检查焦点与可编辑状态", async () => {
  expect(await runGuardOnFakeDom("key", { innerActive: { tagName: "BODY" } })).toEqual({
    ok: true,
  });
  expect(await runGuardOnFakeDom("key", { outerActive: "elsewhere" })).toEqual({
    ok: false,
    reason: "focus",
  });
  expect(await runGuardOnFakeDom("key", { innerActive: { tagName: "INPUT" } })).toEqual({
    ok: false,
    reason: "editable",
  });
  // key 也受模态弹层门禁，包括 iframe 内弹层。
  expect(await runGuardOnFakeDom("key", { modal: true })).toEqual({ ok: false, reason: "modal" });
  expect(await runGuardOnFakeDom("key", { innerModal: true })).toEqual({
    ok: false,
    reason: "modal",
  });
  expect(
    await runGuardOnFakeDom("key", { innerActive: { tagName: "CANVAS", inert: true } }),
  ).toEqual({ ok: false, reason: "focus" });

  // text 只接受普通文本输入控件，且必须可用。
  for (const type of ["text", "search", "tel", "url", "email", "number"]) {
    expect(
      await runGuardOnFakeDom("text", { innerActive: { tagName: "INPUT", type } }),
      type,
    ).toEqual({ ok: true });
  }
  for (const type of ["password", "file", "hidden", "checkbox", "radio", "button", "submit"]) {
    expect(
      await runGuardOnFakeDom("text", { innerActive: { tagName: "INPUT", type } }),
      type,
    ).toEqual({ ok: false, reason: "editable" });
  }
  expect(
    await runGuardOnFakeDom("text", { innerActive: { tagName: "INPUT", disabled: true } }),
  ).toEqual({ ok: false, reason: "editable" });
  expect(
    await runGuardOnFakeDom("text", { innerActive: { tagName: "INPUT", readOnly: true } }),
  ).toEqual({ ok: false, reason: "editable" });
  expect(
    await runGuardOnFakeDom("text", { innerActive: { tagName: "INPUT", hidden: true } }),
  ).toEqual({ ok: false, reason: "editable" });
  expect(
    await runGuardOnFakeDom("text", { innerActive: { tagName: "INPUT", ariaDisabled: true } }),
  ).toEqual({ ok: false, reason: "editable" });
  expect(
    await runGuardOnFakeDom("text", { innerActive: { tagName: "INPUT", inert: true } }),
  ).toEqual({ ok: false, reason: "editable" });
  expect(await runGuardOnFakeDom("text", { innerActive: { tagName: "TEXTAREA" } })).toEqual({
    ok: true,
  });
  expect(
    await runGuardOnFakeDom("text", {
      innerActive: { tagName: "TEXTAREA", disabled: true },
    }),
  ).toEqual({ ok: false, reason: "editable" });
  expect(
    await runGuardOnFakeDom("text", {
      innerActive: { tagName: "DIV", isContentEditable: true },
    }),
  ).toEqual({ ok: true });
  expect(await runGuardOnFakeDom("text", { innerActive: { tagName: "BODY" } })).toEqual({
    ok: false,
    reason: "editable",
  });
});

test("identity 守卫只查身份，不查焦点/命中/模态（点击开菜单、Esc 掉焦点是正常效果）", async () => {
  expect(
    await runGuardOnFakeDom("identity", { outerActive: "elsewhere", hit: "none", modal: true }),
  ).toEqual({ ok: true });
  // post 阶段即使弹层刚出现也不拦（只有 pre 查 modal）。
  expect(await runGuardOnFakeDom("identity", { modalAfterAwait: true })).toEqual({ ok: true });
});

test("await 期间弹层/readyState 变化：pre 守卫在 API 返回后复查并拒绝", async () => {
  // 队长复现的回归：两个 API await 期间弹层才挂上，而 iframe 焦点仍在。
  for (const mode of ["click", "key", "text"] as const) {
    const options =
      mode === "text"
        ? { modalAfterAwait: true, innerActive: { tagName: "INPUT", isContentEditable: false } }
        : { modalAfterAwait: true };
    expect(await runGuardOnFakeDom(mode, options), mode).toEqual({
      ok: false,
      reason: "modal",
    });
  }
  // readyState 也必须在 await 后复查。
  expect(await runGuardOnFakeDom("click", { readyStateAfterAwait: "interactive" })).toEqual({
    ok: false,
    reason: "ui",
  });
});

test("守卫表达式校验活动文档：pcb uuid、document uuid/type、project 归属与二次 location", async () => {
  expect(await runGuardOnFakeDom("click", { pcbUuid: "f".repeat(16) })).toEqual({
    ok: false,
    reason: "document",
  });
  expect(await runGuardOnFakeDom("click", { docUuid: "f".repeat(16) })).toEqual({
    ok: false,
    reason: "document",
  });
  expect(await runGuardOnFakeDom("click", { documentType: 2 })).toEqual({
    ok: false,
    reason: "document",
  });
  expect(
    await runGuardOnFakeDom("click", {
      pcbParentProjectUuid: "a".repeat(16),
      docParentProjectUuid: "b".repeat(16),
    }),
  ).toEqual({ ok: false, reason: "document" });
  expect(
    await runGuardOnFakeDom("click", {
      pcbParentProjectUuid: "a".repeat(16),
      docParentProjectUuid: "a".repeat(16),
    }),
  ).toEqual({ ok: true });
  // 两个 API await 完成后再次核对 location，中途跳转必须拒绝。
  expect(await runGuardOnFakeDom("click", { driftLocation: true })).toEqual({
    ok: false,
    reason: "location",
  });
});

test("守卫表达式拒绝错误来源、UI 外壳、iframe 与缺失/异常的编辑器 API", async () => {
  expect(await runGuardOnFakeDom("click", { origin: "https://evil.test" })).toEqual({
    ok: false,
    reason: "location",
  });
  expect(await runGuardOnFakeDom("click", { pathname: "/editor2" })).toEqual({
    ok: false,
    reason: "location",
  });
  expect(await runGuardOnFakeDom("click", { readyState: "loading" })).toEqual({
    ok: false,
    reason: "ui",
  });
  expect(await runGuardOnFakeDom("click", { markerCount: 1 })).toEqual({ ok: false, reason: "ui" });
  expect(await runGuardOnFakeDom("click", { frameCount: 2 })).toEqual({
    ok: false,
    reason: "frame",
  });
  expect(await runGuardOnFakeDom("click", { frameSrc: "https://evil.test/editframe" })).toEqual({
    ok: false,
    reason: "frame",
  });
  expect(await runGuardOnFakeDom("click", { api: "missing" })).toEqual({
    ok: false,
    reason: "api",
  });
  expect(await runGuardOnFakeDom("click", { missingApi: "pcb" })).toEqual({
    ok: false,
    reason: "api",
  });
  expect(await runGuardOnFakeDom("click", { missingApi: "select" })).toEqual({
    ok: false,
    reason: "api",
  });
  expect(await runGuardOnFakeDom("click", { api: "throws" })).toEqual({
    ok: false,
    reason: "error",
  });
});
