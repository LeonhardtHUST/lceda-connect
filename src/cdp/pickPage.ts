import { CdpError, coerceText } from "./errors.ts";
import type { CdpTarget } from "./targets.ts";

/**
 * 选页守卫（源仓库 #15）：命中数 ≠ 1 就报错停手。
 *
 * 绝不返回 null、绝不返回「首个命中」——多窗口同基名时静默取首个会撤销另一块板。
 * 显式 `index` 是唯一的例外路径：跳唯一性断言，但保留越界检查。
 */

export class PageSelectionError extends CdpError {
  constructor(message: string) {
    super("PAGE_SELECTION", message, { exitCode: 2 });
    this.name = "PageSelectionError";
  }
}

/** CDP /json/list 的 target 本身不带文档类型；真实环境由 docProbe 连 session 探测后回填。 */
export const DOC_TYPE_KEYS: readonly string[] = ["doc_type", "docType", "doctype", "documentType"];

export type DocProbe = (page: CdpTarget) => unknown;

export interface PickPageOptions {
  index?: number | null;
  /** URL 或标题的子串过滤。 */
  match?: string | null;
  /** 允许的文档类型（字符串或列表）；null/undefined 表示不按类型过滤。 */
  wantDocType?: string | readonly string[] | null;
  docProbe?: DocProbe | null;
}

/** 取一页的文档类型：先读内嵌标记，再退到调用方探针，都取不到返回 null。 */
export function pageDocType(page: CdpTarget, docProbe?: DocProbe | null): unknown {
  for (const key of DOC_TYPE_KEYS) {
    const value = page[key];
    if (value !== undefined && value !== null) return value;
  }
  if (docProbe) {
    try {
      return docProbe(page);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 选页前按文档类型先过滤候选集。
 *
 * 文档类型未知时**不静默排除**（多窗口下「只留已知 PCB」会放行假通过）：
 * 保留在候选集里，由后续「命中数 ≠ 1」断言兜底。真实环境应传 docProbe。
 */
export function filterByDocType(
  pages: readonly CdpTarget[],
  wantDocType?: string | readonly string[] | null,
  docProbe?: DocProbe | null,
): CdpTarget[] {
  if (wantDocType === undefined || wantDocType === null) return [...pages];
  const allowed = typeof wantDocType === "string" ? [wantDocType] : wantDocType;
  const allowedText = new Set(allowed.map((item) => String(item)));
  return pages.filter((page) => {
    const got = pageDocType(page, docProbe);
    if (got === undefined || got === null) return true;
    return allowedText.has(coerceText(got));
  });
}

function formatWantDocType(wantDocType: PickPageOptions["wantDocType"]): string {
  if (wantDocType === undefined || wantDocType === null) return "null";
  return JSON.stringify(wantDocType);
}

/**
 * 选一个 page target。
 *
 * - 只取 `type === "page"` 且有 `webSocketDebuggerUrl` 的项；
 * - `match` 只做 URL / 标题子串过滤，不做「首个命中即返回」；
 * - 显式 `index` 走下标分支（跳过唯一性断言，范围检查仍在）；
 * - 其余情况命中数必须恰好 1，否则抛 PageSelectionError。
 */
export function pickPage(targets: readonly CdpTarget[], options: PickPageOptions = {}): CdpTarget {
  const pages = targets.filter(
    (target) =>
      target.type === "page" &&
      typeof target.webSocketDebuggerUrl === "string" &&
      target.webSocketDebuggerUrl !== "",
  );

  let candidates = pages;
  const match = options.match;
  if (match) {
    candidates = candidates.filter(
      (page) =>
        (typeof page.url === "string" ? page.url : "").includes(match) ||
        (typeof page.title === "string" ? page.title : "").includes(match),
    );
  }
  candidates = filterByDocType(candidates, options.wantDocType, options.docProbe);

  const index = options.index;
  if (index !== undefined && index !== null) {
    if (!Number.isInteger(index)) {
      throw new PageSelectionError(`显式 index=${index} 不是整数（候选 ${candidates.length} 个）`);
    }
    if (index >= 0 && index < candidates.length) return candidates[index];
    throw new PageSelectionError(`显式 index=${index} 越界（候选 ${candidates.length} 个）`);
  }

  if (candidates.length !== 1) {
    throw new PageSelectionError(
      `选页命中数=${candidates.length}（期望恰好 1，want_doc_type=${formatWantDocType(
        options.wantDocType,
      )}）：不静默取首个，报错停手`,
    );
  }
  return candidates[0];
}
