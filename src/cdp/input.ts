import { ToolError } from "../mcp/types.ts";
import { DEFAULT_CDP_HOST } from "./discover.ts";
import { CdpError } from "./errors.ts";
import { CdpSession } from "./session.ts";
import type { CdpTarget } from "./targets.ts";
import { UI_SHELL_MARKERS, UI_SHELL_MIN_MARKERS } from "./uiShell.ts";

/**
 * 定向 CDP 输入。
 *
 * 只向下述固定路径发事件：`127.0.0.1:<port>/json/list` 里唯一一个精确 page target，
 * 并且它的 `devtools/page/<id>` WebSocket 仍绑定同一回环端口。事件只发往该 target
 * 的主 frame，不申请系统焦点、不移动全局鼠标、不调用 bringToFront，也不走 JS 合成事件。
 * 键动作只覆盖固定的无修饰单键，不发 Ctrl/Alt/Shift/Meta 组合键。
 *
 * 发事件前后各跑一次固定的 `Runtime.evaluate` 守卫：发前按动作类型检查编辑器外壳、
 * 活动 PCB UUID、`iframe.editframe`、命中点或焦点；发后只复查身份（UI、PCB UUID、
 * 同源 editframe），不复查命中与焦点——点击会开菜单，Esc 会让画布 iframe 失焦，
 * 这些是本 API 的正常效果。双击的第二对事件之前再插一次 click 守卫。返回值只表示
 * CDP 协议已 ack，不表示业务成功；事件一旦发出，后续异常一律按结果未知处理，不做
 * 补偿性的再输入（不重放 press、不补发 release）。
 */

export type CdpInputAction =
  | {
      kind: "click";
      x: number;
      y: number;
      button?: "left" | "right";
      clickCount?: 1 | 2;
    }
  | {
      kind: "key";
      /** 只允许无修饰的固定单键；不支持 Ctrl/Alt/Shift/Meta 组合键。 */
      key:
        | "Escape"
        | "Enter"
        | "Tab"
        | "ArrowUp"
        | "ArrowDown"
        | "ArrowLeft"
        | "ArrowRight"
        | "Backspace";
    }
  | { kind: "text"; text: string };

export interface CdpInputRequest {
  port: number;
  target: string;
  documentUuid: string;
  confirm?: boolean;
  action: CdpInputAction;
}

export interface CdpInputResult {
  target: string;
  documentUuid: string;
  dispatched: number;
  delivery: "protocol-acknowledged";
}

export interface CdpInputOptions {
  signal?: AbortSignal;
}

/** 只接受本机回环端点；与 discover/session 的口径一致。 */
export const INPUT_HOST = DEFAULT_CDP_HOST;
/** 允许的编辑器来源：中文专业版 Web（pro.lceda.cn）和桌面客户端（https://client）。 */
export const INPUT_EDITOR_ORIGINS: readonly string[] = ["https://pro.lceda.cn", "https://client"];
/** 编辑器主页面路径。 */
export const INPUT_EDITOR_PATH = "/editor";
/** 中文专业版标题：`<工程名> | 嘉立创EDA(专业版) - V4.1.105`（版本号不锁死）。 */
export const INPUT_EDITOR_TITLE_PATTERN = /(?:^| \| )嘉立创EDA\(专业版\) - V\d+(?:\.\d+)+$/;
/** 文本动作的 UTF-16 长度上限。 */
export const INPUT_MAX_TEXT_LENGTH = 1024;
/** 坐标是相对主 frame 视口的 CSS 像素，限定在有限的正整数域内。 */
export const INPUT_MAX_COORDINATE = 65_535;
/** 读 `/json/list` 的 HTTP 超时。 */
export const INPUT_HTTP_TIMEOUT_MS = 5_000;
/** 识别原生、ARIA 和上游常见类名的可见弹层，不要求最小尺寸或文字。 */
export const INPUT_MODAL_SELECTOR =
  'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [class*="lc_modal"], [class*="modal"], [class*="dialog"]';

/** 允许发送的按键；`code` 与 `key` 同名，虚拟键码沿用 Windows 口径。 */
export const INPUT_KEY_CODES = {
  Escape: { code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  Enter: { code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
} as const;

export type CdpInputKey = keyof typeof INPUT_KEY_CODES;

type NormalizedAction =
  | { kind: "click"; x: number; y: number; button: "left" | "right"; clickCount: 1 | 2 }
  | { kind: "key"; key: CdpInputKey }
  | { kind: "text"; text: string };

type NormalizedClick = Extract<NormalizedAction, { kind: "click" }>;
type NormalizedKey = Extract<NormalizedAction, { kind: "key" }>;
type NormalizedText = Extract<NormalizedAction, { kind: "text" }>;

interface InputEvent {
  method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent" | "Input.insertText";
  params: Record<string, unknown>;
}

export type CdpInputGuardMode = "click" | "key" | "text" | "identity";

export interface CdpInputGuardOptions {
  mode: CdpInputGuardMode;
  documentUuid: string;
  x?: number;
  y?: number;
}

interface EvaluationReply {
  exceptionDetails?: unknown;
  result?: { value?: unknown };
}

/** 守卫表达式的固定失败码；只用于本地文案映射，不回显页面内容。 */
const GUARD_MESSAGES: Readonly<Record<string, string>> = {
  location: "编辑器地址已变化",
  ui: "编辑器界面未通过校验",
  modal: "编辑器上有弹层/对话框打开",
  api: "页面主世界没有可用的编辑器 API",
  document: "活动 PCB 与目标文档不符",
  frame: "编辑画布 iframe 不是唯一的同源目标",
  viewport: "点击坐标不在可见画布范围内",
  hit: "点击坐标未命中编辑画布",
  focus: "键盘焦点不在编辑画布内",
  editable: "焦点控件的可编辑状态不适合该输入",
  transport: "守卫求值没有响应",
  exception: "守卫求值抛异常",
  error: "守卫求值异常",
  unknown: "守卫结果形状不合法",
};

const TARGET_ID_PATTERN = /^[0-9A-Fa-f]{32}$/;
const DOCUMENT_UUID_PATTERN = /^[0-9A-Fa-f]{16,64}$/;

/** 拒绝 C0/DEL 控制符，只放行制表与换行。 */
function hasUnsafeControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) return true;
  }
  return false;
}

/** 进程内并发闸：同一端口/目标只允许一个 sendCdpInput 在飞。 */
const ACTIVE_REQUESTS = new Set<string>();
/** 同一 session 对象上不允许两个 dispatchCdpInput 并发。 */
const ACTIVE_SESSIONS = new WeakSet<object>();

function invalid(message: string): never {
  throw new CdpError("CDP_INPUT_INVALID", message, { exitCode: 2 });
}

function targetError(message: string): never {
  throw new CdpError("CDP_INPUT_TARGET", message, { exitCode: 2 });
}

function cancelled(): ToolError {
  return new ToolError("CANCELLED", "CDP 输入已取消");
}

function uncertain(request: CdpInputRequest, dispatched: number, cause: unknown): CdpError {
  return new CdpError(
    "CDP_INPUT_UNCERTAIN",
    "输入事件已发出，但无法确认协议完整性或编辑器是否仍为同一文档；结果未知，请勿直接重试。",
    {
      exitCode: 4,
      details: { target: request.target, documentUuid: request.documentUuid, dispatched },
      cause,
    },
  );
}

function isCancelled(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "CANCELLED"
  );
}

function guardError(reason: string): CdpError {
  const known = Object.hasOwn(GUARD_MESSAGES, reason);
  const message = known ? (GUARD_MESSAGES[reason] ?? "守卫结果形状不合法") : "守卫结果形状不合法";
  return new CdpError("CDP_INPUT_GUARD", `调度前守卫拒绝：${message}`, {
    exitCode: 3,
    details: { reason: known ? reason : "unknown" },
  });
}

/**
 * 纯校验；`sendCdpInput` 在联网前调用，`dispatchCdpInput` 在发任何 CDP 方法前也会调用。
 *
 * 顺序固定：结构 → confirm → port → target → documentUuid → action。
 * `confirm` 只接受字面量 `true`，缺省或 false 都在这里拒绝。
 */
export function validateCdpInputRequest(request: unknown): void {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    invalid("输入请求不是对象");
  }
  const candidate = request as unknown as Record<string, unknown>;
  if (candidate.confirm !== true) {
    throw new CdpError(
      "CDP_INPUT_CONFIRM",
      "定向输入是写操作，确认影响后以 confirm: true 重新调用。",
      {
        exitCode: 3,
      },
    );
  }
  const port = candidate.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    invalid("port 必须是 1..65535 的整数");
  }
  const target = candidate.target;
  if (typeof target !== "string" || !TARGET_ID_PATTERN.test(target)) {
    invalid("target 必须是 32 位十六进制 page id");
  }
  const documentUuid = candidate.documentUuid;
  if (typeof documentUuid !== "string" || !DOCUMENT_UUID_PATTERN.test(documentUuid)) {
    invalid("documentUuid 必须是 16–64 位十六进制文档 id");
  }
  normalizeAction(candidate.action);
}

function normalizeInputRequest(request: CdpInputRequest): NormalizedAction {
  validateCdpInputRequest(request);
  return normalizeAction((request as unknown as Record<string, unknown>).action);
}

function normalizeAction(raw: unknown): NormalizedAction {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    invalid("action 不是对象");
  }
  const action = raw as Record<string, unknown>;
  switch (action.kind) {
    case "click": {
      const x = action.x;
      const y = action.y;
      if (
        typeof x !== "number" ||
        !Number.isFinite(x) ||
        x < 0 ||
        x > INPUT_MAX_COORDINATE ||
        typeof y !== "number" ||
        !Number.isFinite(y) ||
        y < 0 ||
        y > INPUT_MAX_COORDINATE
      ) {
        invalid(`click 的 x/y 必须是 0..${INPUT_MAX_COORDINATE} 的有限数`);
      }
      const button = action.button ?? "left";
      if (button !== "left" && button !== "right") invalid("click 的 button 只能是 left / right");
      const clickCount = action.clickCount ?? 1;
      if (clickCount !== 1 && clickCount !== 2) invalid("click 的 clickCount 只能是 1 / 2");
      return { kind: "click", x, y, button, clickCount };
    }
    case "key": {
      const key = action.key;
      if (typeof key !== "string" || !Object.hasOwn(INPUT_KEY_CODES, key)) {
        invalid(`key 只能是 ${Object.keys(INPUT_KEY_CODES).join(" / ")}`);
      }
      return { kind: "key", key: key as CdpInputKey };
    }
    case "text": {
      const text = action.text;
      if (typeof text !== "string" || text.length < 1 || text.length > INPUT_MAX_TEXT_LENGTH) {
        invalid(`text 长度必须是 1..${INPUT_MAX_TEXT_LENGTH}`);
      }
      if (hasUnsafeControl(text)) invalid("text 不能包含控制字符（\\t、\\n 除外）");
      return { kind: "text", text };
    }
    default:
      invalid("action.kind 只能是 click / key / text");
  }
}

/**
 * 从 `/json/list` 里挑出精确 target 并返回校验过的 WebSocket 地址。
 *
 * `target` 参数是 page id（不是 URL 子串）。page URL 允许 query/hash（lifecycle 的
 * `#id=<project>,pcb=<pcb>` 就是这样），但拒绝凭据；WebSocket 必须是
 * `ws://127.0.0.1:<同一 port>/devtools/page/<同一个 id>`，无 query/hash/凭据。
 */
export function selectInputTarget(
  targets: readonly CdpTarget[],
  port: number,
  target: string,
): string {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    invalid("port 必须是 1..65535 的整数");
  }
  if (typeof target !== "string" || !TARGET_ID_PATTERN.test(target)) {
    invalid("target 必须是 32 位十六进制 page id");
  }
  if (!Array.isArray(targets)) targetError("CDP 页面列表不是数组");
  const matches = targets.filter(
    (item): item is CdpTarget => item !== null && typeof item === "object" && item.id === target,
  );
  if (matches.length !== 1) {
    targetError(`指定 target 的命中数=${matches.length}（期望恰好 1）`);
  }
  const page = matches[0];
  if (!page) targetError("指定 target 不存在");
  if (page.type !== "page") targetError("指定 target 不是 page");
  if (typeof page.url !== "string" || page.url === "") targetError("指定 page 没有 URL");
  let url: URL;
  try {
    url = new URL(page.url);
  } catch {
    targetError("指定 page 的 URL 不合法");
  }
  if (url.username || url.password) targetError("指定 page 的 URL 含凭据");
  if (!(INPUT_EDITOR_ORIGINS as readonly string[]).includes(url.origin)) {
    targetError("指定 page 的来源不是已知的中文编辑器");
  }
  if (url.pathname !== INPUT_EDITOR_PATH) targetError("指定 page 的路径不是编辑器主页面");
  if (typeof page.title !== "string" || !INPUT_EDITOR_TITLE_PATTERN.test(page.title)) {
    targetError("指定 page 的标题不是嘉立创EDA(专业版)中文版");
  }
  const raw = page.webSocketDebuggerUrl;
  if (typeof raw !== "string" || raw === "") targetError("指定 page 没有调试 WebSocket");
  let ws: URL;
  try {
    ws = new URL(raw);
  } catch {
    targetError("调试 WebSocket 地址不合法");
  }
  if (
    ws.protocol !== "ws:" ||
    ws.hostname !== INPUT_HOST ||
    (ws.port ? Number(ws.port) : 80) !== port ||
    ws.pathname !== `/devtools/page/${target}` ||
    ws.search !== "" ||
    ws.hash !== "" ||
    ws.username !== "" ||
    ws.password !== ""
  ) {
    targetError("调试 WebSocket 未绑定指定的回环端口和 page target");
  }
  return raw;
}

const GUARD_CLICK_BLOCK = String.raw`    const x = want.point.x;
    const y = want.point.y;
    const width = globalThis.innerWidth;
    const height = globalThis.innerHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return fail('viewport');
    }
    if (!(x >= 0 && y >= 0 && x < width && y < height)) return fail('viewport');
    const rect = frame.getBoundingClientRect();
    if (
      ![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) ||
      !(rect.width > 0 && rect.height > 0)
    ) {
      return fail('frame');
    }
    if (!(x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) {
      return fail('viewport');
    }
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit !== frame) return fail('hit');
    const inner = frame.contentDocument;
    if (!inner) return fail('frame');
    if (hasVisibleModal(inner)) return fail('modal');
    const localX = x - rect.left;
    const localY = y - rect.top;
    const innerWidth = frame.clientWidth;
    const innerHeight = frame.clientHeight;
    if (
      !Number.isFinite(innerWidth) ||
      !Number.isFinite(innerHeight) ||
      innerWidth <= 0 ||
      innerHeight <= 0
    ) {
      return fail('viewport');
    }
    if (!(localX >= 0 && localY >= 0 && localX < innerWidth && localY < innerHeight)) {
      return fail('viewport');
    }
    const innerHit = inner.elementFromPoint(localX, localY);
    if (!innerHit) return fail('hit');
    const blocked = innerHit.closest?.(
      'input, textarea, select, button, a, [contenteditable="true"], [role="dialog"], [class*="lc_modal"]',
    );
    if (blocked) return fail('hit');
    // 只有实际画布才允许定向点击；普通 div 浮层/面板一律视为未命中。
    if (String(innerHit.tagName || '').toUpperCase() !== 'CANVAS') return fail('hit');
    return { ok: true };`;

const GUARD_KEY_BLOCK = String.raw`    if (document.activeElement !== frame) return fail('focus');
    const inner = frame.contentDocument;
    if (!inner) return fail('frame');
    if (hasVisibleModal(inner)) return fail('modal');
    const active = inner.activeElement;
    if (!active) return fail('focus');
    if (active.closest?.('[inert]')) return fail('focus');
    const tag = String(active.tagName || '').toUpperCase();
    const editable = tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable === true;
    if (editable) return fail('editable');
    if (tag !== 'BODY' && tag !== 'HTML' && tag !== 'CANVAS' && active !== inner.body) {
      return fail('focus');
    }
    return { ok: true };`;

const GUARD_TEXT_BLOCK = String.raw`    if (document.activeElement !== frame) return fail('focus');
    const inner = frame.contentDocument;
    if (!inner) return fail('frame');
    if (hasVisibleModal(inner)) return fail('modal');
    const active = inner.activeElement;
    if (!active) return fail('focus');
    if (active.hidden === true || active.closest?.('[inert]')) return fail('editable');
    if (active.getAttribute?.('aria-disabled') === 'true') return fail('editable');
    const tag = String(active.tagName || '').toUpperCase();
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && active.isContentEditable !== true) {
      return fail('editable');
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (active.disabled === true || active.readOnly === true) return fail('editable');
    }
    if (tag === 'INPUT') {
      const type = String(active.type || 'text').toLowerCase();
      if (!['text', 'search', 'tel', 'url', 'email', 'number'].includes(type)) {
        return fail('editable');
      }
    }
    return { ok: true };`;

const GUARD_IDENTITY_BLOCK = "    return { ok: true };";

/** 生成固定的守卫表达式；只嵌入常量与本请求的精确值，不嵌入页面内容。 */
export function inputGuardExpression(options: CdpInputGuardOptions): string {
  if (!DOCUMENT_UUID_PATTERN.test(options.documentUuid)) invalid("documentUuid 形状不合法");
  if (options.mode === "click") {
    if (typeof options.x !== "number" || !Number.isFinite(options.x)) invalid("click 守卫缺少 x");
    if (typeof options.y !== "number" || !Number.isFinite(options.y)) invalid("click 守卫缺少 y");
  }
  const want = JSON.stringify({
    origins: [...INPUT_EDITOR_ORIGINS],
    path: INPUT_EDITOR_PATH,
    documentUuid: options.documentUuid,
    point: options.mode === "click" ? { x: options.x, y: options.y } : null,
    pre: options.mode !== "identity",
    markers: [...UI_SHELL_MARKERS],
    minMarkers: UI_SHELL_MIN_MARKERS,
    modalSelector: INPUT_MODAL_SELECTOR,
  });
  const block =
    options.mode === "click"
      ? GUARD_CLICK_BLOCK
      : options.mode === "key"
        ? GUARD_KEY_BLOCK
        : options.mode === "text"
          ? GUARD_TEXT_BLOCK
          : GUARD_IDENTITY_BLOCK;
  return String.raw`(async () => {
  const want = ${want};
  const fail = (reason) => ({ ok: false, reason });
  const hasVisibleModal = (doc) => {
    if (!doc) return false;
    const nodes = Array.from(doc.querySelectorAll(want.modalSelector));
    for (const el of nodes) {
      // 后台页面不能仅凭 visibilityState 判定弹层不存在。
      if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  };
  try {
    if (!want.origins.includes(location.origin) || location.pathname !== want.path) {
      return fail('location');
    }
    if (document.readyState !== 'complete') return fail('ui');
    let markers = 0;
    for (const selector of want.markers) {
      try { if (document.querySelector(selector)) markers += 1; } catch (error) {}
    }
    if (markers < want.minMarkers) return fail('ui');
    if (want.pre && hasVisibleModal(document)) return fail('modal');
    const api = globalThis._EXTAPI_ROOT_;
    if (
      !api ||
      typeof api.dmt_Pcb?.getCurrentPcbInfo !== 'function' ||
      typeof api.dmt_SelectControl?.getCurrentDocumentInfo !== 'function'
    ) {
      return fail('api');
    }
    const pcb = await api.dmt_Pcb.getCurrentPcbInfo();
    const documentInfo = await api.dmt_SelectControl.getCurrentDocumentInfo();
    if (!want.origins.includes(location.origin) || location.pathname !== want.path) {
      return fail('location');
    }
    // await 期间页面可能变化（含弹层弹出而 iframe 焦点仍在），必须重新复查。
    if (document.readyState !== 'complete') return fail('ui');
    if (want.pre && hasVisibleModal(document)) return fail('modal');
    if (!pcb || pcb.uuid !== want.documentUuid) return fail('document');
    if (
      !documentInfo ||
      documentInfo.uuid !== want.documentUuid ||
      documentInfo.documentType !== 3
    ) {
      return fail('document');
    }
    if (
      typeof pcb.parentProjectUuid === 'string' &&
      typeof documentInfo.parentProjectUuid === 'string' &&
      pcb.parentProjectUuid !== documentInfo.parentProjectUuid
    ) {
      return fail('document');
    }
    const frames = Array.from(document.querySelectorAll('iframe.editframe'));
    if (frames.length !== 1) return fail('frame');
    const frame = frames[0];
    if (frame.hasAttribute('srcdoc') || typeof frame.src !== 'string' || !frame.src) return fail('frame');
    const source = new URL(frame.src, location.href);
    const current = frame.contentDocument;
    if (!current || current.readyState !== 'complete') return fail('frame');
    const loaded = new URL(current.URL);
    if (source.origin !== location.origin || loaded.origin !== source.origin ||
        loaded.pathname !== source.pathname || loaded.search !== source.search) return fail('frame');
${block}
  } catch (error) {
    return fail('error');
  }
})()`;
}

/**
 * 在给定 session 上发一次定向输入。
 *
 * 任何 Input 事件之前都会先跑 pre 守卫；事件按数组顺序紧邻发送，不插入等待、不重试。
 * 双击的第二对事件之前再跑一次 click 守卫。事件一旦尝试发出，后续守卫或传输异常
 * 一律按 CDP_INPUT_UNCERTAIN 处理，不再做补偿性输入（不重放 press、不补 release）。
 */
export async function dispatchCdpInput(
  session: Pick<CdpSession, "call">,
  request: CdpInputRequest,
  signal?: AbortSignal,
): Promise<CdpInputResult> {
  if (signal?.aborted) throw cancelled();
  const action = normalizeInputRequest(request);
  if (signal?.aborted) throw cancelled();
  if (ACTIVE_SESSIONS.has(session)) {
    throw new CdpError("CDP_INPUT_GUARD", "同一 CDP 会话上已有输入操作在进行，已拒绝并发。", {
      exitCode: 3,
    });
  }
  ACTIVE_SESSIONS.add(session);
  try {
    const pre = await runGuard(
      session,
      inputGuardExpression({
        mode: action.kind,
        documentUuid: request.documentUuid,
        ...(action.kind === "click" ? { x: action.x, y: action.y } : {}),
      }),
      signal,
    );
    if (!pre.ok) throw guardError(pre.reason);

    if (signal?.aborted) throw cancelled();
    let dispatched = 0;
    let attempted = false;
    const send = async (event: InputEvent): Promise<void> => {
      if (signal?.aborted) throw cancelled();
      attempted = true;
      if (signal) {
        await session.call(event.method, event.params, signal);
      } else {
        await session.call(event.method, event.params);
      }
      dispatched += 1;
    };
    const sendAll = async (events: readonly InputEvent[]): Promise<void> => {
      for (const event of events) await send(event);
    };

    try {
      if (action.kind === "click") {
        await sendAll(clickPair(action, 1));
        if (action.clickCount === 2) {
          // 第一次点击可能改变命中物（如打开菜单），第二对之前必须重新校验。
          const recheck = await runGuard(
            session,
            inputGuardExpression({
              mode: "click",
              documentUuid: request.documentUuid,
              x: action.x,
              y: action.y,
            }),
            signal,
          );
          if (!recheck.ok) throw guardError(recheck.reason);
          await sendAll(clickPair(action, 2));
        }
      } else if (action.kind === "key") {
        await sendAll(keyEvents(action));
      } else {
        await sendAll([textEvent(action)]);
      }
    } catch (error) {
      // 走到这里说明至少尝试过一条 Input；即使一条都没被 ack，也不能断言页面未收到。
      if (!attempted) throw error;
      throw uncertain(request, dispatched, error);
    }

    try {
      const post = await runGuard(
        session,
        inputGuardExpression({ mode: "identity", documentUuid: request.documentUuid }),
        signal,
      );
      if (!post.ok) throw guardError(post.reason);
    } catch (error) {
      throw uncertain(request, dispatched, error);
    }

    return {
      target: request.target,
      documentUuid: request.documentUuid,
      dispatched,
      delivery: "protocol-acknowledged",
    };
  } finally {
    ACTIVE_SESSIONS.delete(session);
  }
}

/**
 * 连接指定回环端点的精确 page target 并发一次定向输入。
 *
 * 全部请求校验在 `/json/list` 之前完成；随后重新枚举页面、校验唯一 target 和
 * WebSocket 绑定，再交给 `dispatchCdpInput`。同一进程内同一 `${port}:${target}`
 * 不允许并发，避免两次按键/点击互相穿插。
 */
export async function sendCdpInput(
  request: CdpInputRequest,
  options: CdpInputOptions = {},
): Promise<CdpInputResult> {
  const signal = options.signal;
  if (signal?.aborted) throw cancelled();
  normalizeInputRequest(request);
  if (signal?.aborted) throw cancelled();
  const key = `${request.port}:${request.target}`;
  if (ACTIVE_REQUESTS.has(key)) {
    throw new CdpError("CDP_INPUT_GUARD", "同一端口与 target 上已有输入操作在进行，已拒绝并发。", {
      exitCode: 3,
    });
  }
  ACTIVE_REQUESTS.add(key);
  let session: CdpSession | null = null;
  try {
    const targets = await fetchInputTargets(request.port, signal);
    const wsUrl = selectInputTarget(targets, request.port, request.target);
    if (signal?.aborted) throw cancelled();
    session = await CdpSession.connect(wsUrl, { signal });
    return await dispatchCdpInput(session, request, signal);
  } finally {
    ACTIVE_REQUESTS.delete(key);
    session?.close();
  }
}

async function fetchInputTargets(port: number, signal?: AbortSignal): Promise<CdpTarget[]> {
  const timeout = AbortSignal.timeout(INPUT_HTTP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`http://${INPUT_HOST}:${port}/json/list`, {
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { accept: "application/json" },
    });
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw new CdpError("CDP_INPUT_TARGET", `无法读取 ${INPUT_HOST}:${port} 的 CDP 页面列表`, {
      exitCode: 2,
      cause: error,
    });
  }
  if (!response.ok) {
    throw new CdpError("CDP_INPUT_TARGET", `CDP 页面列表返回 HTTP ${response.status}`, {
      exitCode: 2,
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw new CdpError("CDP_INPUT_TARGET", "CDP 页面列表不是 JSON", {
      exitCode: 2,
      cause: error,
    });
  }
  if (!Array.isArray(payload)) throw targetError("CDP 页面列表不是数组");
  return payload.filter(
    (item): item is CdpTarget => item !== null && typeof item === "object" && !Array.isArray(item),
  );
}

function clickPair(action: NormalizedClick, clickCount: 1 | 2): InputEvent[] {
  const buttons = action.button === "left" ? 1 : 2;
  return [
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mousePressed",
        x: action.x,
        y: action.y,
        button: action.button,
        clickCount,
        buttons,
      },
    },
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseReleased",
        x: action.x,
        y: action.y,
        button: action.button,
        clickCount,
        buttons: 0,
      },
    },
  ];
}

function keyEvents(action: NormalizedKey): InputEvent[] {
  const table = INPUT_KEY_CODES[action.key];
  const base = {
    key: action.key,
    code: table.code,
    windowsVirtualKeyCode: table.windowsVirtualKeyCode,
    nativeVirtualKeyCode: table.nativeVirtualKeyCode,
  };
  return [
    { method: "Input.dispatchKeyEvent", params: { type: "keyDown", ...base } },
    { method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...base } },
  ];
}

function textEvent(action: NormalizedText): InputEvent {
  return { method: "Input.insertText", params: { text: action.text } };
}

type GuardVerdict = { ok: true } | { ok: false; reason: string };

async function runGuard(
  session: Pick<CdpSession, "call">,
  expression: string,
  signal?: AbortSignal,
): Promise<GuardVerdict> {
  let reply: EvaluationReply;
  try {
    reply = signal
      ? await session.call<EvaluationReply>(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          signal,
        )
      : await session.call<EvaluationReply>("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
  } catch (error) {
    if (isCancelled(error)) throw error;
    return { ok: false, reason: "transport" };
  }
  if (reply?.exceptionDetails !== undefined && reply.exceptionDetails !== null) {
    return { ok: false, reason: "exception" };
  }
  const value = reply?.result?.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "unknown" };
  }
  const shaped = value as { ok?: unknown; reason?: unknown };
  if (shaped.ok === true) return { ok: true };
  if (shaped.ok === false && typeof shaped.reason === "string" && shaped.reason !== "") {
    return { ok: false, reason: shaped.reason.slice(0, 40) };
  }
  return { ok: false, reason: "unknown" };
}
