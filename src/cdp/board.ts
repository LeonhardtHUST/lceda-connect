import { CdpError, clipText } from "./errors.ts";
import { DEFAULT_CDP_HOST, resolveEndpoint } from "./discover.ts";
import { apiExpression } from "./eval.ts";
import { DETECT_JS, STATE_KEYS, UNWRITABLE_HINT } from "./modalProbe.ts";
import { PageSelectionError, pickPage } from "./pickPage.ts";
import { CdpSession } from "./session.ts";
import { listTargets, type CdpTarget } from "./targets.ts";

/**
 * 底板访问层：连窗口、在扩展 API 上下文里求值、按统一形状读编辑器状态。
 *
 * 对应源仓库 `scripts/_board.py`（**内部层，不属于对外契约**）：
 * - `Board.api()` 把函数体包成 `(async()=>{var A=globalThis._EXTAPI_ROOT_;<body>})()`；
 * - `ensureWritable()` 在历史预览态 / 有可见模态框时拒绝写操作。
 *
 * 为什么用异常而不是布尔返回值：写脚本里「忘了检查返回值」等于没有守卫，而预览态下
 * 写操作会**返回成功**（`clearRouting`/`delete` → true 但不生效），继续往下跑只会产出
 * 空壳结果。
 */

export class BoardError extends CdpError {
  constructor(
    message: string,
    options: { code?: string; exitCode?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(options.code ?? "BOARD", message, {
      exitCode: options.exitCode ?? 2,
      details: options.details,
      cause: options.cause,
    });
    this.name = "BoardError";
  }
}

export interface BoardButton {
  text?: string;
  tag?: string;
  kind?: string;
  index?: number;
  selector?: string | null;
  rect?: unknown;
  clickable?: boolean;
  [key: string]: unknown;
}

export interface BoardModal {
  title?: string;
  text?: string;
  selector?: string | null;
  z_index?: number | null;
  depth?: number;
  rect?: unknown;
  stack_index?: number;
  buttons?: BoardButton[];
  [key: string]: unknown;
}

export interface EditorState {
  history_preview?: boolean;
  banner_text?: string | null;
  history_panel?: boolean;
  modals?: BoardModal[];
  project?: string | null;
  docType?: number | null;
  writable?: boolean;
  blocked?: string[];
  [key: string]: unknown;
}

/** 只要有 `evalJs` 就能跑状态检测（Board 或测试替身都行）。 */
export interface JsEvaluator {
  evalJs(expression: string): Promise<unknown>;
}

export interface BoardOptions {
  /** 窗口标题 / URL 片段（传给 pickPage 的 match）。 */
  match?: string;
  /** 显式 page 序号（跳过唯一性断言，越界仍报错）。 */
  index?: number;
  port?: number;
  host?: string;
  /** 允许的文档类型；PCB 动词传 "pcb"，文档切换传 null。 */
  docType?: string | readonly string[] | null;
  env?: NodeJS.ProcessEnv;
}

export interface BoardInit {
  title: string;
  port: number;
  session: CdpSession;
}

export class Board {
  readonly title: string;
  readonly port: number;
  readonly session: CdpSession;

  constructor(init: BoardInit) {
    this.title = init.title;
    this.port = init.port;
    this.session = init.session;
  }

  /** 发现端点 → 唯一选页 → 建会话 → Page.enable。 */
  static async open(options: BoardOptions = {}): Promise<Board> {
    const host = options.host ?? DEFAULT_CDP_HOST;
    const match = options.match ?? "";
    const endpoint = await resolveEndpoint(host, { port: options.port, env: options.env });
    if (!endpoint) {
      throw new BoardError(
        `找不到 CDP 端点（端口 ${options.port ?? "自动发现"}）：客户端可能没带 ` +
          "--remote-debugging-port 启动",
        { code: "CDP_NOT_FOUND" },
      );
    }

    const targets = await listTargets(host, endpoint.port);
    const page = selectBoardPage(targets, match, options);

    const wsUrl = page.webSocketDebuggerUrl;
    if (typeof wsUrl !== "string" || wsUrl === "") {
      throw new BoardError("选中的 page 没有 webSocketDebuggerUrl", { code: "PAGE_SELECTION" });
    }

    const session = await CdpSession.connect(wsUrl, { env: options.env });
    try {
      await session.call("Page.enable");
    } catch (error) {
      session.close();
      throw error;
    }

    const title = typeof page.title === "string" && page.title !== "" ? page.title : match;
    return new Board({ title, port: endpoint.port, session });
  }

  /** 在页面主 frame 里求值；JS 抛异常转成 BoardError（带异常描述前 300 字）。 */
  async evalJs(expression: string): Promise<unknown> {
    const result = await this.session.call<BoardEvalResult>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new BoardError(
        `JS 执行失败：${clipText(detail.exception?.description ?? detail.text ?? "", 300)}`,
        { code: "BOARD_JS" },
      );
    }
    return result.result?.value;
  }

  /** 在扩展 API 上下文里跑一段 async 函数体，`A` 即 `_EXTAPI_ROOT_`。 */
  async api(body: string): Promise<unknown> {
    return await this.evalJs(apiExpression(body));
  }

  /** 同 `api`，但把返回的 JSON 字符串解析成对象。 */
  async apiJson<T = unknown>(body: string): Promise<T> {
    const raw = await this.api(body);
    if (raw !== null && typeof raw === "object") return raw as T;
    try {
      return JSON.parse(String(raw)) as T;
    } catch (error) {
      throw new BoardError(`API 返回的不是 JSON：${clipText(JSON.stringify(raw))}`, {
        code: "BOARD_JSON",
        cause: error,
      });
    }
  }

  /** 确认当前标签页是 PCB：原理图上没有 pcb_* 上下文，先拦下来更省事。 */
  async ensurePcb(): Promise<unknown> {
    try {
      return await this.api(
        "var l=await A.pcb_Layer.getCurrentLayer(); return JSON.stringify({layer:l});",
      );
    } catch (error) {
      throw new BoardError(
        `当前窗口不是 PCB 文档或 PCB 上下文未就绪：${error instanceof Error ? error.message : String(error)}`,
        { code: "BOARD_NOT_PCB" },
      );
    }
  }

  async nets(): Promise<unknown> {
    return await this.apiJson(
      "var nets=await A.pcb_Net.getAllNets(); return JSON.stringify(nets);",
    );
  }

  close(): void {
    this.session.close();
  }
}

interface BoardEvalResult {
  exceptionDetails?: { text?: string; exception?: { description?: string } };
  result?: { value?: unknown };
  [key: string]: unknown;
}

/** 选页并把「命中数 ≠ 1」翻译成 BoardError（源仓库 `_board.Board` 的同一层包装）。 */
function selectBoardPage(
  targets: readonly CdpTarget[],
  match: string,
  options: BoardOptions,
): CdpTarget {
  try {
    return pickPage(targets, {
      match: match || null,
      index: options.index ?? null,
      wantDocType: options.docType ?? null,
    });
  } catch (error) {
    if (error instanceof PageSelectionError) {
      throw new BoardError(`选页无唯一匹配（${match}）：${error.message}`, {
        code: "PAGE_SELECTION",
      });
    }
    throw error;
  }
}

// ─── 可写性守卫 ──────────────────────────────────────────────────────

function isModal(value: unknown): value is BoardModal {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 最上层（`stack_index === 1`）的模态框；没有结构化 modal 时返回 null。 */
export function topModal(state: EditorState): BoardModal | null {
  const modals: unknown[] = Array.isArray(state.modals) ? state.modals : [];
  let top: BoardModal | null = null;
  let topIndex = Number.POSITIVE_INFINITY;
  for (const item of modals) {
    if (!isModal(item)) continue;
    const index =
      typeof item.stack_index === "number" && item.stack_index > 0
        ? item.stack_index
        : Number.POSITIVE_INFINITY;
    if (index < topIndex) {
      top = item;
      topIndex = index;
    }
  }
  return top;
}

/** `modal.buttons` 里的按钮（默认只要 clickable=true 的），保持原顺序。 */
export function clickableButtons(modal: BoardModal | null, clickableOnly = true): BoardButton[] {
  if (!modal || !Array.isArray(modal.buttons)) return [];
  const out: BoardButton[] = [];
  for (const button of modal.buttons) {
    if (button === null || typeof button !== "object") continue;
    if (clickableOnly && !button.clickable) continue;
    out.push(button);
  }
  return out;
}

/**
 * 把 modals 压成「能照着操作」的分栏文字：安全关闭 / 提交类（勿点）。
 *
 * 为什么分两栏：`blocked` 是给人（和下一个 agent）看的，把「应用/确认」和「取消」
 * 混在一个「可点」列表里，会诱导「反正列在可点里」直接点掉。被遮挡/禁用的按钮两栏都不进。
 */
export function modalDetail(state: EditorState, limit = 2): string {
  const modals: unknown[] = Array.isArray(state.modals) ? state.modals : [];
  const parts: string[] = [];
  for (const modal of modals.slice(0, limit)) {
    if (!isModal(modal)) {
      parts.push(`「${clipText(modal, 24)}」`);
      continue;
    }
    const title = typeof modal.title === "string" && modal.title !== "" ? modal.title : "(无标题)";
    const safe: string[] = [];
    const submit: string[] = [];
    for (const button of clickableButtons(modal)) {
      const text = typeof button.text === "string" ? button.text : "";
      if (!text) continue;
      if (button.kind === "primary") submit.push(text);
      else safe.push(text);
    }
    const lines = [`「${title}」`];
    lines.push(
      safe.length > 0
        ? `  安全关闭：${safe.slice(0, 6).join(" / ")}`
        : "  安全关闭：（无可点按钮，需手动处理）",
    );
    if (submit.length > 0) lines.push(`  提交类（勿点）：${submit.slice(0, 6).join(" / ")}`);
    parts.push(lines.join("\n"));
  }
  if (modals.length > limit) parts.push(`另有 ${modals.length - limit} 个未列出`);
  return parts.join("\n");
}

/**
 * **纯函数**：只吃检测结果，判定能否写。
 *
 * 规则（与 DETECT_JS 的注释一一对应）：
 * - `history_preview`（topTabTip 高>2 且宽>100）→ 不可写；
 * - `modals` 非空（可见对话框）→ 不可写；
 * - `history_panel`（只是历史面板开着、没选中记录）**不拦**：面板开着仍可编辑。
 */
export function judgeState(state: EditorState): { writable: boolean; blocked: string[] } {
  const blocked: string[] = [];
  if (state.history_preview) {
    blocked.push("历史预览态：写操作全部禁用（菜单灰、RPC 写入静默失败）");
  }
  const modals: unknown[] = Array.isArray(state.modals) ? state.modals : [];
  if (modals.length > 0) {
    const detail = modalDetail(state);
    blocked.push("存在模态对话框：输入会被对话框截获" + (detail ? `\n${detail}` : ""));
  }
  return { writable: blocked.length === 0, blocked };
}

/** 补齐 writable/blocked 并按 STATE_KEYS 定序（输出契约靠它稳定）。 */
export function normalizeState(state: EditorState): EditorState {
  const verdict = judgeState(state);
  const out: Record<string, unknown> = {};
  for (const key of STATE_KEYS) {
    if (key === "writable") out[key] = verdict.writable;
    else if (key === "blocked") out[key] = verdict.blocked;
    else out[key] = state[key];
  }
  return out as EditorState;
}

/** 在窗口里跑 DETECT_JS，返回原始事实字典；读不到就抛 BoardError。 */
export async function detectState(source: JsEvaluator): Promise<EditorState> {
  const raw = await source.evalJs(DETECT_JS);
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as EditorState;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as EditorState;
    } catch {
      // 落到下面统一报错
    }
  }
  throw new BoardError(`[unwritable] 读不到编辑器状态（检测脚本返回 ${clipText(raw)}）`, {
    code: "UNWRITABLE",
  });
}

/**
 * 历史预览态 / 可见模态框时拒绝写操作。
 *
 * 发现不可写时抛 BoardError（history 与模态框两条原因按行拼接，不用「；」把分栏压扁）。
 * 退出码 2：与源仓库写脚本口径一致（写脚本失败 ≠ 检查器检出异常）。
 */
export async function ensureWritable(source: JsEvaluator): Promise<true> {
  const state = await detectState(source);
  const verdict = judgeState(state);
  if (verdict.writable) return true;
  throw new BoardError(`[unwritable] ${verdict.blocked.join("\n")}\n${UNWRITABLE_HINT}`, {
    code: "UNWRITABLE",
  });
}
