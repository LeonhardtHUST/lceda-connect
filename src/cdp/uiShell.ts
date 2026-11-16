import { CdpError, clipText, coerceText } from "./errors.ts";
import { redact } from "./redact.ts";
import type { CdpSession } from "./session.ts";

/**
 * 顶层 UI 判据（`eval --context ui` 的硬前置）。
 *
 * 2026-11-11 真机只读实测（V4.1.78）：顶层 page 四个挂载点全部命中（4/4），而 passport
 * 之类的子 iframe 一个都没有（0/4）。顶层页**没有** `#app`、也没有 Vue（`data-v-*` 计数为 0），
 * 所以判据不能写成「#app 存在」；也不能靠 `.lc_modal_*`（对话框没开时为 0）。
 */

/** 立创EDA Pro 顶层 UI 外壳的 DOM 挂载点。 */
export const UI_SHELL_MARKERS: readonly string[] = [
  "#main",
  "#top-wrap",
  "#canvas-work-space",
  "#toolbar-bottom",
];
/** 命中 ≥2 个即判顶层。 */
export const UI_SHELL_MIN_MARKERS = 2;

/** 选中的 page 不满足顶层 UI 判据（或探测本身失败）——不许静默放行。 */
export class UiShellError extends CdpError {
  constructor(message: string) {
    super("UI_SHELL", message, { exitCode: 2 });
    this.name = "UiShellError";
  }
}

export interface UiShellProbePayload {
  ui_shell?: boolean;
  markers?: unknown;
  marker_total?: unknown;
  href?: string;
  ready_state?: string;
  modal_like?: number;
  ext_api?: boolean;
  [key: string]: unknown;
}

/** 只读探测表达式：检查挂载点、href、readyState、模态框数量、扩展 API 是否存在。 */
export function uiShellProbeExpression(): string {
  return String.raw`(() => {
  const markers = ${JSON.stringify([...UI_SHELL_MARKERS])};
  const found = [];
  for (const sel of markers) {
    try { if (document.querySelector(sel)) found.push(sel); } catch (e) {}
  }
  return {
    ui_shell: found.length >= ${UI_SHELL_MIN_MARKERS},
    markers: found,
    marker_total: markers.length,
    href: String(location.href || ''),
    ready_state: String(document.readyState || ''),
    modal_like: document.querySelectorAll('[class*="lc_modal"]').length,
    ext_api: (typeof globalThis._EXTAPI_ROOT_ === 'object' && !!globalThis._EXTAPI_ROOT_)
  };
})()`;
}

/**
 * 纯函数：判定探测结果是否「立创EDA 顶层 UI 窗口」。
 * 判据 = 挂载点至少命中 UI_SHELL_MIN_MARKERS 个（顶层 UI 与 iframe 的结构性差异）。
 */
export function uiShellVerdict(payload: unknown): { ok: boolean; reason: string } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      reason: `探测结果不是对象（拿到 ${clipText(JSON.stringify(payload))}）：无法确认是顶层 UI`,
    };
  }
  const record = payload as Record<string, unknown>;
  const found = Array.isArray(record.markers) ? record.markers.map((item) => String(item)) : [];
  const rawTotal = record.marker_total;
  const total =
    typeof rawTotal === "number" && Number.isInteger(rawTotal) && rawTotal > 0
      ? rawTotal
      : UI_SHELL_MARKERS.length;
  if (found.length >= UI_SHELL_MIN_MARKERS) {
    return {
      ok: true,
      reason: `命中 ${found.length}/${total} 个 UI 挂载点（${found.join(", ")}）`,
    };
  }
  return {
    ok: false,
    reason:
      `只命中 ${found.length}/${total} 个 UI 挂载点（需要 ≥${UI_SHELL_MIN_MARKERS}，` +
      `${UI_SHELL_MARKERS.join(", ")}）：选到的是 iframe/worker/空白页，不是顶层 UI 窗口`,
  };
}

interface EvalCallResult {
  exceptionDetails?: { text?: string; exception?: { description?: string } };
  result?: { value?: unknown };
  [key: string]: unknown;
}

/**
 * 只读探测当前 session 的主 frame 是否立创EDA 顶层 UI 窗口。
 *
 * 只发一条 Runtime.evaluate，不改 DOM、不点击、不改设计数据。不满足判据时抛
 * UiShellError（带命中明细与脱敏后的 href），**绝不静默放行**：把 iframe 当顶层 UI 读，
 * `document.querySelectorAll('.lc_modal_*')` 只会得到 0，看起来像「没有对话框」，
 * 实际是读错了 document。
 */
export async function probeUiShell(session: CdpSession): Promise<UiShellProbePayload> {
  let result: EvalCallResult;
  try {
    result = await session.call<EvalCallResult>("Runtime.evaluate", {
      expression: uiShellProbeExpression(),
      returnByValue: true,
      awaitPromise: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UiShellError(`顶层 UI 探测失败（页面不响应 Runtime.evaluate）：${clipText(message)}`);
  }
  if (result.exceptionDetails) {
    throw new UiShellError(
      `顶层 UI 探测抛异常：${clipText(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "")}`,
    );
  }
  const payload = result.result?.value;
  const verdict = uiShellVerdict(payload);
  if (!verdict.ok) {
    const href =
      payload !== null && typeof payload === "object"
        ? redact(coerceText((payload as Record<string, unknown>).href))
        : "";
    throw new UiShellError(verdict.reason + (href ? `；href=${href}` : ""));
  }
  return payload as UiShellProbePayload;
}
