/**
 * `.epru` 记录流解析。
 *
 * 每行 `{record}||{payload}`，同一个 `(type, id)` 是编辑历史，ticket 最大的
 * 那一条才代表当前状态。DOCHEAD 划分文档段；`||` 只切第一个，载荷里允许
 * 继续出现 `||`。
 */
import type { ParsedDoc, RecordEntry } from "./contract.ts";
import { scalarText } from "./text.ts";

const KEY_SEPARATOR = "\u0000";

export interface ParseStats {
  total: number;
  unparsed: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Python `json.dumps(..., ensure_ascii=False, sort_keys=True)` 的等价实现。
 *
 * 元素 id 的 JSON 字符串会原样成为键的一部分，空格与键序都得跟 Python 版一致，
 * 否则同一份文件在两版里会算出不同的键。
 */
export function pythonJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return Object.is(value, -0) ? "-0.0" : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (isPlainObject(value)) {
    const pairs = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}: ${pythonJson(value[key])}`);
    return `{${pairs.join(", ")}}`;
  }
  return JSON.stringify(scalarText(value));
}

/** 元素 id 归一化成字符串：可能是字符串、数字，也可能是 JSON 字符串。 */
export function normId(rid: unknown): string {
  if (typeof rid === "string") return rid;
  if (rid === null || rid === undefined) return "";
  try {
    return pythonJson(rid);
  } catch {
    return scalarText(rid);
  }
}

/** 元素在文档内的归约键。 */
export function makeRecordKey(rtype: unknown, rid: unknown): string {
  return `${scalarText(rtype)}\u0000${normId(rid)}`;
}

export function splitRecordKey(key: string): { type: string; id: string } {
  const at = key.indexOf(KEY_SEPARATOR);
  if (at < 0) return { type: key, id: "" };
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}

function loads(raw: string | undefined): unknown {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "" || text === '""') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : scalarText(value);
}

/**
 * 解析记录流。返回文档段列表；`stats.total/unparsed` 供调用方判断失败率。
 */
export function parseRecords(text: string, stats?: ParseStats): ParsedDoc[] {
  const docs: ParsedDoc[] = [];
  let cur: ParsedDoc | null = null;
  let unparsed = 0;
  let total = 0;

  for (const line of text.split("\n")) {
    let s = line.trim();
    if (!s) continue;
    total += 1;
    if (!s.includes("||")) {
      unparsed += 1;
      continue;
    }
    // 行尾可能多一个 `|`；载荷里的 `||` 不能动。
    if (s.endsWith("|")) s = s.slice(0, -1);
    const at = s.indexOf("||");
    const headRaw = s.slice(0, at);
    const payloadRaw = s.slice(at + 2);
    let head: unknown;
    try {
      head = JSON.parse(headRaw);
    } catch {
      unparsed += 1;
      continue;
    }
    if (!isPlainObject(head)) {
      unparsed += 1;
      continue;
    }

    const rtype = textOrNull(head.type);
    const rid = head.id;
    const ticket = typeof head.ticket === "number" ? head.ticket : 0;

    if (rtype === "DOCHEAD") {
      const payload = loads(payloadRaw);
      const data = isPlainObject(payload) ? payload : {};
      cur = {
        docType: textOrNull(data.docType),
        uuid: textOrNull(data.uuid),
        editVersion: data.editVersion ?? null,
        title: "",
        elems: new Map<string, RecordEntry>(),
      };
      docs.push(cur);
      continue;
    }

    if (cur === null) {
      unparsed += 1;
      continue;
    }

    const key = makeRecordKey(rtype, rid);
    const prev = cur.elems.get(key);
    if (prev === undefined || ticket >= prev.ticket) {
      cur.elems.set(key, { ticket, payload: loads(payloadRaw) });
    }
  }

  if (stats) {
    stats.total = total;
    stats.unparsed = unparsed;
  }
  return docs;
}

/** 返回 (按类型分组的元素, META 属性)。已删除（payload 为 null）的记录跳过。 */
export function docElements(doc: ParsedDoc): {
  byType: Map<string, [string, unknown][]>;
  meta: Record<string, unknown>;
} {
  const byType = new Map<string, [string, unknown][]>();
  let meta: Record<string, unknown> = {};
  for (const [key, entry] of doc.elems) {
    if (entry.payload === null || entry.payload === undefined) continue;
    const { type, id } = splitRecordKey(key);
    if (type === "META") {
      if (isPlainObject(entry.payload)) meta = entry.payload;
      continue;
    }
    const list = byType.get(type) ?? [];
    list.push([id, entry.payload]);
    byType.set(type, list);
  }
  return { byType, meta };
}

/** {parentId: {key: value}}，用于把 ATTR 挂回所属元素。 */
export function attrMap(
  byType: Map<string, [string, unknown][]>,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const [, attr] of byType.get("ATTR") ?? []) {
    if (!isPlainObject(attr)) continue;
    const parent = attr.parentId;
    const key = attr.key;
    if (!parent || !key) continue;
    const parentKey = scalarText(parent);
    const bucket = out.get(parentKey) ?? {};
    bucket[scalarText(key)] = attr.value;
    out.set(parentKey, bucket);
  }
  return out;
}

/** 文档内唯一的扁平映射 {(uuid, type, id): (ticket, payload)}，用于两版对比。 */
export function flatMap(text: string): Map<string, RecordEntry> {
  const out = new Map<string, RecordEntry>();
  for (const doc of parseRecords(text)) {
    const uuid = doc.uuid || "?";
    for (const [key, value] of doc.elems) {
      const { type, id } = splitRecordKey(key);
      out.set(`${uuid}|${type}|${id}`, value);
    }
  }
  return out;
}

export function docsOf(docs: readonly ParsedDoc[], docType: string): ParsedDoc[] {
  return docs.filter((doc) => doc.docType === docType);
}

export function docTitle(doc: ParsedDoc): string {
  const { meta } = docElements(doc);
  return typeof meta.title === "string" ? meta.title : scalarText(meta.title);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}
