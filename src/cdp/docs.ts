import { CdpError, clipText, coerceText } from "./errors.ts";

/**
 * 文档生命周期：列出 / 读当前 / 打开并切换（走编辑器 API，**不要用坐标点击页签或工程树**）。
 *
 * `openDocument` 只是把标签页建出来，**不换焦点**；`activateDocument` 才是「切过去」。
 * 两者必须成对调用，否则 `getCurrentPcbInfo()` 之类按焦点判定的接口读到的还是旧文档。
 * 切完必须回读 `active_after`：uuid 不等于目标就是失败，不许 exit 0 蒙过去。
 *
 * 来源：leonskill-easyeda-cdp-connect/scripts/open_doc.py（MIT）。
 */

/** 文档类型：pcb / sch；uuid 直开时列表里没有该文档，kind 可能是调用方给的或 "unknown"。 */
export type DocumentKind = "pcb" | "sch";

export interface DocumentInfo {
  kind: string;
  name: string | null;
  uuid: string;
  project?: string | null;
  board?: string | null;
  schematic?: string | null;
}

export interface DocumentErrorInfo {
  kind: "error";
  scope: string;
  message: string;
}

export interface DocumentListResult {
  documents: DocumentInfo[];
  errors?: DocumentErrorInfo[];
}

export interface ActiveDocument {
  kind: "pcb" | "sch" | "none";
  name: string | null;
  uuid: string | null;
  project?: string | null;
  via: string | null;
}

export class DocumentError extends CdpError {
  constructor(
    code:
      | "DOC_USAGE"
      | "DOC_NOT_FOUND"
      | "DOC_AMBIGUOUS"
      | "DOC_OPEN_FAILED"
      | "DOC_FOCUS_MISMATCH"
      | "DOC_EVAL",
    message: string,
    details?: unknown,
  ) {
    const exitCode =
      code === "DOC_USAGE" ? 3 : code === "DOC_NOT_FOUND" || code === "DOC_AMBIGUOUS" ? 1 : 2;
    super(code, message, { exitCode, details });
    this.name = "DocumentError";
  }
}

/** 只要求有 `api(body)`：Board 与测试替身都能用。 */
export interface ApiBoard {
  api(body: string): Promise<unknown>;
}

// 一次取全：PCB 列表 + 原理图页列表。**不要分开取**——两次求值之间工程可能变化，
// 名字到 uuid 的映射会错位（拿 A 的名字配 B 的 uuid 是最坏的一种错）。
const LIST_JS = String.raw`
const out = [];
try {
  const pcbs = await A.dmt_Pcb.getAllPcbsInfo();
  for (const p of (pcbs || [])) {
    out.push({kind: 'pcb', name: p.name, uuid: p.uuid,
              project: p.parentProjectUuid || null, board: p.parentBoardName || null});
  }
} catch (e) { out.push({kind: 'error', scope: 'pcb', message: String(e).slice(0, 160)}); }
try {
  const pages = await A.dmt_Schematic.getAllSchematicPagesInfo();
  for (const s of (pages || [])) {
    out.push({kind: 'sch', name: s.name, uuid: s.uuid,
              project: s.parentProjectUuid || null, schematic: s.parentSchematicName || null});
  }
} catch (e) { out.push({kind: 'error', scope: 'sch', message: String(e).slice(0, 160)}); }
return JSON.stringify({documents: out});
`;

// 当前活动文档：两条按焦点判定的接口，谁有值就是谁。
// `getCurrentPcbInfo` 明写「当前打开且拥有最后输入焦点的 PCB」，原理图焦点下返回 undefined。
const ACTIVE_JS = String.raw`
const out = {kind: 'none', name: null, uuid: null, via: null};
try {
  const pcb = await A.dmt_Pcb.getCurrentPcbInfo();
  if (pcb && pcb.uuid) {
    return JSON.stringify({kind: 'pcb', name: pcb.name, uuid: pcb.uuid,
                           project: pcb.parentProjectUuid || null, via: 'getCurrentPcbInfo'});
  }
} catch (e) {}
try {
  const page = await A.dmt_Schematic.getCurrentSchematicPageInfo();
  if (page && page.uuid) {
    return JSON.stringify({kind: 'sch', name: page.name, uuid: page.uuid,
                           project: page.parentProjectUuid || null,
                           via: 'getCurrentSchematicPageInfo'});
  }
} catch (e) {}
return JSON.stringify(out);
`;

const OPEN_JS = String.raw`
const targetUuid = __UUID__;
const doActivate = __ACTIVATE__;
const tabId = await A.dmt_EditorControl.openDocument(targetUuid);
if (!tabId) return JSON.stringify({opened: false, reason: 'openDocument-undefined',
                                   uuid: targetUuid});
let activated = null;
if (doActivate) {
  try { activated = await A.dmt_EditorControl.activateDocument(tabId); }
  catch (e) { activated = false; }
}
return JSON.stringify({opened: true, tab_id: tabId, activated: activated});
`;

// 就绪等待：`waitForDocumentReady` 是 alpha 可见性，个别版本可能不存在。
// 不存在时退回「轮询焦点接口看 uuid 变没变」，两条路都要能给出结论，不许静默成功。
const READY_JS = String.raw`
const arg = __ARG__;
const timeoutMs = __TIMEOUT_MS__;
const wantUuid = __UUID__;
if (typeof A.dmt_EditorControl.waitForDocumentReady === 'function') {
  try {
    const ready = await A.dmt_EditorControl.waitForDocumentReady(arg, timeoutMs);
    return JSON.stringify({ready: !!ready, via: 'waitForDocumentReady'});
  } catch (e) {
    return JSON.stringify({ready: false, via: 'waitForDocumentReady',
                           reason: String(e).slice(0, 160)});
  }
}
const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  try {
    const pcb = await A.dmt_Pcb.getCurrentPcbInfo();
    if (pcb && pcb.uuid === wantUuid) return JSON.stringify({ready: true, via: 'poll'});
  } catch (e) {}
  try {
    const page = await A.dmt_Schematic.getCurrentSchematicPageInfo();
    if (page && page.uuid === wantUuid) return JSON.stringify({ready: true, via: 'poll'});
  } catch (e) {}
  await new Promise(r => setTimeout(r, 250));
}
return JSON.stringify({ready: false, via: 'poll', reason: 'timeout'});
`;

async function evalJson(board: ApiBoard, js: string): Promise<Record<string, unknown>> {
  const raw = await board.api(js);
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  const text = coerceText(raw).trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 落到统一报错
  }
  throw new DocumentError("DOC_EVAL", `求值结果不是 JSON：${clipText(text)}`);
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function normalizeDocument(record: Record<string, unknown>): DocumentInfo {
  return {
    kind: coerceText(record.kind),
    name: asText(record.name),
    uuid: coerceText(record.uuid),
    project: asText(record.project),
    board: asText(record.board),
    schematic: asText(record.schematic),
  };
}

/** 列出工程内可打开的 PCB / 原理图页（含 uuid）。 */
export async function listDocuments(board: ApiBoard): Promise<DocumentListResult> {
  const data = await evalJson(board, LIST_JS);
  const raw = Array.isArray(data.documents) ? data.documents : [];
  const documents: DocumentInfo[] = [];
  const errors: DocumentErrorInfo[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.kind === "pcb" || record.kind === "sch") {
      documents.push(normalizeDocument(record));
    } else if (record.kind === "error") {
      errors.push({
        kind: "error",
        scope: coerceText(record.scope),
        message: coerceText(record.message),
      });
    }
  }
  const out: DocumentListResult = { documents };
  if (errors.length > 0) out.errors = errors;
  return out;
}

/** 读当前活动文档（按焦点判定的两条接口，`via` 记录来源）。 */
export async function activeDocument(board: ApiBoard): Promise<ActiveDocument> {
  const data = await evalJson(board, ACTIVE_JS);
  const kind = data.kind === "pcb" || data.kind === "sch" ? data.kind : "none";
  return {
    kind,
    name: asText(data.name),
    uuid: asText(data.uuid),
    project: asText(data.project),
    via: asText(data.via),
  };
}

export interface SelectDocumentOptions {
  /** 文档名（PCB 名或原理图页名），与 uuid 二选一。 */
  name?: string;
  uuid?: string;
  kind?: "pcb" | "sch" | "auto";
}

function describeCandidates(documents: readonly DocumentInfo[]): string {
  return documents.map((doc) => `${doc.name ?? "?"}(${doc.uuid.slice(0, 8)})`).join(", ");
}

/**
 * 纯函数选文档：精确匹配优先，唯一模糊匹配兜底，多义/没找到一律报错停手。
 *
 * uuid 可能是刚创建、列表还没同步的；直接用 uuid 试一次，别一上来就判死。
 */
export function selectDocument(
  documents: readonly DocumentInfo[],
  options: SelectDocumentOptions,
): DocumentInfo {
  const kind = options.kind ?? "auto";
  if (Boolean(options.name) === Boolean(options.uuid)) {
    throw new DocumentError("DOC_USAGE", "需要 --name 或 --uuid 且只能给一个");
  }
  const scoped = kind === "auto" ? [...documents] : documents.filter((doc) => doc.kind === kind);

  if (options.uuid) {
    const uuid = options.uuid;
    const hit = scoped.find((doc) => doc.uuid === uuid);
    return hit ?? { kind: kind === "auto" ? "unknown" : kind, name: null, uuid };
  }

  const wantName = options.name ?? "";
  const exact = scoped.filter((doc) => doc.name === wantName);
  if (exact.length > 1) {
    throw new DocumentError(
      "DOC_AMBIGUOUS",
      `同名文档不止一个：${describeCandidates(exact)} —— 用 --uuid 指定`,
    );
  }
  if (exact.length === 1) return exact[0];

  const fuzzy = scoped.filter((doc) => (doc.name ?? "").includes(wantName));
  if (fuzzy.length > 1) {
    throw new DocumentError(
      "DOC_AMBIGUOUS",
      `模糊匹配到多个：${fuzzy.map((doc) => doc.name ?? "?").join(", ")} —— 用完整名字或 --uuid`,
    );
  }
  if (fuzzy.length === 1) return fuzzy[0];

  throw new DocumentError(
    "DOC_NOT_FOUND",
    `没找到文档 ${JSON.stringify(wantName)}（现有：${scoped.map((doc) => doc.name ?? "?").join(", ") || "空"}）`,
  );
}

export interface OpenDocumentOptions extends SelectDocumentOptions {
  /** 打开后是否切焦点，默认 true。 */
  activate?: boolean;
  /** 是否等就绪，默认 true（仅在 activate 时生效）。 */
  wait?: boolean;
  /** 就绪等待毫秒数，默认 30000（源仓库默认 30 秒，仅在 activate + wait 时生效）。 */
  timeoutMs?: number;
}

export interface OpenDocumentResult {
  opened: true;
  tab_id: string;
  kind: string;
  name: string | null;
  uuid: string;
  activated: boolean | null;
  ready?: Record<string, unknown>;
  active_after?: ActiveDocument;
  focus_verified?: boolean;
}

/**
 * 打开（并默认激活）一个文档。
 *
 * 三条不许改的语义：
 * 1. `openDocument` 不换焦点，必须配 `activateDocument`；
 * 2. 返回 undefined 就是失败，不许当成功往下走；
 * 3. 切完必须回读自证：`active_after.uuid != 目标 uuid` ⇒ 抛 DOC_FOCUS_MISMATCH。
 */
export async function openDocument(
  board: ApiBoard,
  options: OpenDocumentOptions,
): Promise<OpenDocumentResult> {
  const activate = options.activate ?? true;
  const wait = options.wait ?? true;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const listed = await listDocuments(board);
  const hit = selectDocument(listed.documents, options);

  const openJs = OPEN_JS.replace("__UUID__", () => JSON.stringify(hit.uuid)).replace(
    "__ACTIVATE__",
    () => (activate ? "true" : "false"),
  );
  const opened = await evalJson(board, openJs);
  if (!opened.opened) {
    throw new DocumentError(
      "DOC_OPEN_FAILED",
      `openDocument 返回 undefined（uuid=${hit.uuid}），打开失败`,
      { uuid: hit.uuid, reason: opened.reason },
    );
  }

  const result: OpenDocumentResult = {
    opened: true,
    tab_id: coerceText(opened.tab_id),
    kind: hit.kind,
    name: hit.name,
    uuid: hit.uuid,
    activated: typeof opened.activated === "boolean" ? opened.activated : null,
  };

  if (activate && wait) {
    const readyJs = READY_JS.replace("__ARG__", () => JSON.stringify(result.tab_id))
      .replace("__TIMEOUT_MS__", () => String(timeoutMs))
      .replace("__UUID__", () => JSON.stringify(hit.uuid));
    result.ready = await evalJson(board, readyJs);
  }

  // 回读自证：`openDocument` 返回了 tabId 也不代表焦点切过去了。
  // 只有 activate 过的才回读，否则读到的是上一个文档，会造成误判。
  if (activate) {
    const after = await activeDocument(board);
    result.active_after = after;
    const verified = after.uuid === hit.uuid;
    result.focus_verified = verified;
    const ready = result.ready;
    // `waitForDocumentReady` 是 `visibility: alpha` 的接口，V4.1.78 实测**恒返回 false**；
    // 它是「等就绪」的辅助信号，不是打开成败的判据 —— 主判据是 active_after。
    if (ready && ready.ready === false && verified) {
      ready.note =
        "waitForDocumentReady 未确认（该接口 visibility=alpha，V4.1.78 实测恒 false）；" +
        "active_after 已证明焦点落在目标文档上，可以继续";
    }
    if (!verified) {
      throw new DocumentError(
        "DOC_FOCUS_MISMATCH",
        `切换后 active_after.uuid=${after.uuid ?? "null"} 不等于目标 ${hit.uuid}：焦点没切过去`,
        result,
      );
    }
  }

  return result;
}
