import { CdpError, clipText } from "./errors.ts";
import { probeUiShell } from "./uiShell.ts";
import type { CdpSession } from "./session.ts";

/**
 * 求值上下文：`api` 与 `ui` 两种语义（源仓库 eval_cdp.py `--context`）。
 *
 * | context | 注入 | 页面过滤 | 用途 |
 * |---|---|---|---|
 * | api | `var A = globalThis._EXTAPI_ROOT_`，整段包 `(async()=>{…})()` | 按 PCB 文档类型选页 | 读编辑器 API（网络 / 图元 / 选区…） |
 * | ui | **不注入** A、**不包** async IIFE（表达式逐字节原样求值） | 不按文档类型过滤 | 读顶层 UI DOM（弹窗 / 右键菜单 / 工具栏…） |
 *
 * 两条 context 的选页都必须唯一（由 pickPage 保证），`ui` 还要先过顶层 UI 判据。
 */

export const EVAL_CONTEXTS = ["api", "ui"] as const;
export type EvalContext = (typeof EVAL_CONTEXTS)[number];

export class EvalUsageError extends CdpError {
  constructor(message: string) {
    super("EVAL_USAGE", message, { exitCode: 2 });
    this.name = "EvalUsageError";
  }
}

export class EvalError extends CdpError {
  constructor(message: string, details?: unknown) {
    super("EVAL_ERROR", message, { exitCode: 1, details });
    this.name = "EvalError";
  }
}

export interface EvalPlanOptions {
  context?: EvalContext;
  /** 原样求值的表达式（config ui 或 api 的裸表达式）。 */
  expression?: string;
  /** api 上下文里的 async 函数体（等价源仓库 `--api`）。 */
  apiBody?: string;
}

export interface EvalPlan {
  context: EvalContext;
  /** 最终丢给 Runtime.evaluate 的表达式。 */
  expression: string;
  /** 选页时允许的文档类型；null 表示不按文档类型过滤。 */
  wantDocType: string | null;
}

/** 把一段 async 函数体包成扩展 API 上下文求值。 */
export function apiExpression(body: string): string {
  return `(async()=>{var A=globalThis._EXTAPI_ROOT_;${body}})()`;
}

/** 校验并构造求值计划；冲突/缺失按源仓库口径报 EVAL_USAGE。 */
export function planEval(options: EvalPlanOptions = {}): EvalPlan {
  const context = options.context ?? "api";
  if (!(EVAL_CONTEXTS as readonly string[]).includes(context)) {
    throw new EvalUsageError(
      `不认识的求值上下文：${String(context)}（可选 ${EVAL_CONTEXTS.join(" / ")}）`,
    );
  }
  const expression = options.expression ?? "";
  const apiBody = options.apiBody ?? "";

  if (context === "ui") {
    // ui 只收一条表达式：--api 自带 A 注入、--file 走整段脚本，语义都与「原样丢进
    // 顶层 window」冲突。宁可直接报错，也不猜调用方到底想要哪一个。
    if (apiBody) {
      throw new EvalUsageError(
        "--context ui 与 --api/--file 互斥：顶层 UI 只接受单条表达式（不注入 A、不包 async IIFE）",
      );
    }
    if (expression.trim() === "") {
      throw new EvalUsageError(
        "--context ui 需要表达式：顶层 UI 不做 A 注入，请直接给要读的 DOM 表达式",
      );
    }
    return { context, expression, wantDocType: null };
  }

  if (apiBody) {
    if (expression.trim() !== "") {
      throw new EvalUsageError("--context api 下表达式与 apiBody 只能给一个");
    }
    return { context, expression: apiExpression(apiBody), wantDocType: "pcb" };
  }
  if (expression.trim() === "") throw new EvalUsageError("缺少要执行的表达式");
  return { context, expression, wantDocType: "pcb" };
}

export interface EvalOutcome {
  value: unknown;
  type?: string;
  description?: string;
}

/**
 * 发一条 `Runtime.evaluate`（returnByValue + awaitPromise）。
 *
 * 页面抛异常时转成 EvalError：调用方拿到的是可读结论，而不是一段 "undefined"。
 */
export async function evaluateExpression(
  session: CdpSession,
  expression: string,
): Promise<EvalOutcome> {
  const result = await session.call<Record<string, unknown>>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  const exception = result.exceptionDetails;
  if (exception !== undefined && exception !== null) {
    const details = exception as {
      text?: string;
      exception?: { description?: string; value?: unknown };
    };
    throw new EvalError(
      `JS 抛异常：${clipText(details.exception?.description ?? details.text ?? "", 800)}`,
      details,
    );
  }
  const remote = result.result;
  if (remote === null || typeof remote !== "object") return { value: null };
  const shaped = remote as { value?: unknown; type?: string; description?: string };
  return {
    value: shaped.value ?? shaped.description ?? null,
    type: shaped.type,
    description: shaped.description,
  };
}

/**
 * 按计划求值：ui 上下文先过顶层 UI 判据（读错 document 会把对话框数静默变成 0）。
 */
export async function evaluateInContext(session: CdpSession, plan: EvalPlan): Promise<EvalOutcome> {
  if (plan.context === "ui") await probeUiShell(session);
  return await evaluateExpression(session, plan.expression);
}
