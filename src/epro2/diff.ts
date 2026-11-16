/**
 * 两版工程语义差异：元素级 added / removed / changed，附噪声过滤。
 *
 * `.epru` 每次保存都会重排 ticket、换客户端 GUID、重灌铺铜，这些不是设计变更。
 * 不先过滤会得到几千条“改动”，真实变更通常只有几条。
 */
import type {
  DiffNetlistChange,
  DiffNetlistResult,
  DiffRecordChange,
  DiffRecordResult,
  DiffResult,
  ParsedDoc,
  PcbRow,
} from "./contract.ts";
import { openProject } from "./container.ts";
import { buildDevices, buildSymbols } from "./library.ts";
import { buildNetlist } from "./pcb.ts";
import { flatMap, isPlainRecord, parseRecords } from "./records.ts";
import { scalarText } from "./text.ts";

export const VOLATILE_KEYS = new Set([
  "ticket",
  "firstTicket",
  "lastTicket",
  "client",
  "updateTime",
  "update_time",
  "version",
  "zIndex",
  "dataType",
  "checksum",
  "hash",
  "revision",
]);

// 注意 max / min 不在剔除名单里：它们可能是焊盘/铺铜的真实几何字段
// （包围盒尺寸），剔掉会把真实的焊盘尺寸变更吞进“无变化”。
export const NOISE_TYPES = new Set(["ELE_PLACEHOLDER", "LAYER_FILL", "POURED", "BLOB"]);

/** 递归剔除每次保存都会变、但没有设计含义的字段。 */
export function stripVolatile(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => stripVolatile(item, depth + 1));
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!VOLATILE_KEYS.has(key)) out[key] = stripVolatile(item, depth + 1);
    }
    return out;
  }
  return value;
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isPlainRecord(value)) {
    const pairs = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(scalarText(value));
}

function typeOf(key: string): string {
  const parts = key.split("|");
  return parts.length > 1 ? (parts[1] ?? "") : "";
}

/** 元素级 diff。键为 `文档uuid | 类型 | id`。 */
export function diffRecords(textOld: string, textNew: string): DiffRecordResult {
  const old = flatMap(textOld);
  const fresh = flatMap(textNew);
  const added: DiffRecordChange[] = [];
  const removed: DiffRecordChange[] = [];
  const changed: DiffRecordChange[] = [];
  let noise = 0;

  for (const [key, entry] of fresh) {
    if (old.has(key)) continue;
    if (NOISE_TYPES.has(typeOf(key))) {
      noise += 1;
      continue;
    }
    added.push({ key, type: typeOf(key), payload: stripVolatile(entry.payload) });
  }
  for (const key of old.keys()) {
    if (fresh.has(key)) continue;
    if (NOISE_TYPES.has(typeOf(key))) {
      noise += 1;
      continue;
    }
    removed.push({ key, type: typeOf(key) });
  }
  for (const [key, entry] of fresh) {
    const previous = old.get(key);
    if (!previous) continue;
    const before = stripVolatile(previous.payload);
    const after = stripVolatile(entry.payload);
    if (canonicalize(before) === canonicalize(after)) continue;
    if (NOISE_TYPES.has(typeOf(key))) {
      noise += 1;
      continue;
    }
    changed.push({ key, type: typeOf(key), before, after });
  }

  return {
    records_old: old.size,
    records_new: fresh.size,
    added,
    removed,
    changed,
    noise_filtered: noise,
  };
}

function rowKey(row: PcbRow): string {
  return `${row.designator}\u0000${row.pad}`;
}

function pyString(value: unknown): string {
  return scalarText(value, "None");
}

/**
 * 按 (位号, 焊盘号) 逐行比对网络与引脚映射。
 *
 * 只比网络会漏掉“符号改版”——焊盘号还是那些，但引到的引脚换了。所以行的
 * 语义签名是 (网络, 引脚号, 引脚名)，任一不同都算变更。
 */
export function diffNetlist(
  rowsOld: readonly PcbRow[],
  rowsNew: readonly PcbRow[],
): DiffNetlistResult {
  const index = (rows: readonly PcbRow[]): Map<string, PcbRow> => {
    const map = new Map<string, PcbRow>();
    for (const row of rows) map.set(rowKey(row), row);
    return map;
  };
  const a = index(rowsOld);
  const b = index(rowsNew);
  const added = [...b.entries()].filter(([key]) => !a.has(key)).map(([, row]) => row);
  const removed = [...a.entries()].filter(([key]) => !b.has(key)).map(([, row]) => row);
  const changed: DiffNetlistChange[] = [];
  for (const [key, rowB] of b) {
    const rowA = a.get(key);
    if (!rowA) continue;
    const fields: string[] = [];
    if ((rowA.net || "") !== (rowB.net || "")) fields.push("net");
    if (pyString(rowA.pinNumber) !== pyString(rowB.pinNumber)) fields.push("pinNumber");
    if (pyString(rowA.pinName) !== pyString(rowB.pinName)) fields.push("pinName");
    if (fields.length === 0) continue;
    changed.push({
      designator: rowA.designator,
      pad: rowA.pad,
      fields,
      before: rowA.net || "",
      after: rowB.net || "",
      pin_before: { number: rowA.pinNumber, name: rowA.pinName },
      pin_after: { number: rowB.pinNumber, name: rowB.pinName },
    });
  }
  return { added, removed, changed };
}

function netlistOf(docs: readonly ParsedDoc[]): { rows: PcbRow[]; warnings: string[] } {
  const symbols = buildSymbols(docs);
  const devices = buildDevices(docs);
  return buildNetlist(docs, symbols, devices);
}

/** 打开两版工程并比较。库表必须按版本各自构建，不能共用。 */
export function compare(oldPath: string, newPath: string): DiffResult {
  const projOld = openProject(oldPath);
  const projNew = openProject(newPath);
  const result: DiffResult = {
    old: { path: oldPath, records: projOld.lineCount() },
    new: { path: newPath, records: projNew.lineCount() },
    elements: diffRecords(projOld.epruText, projNew.epruText),
    netlist: { added: [], removed: [], changed: [] },
    netlist_rows: { old: 0, new: 0 },
  };
  const docsOld = parseRecords(projOld.epruText);
  const docsNew = parseRecords(projNew.epruText);
  // 库表按版本各自构建：符号/器件在版本间变了（引脚改号、换符号），两版就不能
  // 共用一张表，否则旧版网表会被新版的符号重算一遍，差异被抹平。
  const rowsOld = netlistOf(docsOld).rows;
  const rowsNew = netlistOf(docsNew).rows;
  result.netlist = diffNetlist(rowsOld, rowsNew);
  result.netlist_rows = { old: rowsOld.length, new: rowsNew.length };
  return result;
}

export function summarize(result: DiffResult): string {
  const el = result.elements;
  const nl = result.netlist;
  const pinOnly = nl.changed.filter((change) => !(change.fields ?? ["net"]).includes("net")).length;
  const detail = pinOnly ? `（其中 ${pinOnly} 条仅引脚映射变化，网名未变）` : "";
  return [
    `记录数: ${el.records_old} → ${el.records_new}`,
    `元素级: 新增 ${el.added.length} / 删除 ${el.removed.length} / 变更 ${el.changed.length}（已过滤噪声 ${el.noise_filtered}）`,
    `网表: ${result.netlist_rows.old} → ${result.netlist_rows.new} 行；新增 ${nl.added.length} / 删除 ${nl.removed.length} / 换网 ${nl.changed.length}${detail}`,
  ].join("\n");
}
