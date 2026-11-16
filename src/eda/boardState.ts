import { createHash } from "node:crypto";

import { DRC_COORD_TOL_DEFAULT, READER_ID, V1_READER_ID } from "./payloads.ts";

/**
 * 读板状态归一化、DRC 去重与指纹。
 *
 * 移植自 leonskill-easyeda-connect `scripts/board_reader_v2.py`（MIT）。哈希口径与
 * Python 完全一致：`sha256(salt + canonical_json(...))[:16]`，canonical 与
 * `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)` 同形。
 * Python 的 float 与 int 序化不同（`3.0` vs `3`），所以坐标类字段统一包成
 * {@link PyFloat}；计数类字段保持普通 number。
 *
 * 未移植：targets 坐标比对、severity 三级聚合、12/12 稳定窗采样。快照比较只看
 * `snapshot_key` 与探针覆盖，跨 reader 一律 unjudgeable（见 compareBoardDigest）。
 */

export { DRC_COORD_TOL_DEFAULT, READER_ID, V1_READER_ID };

const DETAILS_SALT_PREFIX = "eda-state-graph::";
const DRC_LEAF_SALT_PREFIX = "eda-state-graph::drc-leaves::";
const DESIGNATOR_SALT_PREFIX = "eda-state-graph::designators::";
const SILK_SALT_PREFIX = "eda-state-graph::silk::";

const DOC_TYPE_PCB = 3;
const DOC_TYPES_READABLE: ReadonlySet<number> = new Set([DOC_TYPE_PCB]);

const PROBE_KEYS = ["drc_dup_removed", "drc_count_mismatch", "drc_leaf_hash"] as const;

// 多候选键（顺序即优先级；首项同时也是 projectLeaf 的输出键，保证重投影幂等）
const CAT_KEYS = [
  "cat",
  "category",
  "errorType",
  "error_type",
  "_group",
  "groupName",
  "categoryName",
  "catName",
  "typeName",
] as const;
const SUB_KEYS = [
  "sub",
  "subType",
  "sub_type",
  "objType",
  "subCategory",
  "errorObjType",
  "error_obj_type",
  "type",
  "rule",
  "ruleName",
] as const;
const OBJ1_KEYS = ["obj1", "object1", "objA", "errorObj1", "firstObj", "source", "src"] as const;
const OBJ2_KEYS = ["obj2", "object2", "objB", "errorObj2", "secondObj", "target", "dst"] as const;
const GROUP_KEYS = ["_group", "groupName", "categoryName", "catName"] as const;
const NAME_KEYS = ["name", "label", "title"] as const;
const ID_KEYS = ["id", "errorId", "errId", "uuid"] as const;
const SEQ_KEYS = ["objs", "objects", "objectIds", "ids", "objectList"] as const;
const XY_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["x", "y"],
  ["X", "Y"],
  ["posX", "posY"],
  ["px", "py"],
  ["posx", "posy"],
];
const NESTED_XY_KEYS = ["pos", "point", "location", "coord", "coordinate", "position"] as const;
const INNER_XY_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["x", "y"],
  ["X", "Y"],
  ["posX", "posY"],
];
const DESIGNATOR_KEYS = ["designator", "id"] as const;
const SILK_ROUND = 6;

// ─── Python 兼容的 canonical JSON ─────────────────────────────────────

/** 标记「Python float」的数值：序化时保留 `.0`，与整数区分。 */
export class PyFloat {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }
}

function formatPythonFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";

  const abs = Math.abs(value);
  // Python repr 在 |x| < 1e-4 或 >= 1e16 时用指数形式；其余用定点。
  let text: string;
  if (abs < 1e-4 || abs >= 1e16) {
    // Python repr 的指数形式不补 `.0`（`1e-07` 而不是 `1.0e-07`），指数至少两位。
    const [mantissa = "", exponent = "0"] = value.toExponential().split("e");
    const sign = exponent.startsWith("-") ? "-" : "+";
    const digits = exponent.replace(/^[+-]/, "").padStart(2, "0");
    text = `${mantissa}e${sign}${digits}`;
  } else {
    text = String(value);
  }
  return text.includes(".") || text.includes("e") ? text : `${text}.0`;
}

/** 确定性 JSON：键排序、无空白、非 ASCII 不转义（对应 `canonical_json`）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof PyFloat) return formatPythonFloat(value.value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return formatPythonFloat(value);
    return Number.isInteger(value) ? String(value) : formatPythonFloat(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  return "null";
}

/** 把未知值转成字符串（对象走 JSON，避免 `[object Object]`）。 */
function scalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return value.toString();
  return JSON.stringify(value) ?? "";
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ─── 标量归一 ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `round(num, 6)`：整数/浮点都折成 6 位小数的 Python float。 */
function roundFloat(value: number): number {
  return Number.parseFloat(value.toFixed(6));
}

/** 对应 `_num_or_none`：只认有限数字与可转数字的字符串，其余返回 null。 */
export function numOrNone(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? roundFloat(value) : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
    const parsed = Number.parseFloat(text);
    return Number.isFinite(parsed) ? roundFloat(parsed) : null;
  }
  return null;
}

function pyFloatOrNone(value: unknown): PyFloat | null {
  const num = numOrNone(value);
  return num === null ? null : new PyFloat(num);
}

/** 对应 `_first_str`：按候选键取第一个非 None 标量并字符串化。 */
function firstStr(leaf: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (!(key in leaf)) continue;
    const value = leaf[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (isRecord(value)) {
      for (const inner of ["name", "id", "value", "designator", "ref"]) {
        const nested = value[inner];
        if (nested !== undefined && nested !== null) return scalarText(nested);
      }
    }
  }
  return null;
}

function stringifyObj(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (isRecord(value)) {
    for (const key of ["designator", "ref", "name", "id", "net", "obj", "value"]) {
      const item = value[key];
      if (item !== undefined && item !== null) return scalarText(item);
    }
    return null;
  }
  if (typeof value === "string" || typeof value === "number") return String(value);
  return null;
}

function objFromSeq(leaf: Record<string, unknown>, index: number): string | null {
  for (const key of SEQ_KEYS) {
    const value = leaf[key];
    if (Array.isArray(value)) {
      if (value.length <= index) continue;
      const found = stringifyObj(value[index]);
      if (found !== null) return found;
    } else if (typeof value === "string" && value.trim() !== "") {
      const parts = value.replace(/,/g, " ").split(/\s+/).filter(Boolean);
      if (parts.length > index) return parts[index] ?? null;
    } else if (isRecord(value)) {
      const found = stringifyObj(value);
      if (found !== null && index === 0) return found;
    }
  }
  return null;
}

function extractXy(leaf: Record<string, unknown>): { x: number | null; y: number | null } {
  for (const [kx, ky] of XY_KEYS) {
    const x = numOrNone(leaf[kx]);
    const y = numOrNone(leaf[ky]);
    if (x !== null && y !== null) return { x, y };
  }
  for (const key of NESTED_XY_KEYS) {
    const value = leaf[key];
    if (isRecord(value)) {
      for (const [kx, ky] of INNER_XY_KEYS) {
        const x = numOrNone(value[kx]);
        const y = numOrNone(value[ky]);
        if (x !== null && y !== null) return { x, y };
      }
    } else if (Array.isArray(value) && value.length >= 2) {
      const x = numOrNone(value[0]);
      const y = numOrNone(value[1]);
      if (x !== null && y !== null) return { x, y };
    }
  }
  return { x: null, y: null };
}

// ─── DRC 叶子归一化与去重 ─────────────────────────────────────────────

export interface DrcLeafProjection {
  cat: string | null;
  sub: string | null;
  obj1: string | null;
  obj2: string | null;
  name: string;
  x: number | null;
  y: number | null;
  id: string | null;
  _group: string | null;
  identity_complete: boolean;
  coord_known: boolean;
  [key: string]: unknown;
}

/** 把一个 DRC 叶子投影成规范字典（幂等）。 */
export function projectLeaf(leaf: unknown): DrcLeafProjection {
  if (!isRecord(leaf)) {
    return {
      cat: null,
      sub: null,
      obj1: null,
      obj2: null,
      name: "<unknown>",
      x: null,
      y: null,
      id: null,
      _group: null,
      identity_complete: false,
      coord_known: false,
    };
  }
  const cat = firstStr(leaf, CAT_KEYS);
  const sub = firstStr(leaf, SUB_KEYS);
  const obj1 = firstStr(leaf, OBJ1_KEYS) ?? objFromSeq(leaf, 0);
  const obj2 = firstStr(leaf, OBJ2_KEYS) ?? objFromSeq(leaf, 1);
  const group = firstStr(leaf, GROUP_KEYS);
  const ownName = firstStr(leaf, NAME_KEYS);
  // cats 的 name 必须是类别名，不能退到 sub：incremental_route 的「未布通 == 0」
  // 守卫只数含 connection 的类别项，按 sub 聚合会让守卫永不触发。
  const name = group ?? ownName ?? cat ?? sub ?? "<unknown>";
  const { x, y } = extractXy(leaf);
  return {
    cat,
    sub,
    obj1,
    obj2,
    name,
    x,
    y,
    id: firstStr(leaf, ID_KEYS),
    _group: group,
    identity_complete: cat !== null && sub !== null && obj1 !== null && obj2 !== null,
    coord_known: x !== null && y !== null,
  };
}

function leafHashPayload(projected: DrcLeafProjection): Record<string, unknown> {
  return {
    cat: projected.cat,
    sub: projected.sub,
    obj1: projected.obj1,
    obj2: projected.obj2,
    name: projected.name,
    x: projected.x === null ? null : new PyFloat(projected.x),
    y: projected.y === null ? null : new PyFloat(projected.y),
  };
}

/** 去重后 DRC 叶子的确定性指纹（salt 含 reader_id）。 */
export function drcLeafHash(
  leaves: readonly unknown[] | null | undefined,
  options: { readerId?: string } = {},
): string {
  const readerId = options.readerId ?? READER_ID;
  const payloads = (leaves ?? []).map((leaf) => leafHashPayload(projectLeaf(leaf)));
  payloads.sort((left, right) => {
    const a = canonicalJson(left);
    const b = canonicalJson(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const salt = DRC_LEAF_SALT_PREFIX + String(readerId);
  return sha256Hex(salt + canonicalJson(payloads)).slice(0, 16);
}

/**
 * 端点聚类：网格 + 3×3 邻桶缩小候选，是否合并由 `hypot <= step` 实距决定。
 * 返回与点等长的标签（簇内最小索引，确定性）。
 */
export function clusterPoints(
  points: ReadonlyArray<readonly [number, number]>,
  step: number,
): number[] {
  const stepValue = Number(step);
  if (!Number.isFinite(stepValue) || stepValue <= 0) {
    throw new Error(`clusterPoints: step 必须为正有限数，收到 ${String(step)}`);
  }
  const pts = points.map(([x, y]) => [Number(x), Number(y)] as const);
  const n = pts.length;
  const parent = Array.from({ length: n }, (_, index) => index);

  const find = (start: number): number => {
    let index = start;
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  const join = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const grid = new Map<string, Array<[number, number, number]>>();
  pts.forEach(([px, py], index) => {
    const cx = Math.floor(px / stepValue);
    const cy = Math.floor(py / stepValue);
    for (const gx of [cx - 1, cx, cx + 1]) {
      for (const gy of [cy - 1, cy, cy + 1]) {
        for (const [other, qx, qy] of grid.get(`${gx},${gy}`) ?? []) {
          if (Math.hypot(qx - px, qy - py) <= stepValue) join(index, other);
        }
      }
    }
    const key = `${cx},${cy}`;
    const bucket = grid.get(key) ?? [];
    bucket.push([index, px, py]);
    grid.set(key, bucket);
  });
  return Array.from({ length: n }, (_, index) => find(index));
}

/** 零容差分组：只有坐标完全相等的点才同簇。 */
export function exactLabels(points: ReadonlyArray<readonly [number, number]>): number[] {
  const first = new Map<string, number>();
  return points.map(([x, y], index) => {
    const key = `${Number(x)},${Number(y)}`;
    const seen = first.get(key);
    if (seen !== undefined) return seen;
    first.set(key, index);
    return index;
  });
}

function edaCountTotal(value: unknown): { available: boolean; total: number | null } {
  if (value === null || value === undefined) return { available: false, total: null };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { available: true, total: Math.trunc(value) };
  }
  let values: unknown[];
  if (Array.isArray(value)) values = value;
  else if (isRecord(value)) values = Object.values(value);
  else return { available: false, total: null };

  let total = 0;
  for (const item of values) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return { available: false, total: null };
    }
    total += Math.trunc(item);
  }
  return { available: true, total };
}

export interface DrcDedupeResult {
  leaves: DrcLeafProjection[];
  drc_raw_leaf_count: number;
  drc_leaf_count: number;
  drc_dup_removed: number;
  drc_count_mismatch: boolean | null;
  eda_counts_available: boolean;
  eda_count_total: number | null;
  drc_leaf_hash: string;
  identity_incomplete: number;
  coord_missing: number;
  unresolved_identity: number;
  unresolved_coord: number;
  tol: number;
  probes: {
    drc_dup_removed: number;
    drc_count_mismatch: boolean | null;
    drc_leaf_hash: string;
    probe_complete: boolean;
    unresolved_identity: number;
    unresolved_coord: number;
  };
}

/** D10 去重：身份四元组精确分组，坐标只在组内容差聚类。 */
export function dedupeDrcLeaves(
  leaves: readonly unknown[] | null | undefined,
  options: { edaCounts?: unknown; tol?: number; readerId?: string } = {},
): DrcDedupeResult {
  const rows: unknown[] = Array.isArray(leaves) ? [...leaves] : [];
  const projected = rows.map((row) => projectLeaf(row));
  let tolValue = Number(options.tol ?? DRC_COORD_TOL_DEFAULT);
  if (!Number.isFinite(tolValue) || tolValue < 0) tolValue = 0;

  const byIdentity = new Map<string, Array<{ index: number; item: DrcLeafProjection }>>();
  const solo: Array<{ index: number; item: DrcLeafProjection }> = [];
  const identityKey = (item: DrcLeafProjection): string =>
    [item.cat, item.sub, item.obj1, item.obj2]
      .map((value) => (value === null ? "\u0000" : String(value)))
      .join("\u0001");

  projected.forEach((item, index) => {
    if (!item.identity_complete || !item.coord_known) {
      solo.push({ index, item });
      return;
    }
    const key = identityKey(item);
    const bucket = byIdentity.get(key) ?? [];
    bucket.push({ index, item });
    byIdentity.set(key, bucket);
  });

  const orderedKeys = [...byIdentity.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const kept: Array<{ index: number; item: DrcLeafProjection }> = [];
  for (const key of orderedKeys) {
    const members = byIdentity.get(key) ?? [];
    const coords = members.map(({ item }) => [item.x ?? 0, item.y ?? 0] as const);
    const labels = tolValue > 0 ? clusterPoints(coords, tolValue) : exactLabels(coords);
    const buckets = new Map<number, Array<{ index: number; item: DrcLeafProjection }>>();
    members.forEach((member, position) => {
      const label = labels[position] ?? 0;
      const bucket = buckets.get(label) ?? [];
      bucket.push(member);
      buckets.set(label, bucket);
    });
    for (const label of [...buckets.keys()].sort((a, b) => a - b)) {
      const bucket = buckets.get(label) ?? [];
      bucket.sort((left, right) => left.index - right.index);
      if (bucket[0]) kept.push(bucket[0]);
    }
  }
  kept.push(...solo);
  kept.sort((left, right) => left.index - right.index);
  const deduped = kept.map(({ item }) => item);

  const { available, total } = edaCountTotal(options.edaCounts);
  const mismatch = available ? total !== deduped.length : null;
  const removed = projected.length - deduped.length;
  const leafHash = drcLeafHash(deduped, { readerId: options.readerId });
  const probeComplete = available && mismatch !== null;
  const unresolvedIdentity = projected.filter((item) => !item.identity_complete).length;
  const unresolvedCoord = projected.filter((item) => !item.coord_known).length;
  return {
    leaves: deduped,
    drc_raw_leaf_count: projected.length,
    drc_leaf_count: deduped.length,
    drc_dup_removed: removed,
    drc_count_mismatch: mismatch,
    eda_counts_available: available,
    eda_count_total: total,
    drc_leaf_hash: leafHash,
    identity_incomplete: unresolvedIdentity,
    coord_missing: unresolvedCoord,
    unresolved_identity: unresolvedIdentity,
    unresolved_coord: unresolvedCoord,
    tol: tolValue,
    probes: {
      drc_dup_removed: removed,
      drc_count_mismatch: mismatch,
      drc_leaf_hash: leafHash,
      probe_complete: probeComplete,
      unresolved_identity: unresolvedIdentity,
      unresolved_coord: unresolvedCoord,
    },
  };
}

export interface DrcAggregate {
  drc: number | null;
  drc_cat: Record<string, number> | null;
  drc_sub: Record<string, number> | null;
  cats: string[] | null;
  connection_leaf_hits: number | null;
  cats_connection_hits: number | null;
  connection_category_drift: boolean;
}

/** 只由去重后的叶子聚合类别统计；绝不读 EDA 自报的分组计数。 */
export function aggregateDrc(leaves: readonly unknown[] | null | undefined): DrcAggregate {
  const rows: unknown[] = Array.isArray(leaves) ? [...leaves] : [];
  const projected = rows.map((row) => projectLeaf(row));
  const byCat = new Map<string, number>();
  const bySub = new Map<string, number>();
  const byName = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (const item of projected) {
    bump(byCat, item.cat ?? "<unknown>");
    bump(bySub, item.sub ?? "<unknown>");
    bump(byName, item.name || "<unknown>");
  }
  const sortedObject = (map: Map<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const key of [...map.keys()].sort()) out[key] = map.get(key) ?? 0;
    return out;
  };
  const connectionSignal = (item: DrcLeafProjection): boolean =>
    ["cat", "_group", "name", "sub"].some((key) => {
      const value = item[key];
      return typeof value === "string" && value.toLowerCase().includes("connection");
    });
  const connectionLeafHits = projected.filter((item) => connectionSignal(item)).length;
  const catsConnectionHits = [...byName.entries()]
    .filter(([name]) => name.toLowerCase().includes("connection"))
    .reduce((sum, [, count]) => sum + count, 0);
  return {
    drc: projected.length,
    drc_cat: sortedObject(byCat),
    drc_sub: sortedObject(bySub),
    cats: [...byName.keys()].sort().map((name) => `${name}:${byName.get(name) ?? 0}`),
    connection_leaf_hits: connectionLeafHits,
    cats_connection_hits: catsConnectionHits,
    connection_category_drift: connectionLeafHits > 0 && catsConnectionHits === 0,
  };
}

// ─── 其它指纹 ─────────────────────────────────────────────────────────

/** 元件明细指纹：`sha256(salt + canonical(sorted(details)))[:16]`，只投影 id/x/y/rot。 */
export function detailsHash(
  details: readonly unknown[] | null | undefined,
  options: { readerId?: string } = {},
): string | null {
  if (!Array.isArray(details)) return null;
  const items = details.map((row) => {
    if (!isRecord(row)) {
      return {
        id: row === null || row === undefined ? null : String(row),
        x: null,
        y: null,
        rot: null,
      };
    }
    const id = row.id;
    return {
      id: id === null || id === undefined ? null : scalarText(id),
      x: pyFloatOrNone(row.x),
      y: pyFloatOrNone(row.y),
      rot: pyFloatOrNone(row.rot),
    };
  });
  items.sort((left, right) => {
    const a = canonicalJson(left);
    const b = canonicalJson(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const salt = DETAILS_SALT_PREFIX + String(options.readerId ?? READER_ID);
  return sha256Hex(salt + canonicalJson(items)).slice(0, 16);
}

function designatorOf(row: unknown): string | null {
  if (!isRecord(row)) return null;
  for (const key of DESIGNATOR_KEYS) {
    if (!(key in row)) continue;
    const value = row[key];
    if (value === null || value === undefined || typeof value === "boolean") continue;
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text !== "") return text;
    }
  }
  return null;
}

/** 位号集合（排序去重）；`null` = 读不到明细，`[]` = 采到了但没有位号。 */
export function designatorSet(details: readonly unknown[] | null | undefined): string[] | null {
  if (!Array.isArray(details)) return null;
  const ids = new Set<string>();
  for (const row of details) {
    const ident = designatorOf(row);
    if (ident !== null) ids.add(ident);
  }
  return [...ids].sort();
}

function designatorDigest(ids: readonly string[], readerId: string = READER_ID): string {
  const salt = DESIGNATOR_SALT_PREFIX + String(readerId);
  return sha256Hex(salt + canonicalJson([...ids])).slice(0, 16);
}

/** 位号集合指纹（16 位裸 hex，与 details_hash 同形）。 */
export function designatorSetHash(
  details: readonly unknown[] | null | undefined,
  options: { readerId?: string } = {},
): string | null {
  const ids = designatorSet(details);
  if (ids === null) return null;
  return designatorDigest(ids, options.readerId ?? READER_ID);
}

function silkNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.parseFloat(value.toFixed(SILK_ROUND));
}

/** 丝印投影（按 canonical 串排序）；`null` = 读不到，`[]` = 真没有丝印。 */
export function silkRows(
  silks: readonly unknown[] | null | undefined,
): Array<Record<string, unknown>> | null {
  if (!Array.isArray(silks)) return null;
  const rows: Array<Record<string, unknown>> = [];
  for (const item of silks) {
    if (!isRecord(item)) return null;
    const text = item.text;
    rows.push({
      layer: silkNumber(item.layer),
      x: silkNumber(item.x),
      y: silkNumber(item.y),
      text: text === null || text === undefined ? null : scalarText(text),
      fontSize: silkNumber(item.fontSize),
      lineWidth: silkNumber(item.lineWidth),
    });
  }
  rows.sort((left, right) => {
    const a = canonicalJson(left);
    const b = canonicalJson(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return rows;
}

/** 丝印集合指纹；空集返回稳定哈希，读不到才返回 null。 */
export function silkHash(
  silks: readonly unknown[] | null | undefined,
  options: { readerId?: string } = {},
): string | null {
  const rows = silkRows(silks);
  if (rows === null) return null;
  const payload = rows.map((row) => ({
    layer: row.layer === null ? null : new PyFloat(row.layer as number),
    x: row.x === null ? null : new PyFloat(row.x as number),
    y: row.y === null ? null : new PyFloat(row.y as number),
    text: row.text,
    fontSize: row.fontSize === null ? null : new PyFloat(row.fontSize as number),
    lineWidth: row.lineWidth === null ? null : new PyFloat(row.lineWidth as number),
  }));
  const salt = SILK_SALT_PREFIX + String(options.readerId ?? READER_ID);
  return sha256Hex(salt + canonicalJson(payload)).slice(0, 16);
}

/** 快照主键：payload 固定 10 键，`reader_id` 参与其中（跨版本主键必不同）。 */
export function snapshotKey(state: Record<string, unknown> | null | undefined): string {
  const src = isRecord(state) ? state : {};
  const netsRaw = src.nets ?? [];
  let nets: string[];
  if (isRecord(netsRaw)) nets = Object.keys(netsRaw).map(String).sort();
  else if (Array.isArray(netsRaw)) nets = netsRaw.map((item) => String(item)).sort();
  else nets = [];
  const netsHash = sha256Hex(canonicalJson(nets)).slice(0, 12);
  const payload = {
    reader_id: src.reader_id,
    lines: src.lines,
    vias: src.vias,
    comps: src.comps,
    pours: src.pours,
    drc: src.drc,
    drc_leaf_hash: src.drc_leaf_hash,
    details_hash: src.details_hash,
    cats: Array.isArray(src.cats) ? src.cats.map((item) => String(item)).sort() : [],
    nets_hash: netsHash,
  };
  return sha256Hex(canonicalJson(payload)).slice(0, 16);
}

// ─── 归一化 ───────────────────────────────────────────────────────────

export interface BoardState {
  [key: string]: unknown;
  lines: number | null;
  vias: number | null;
  comps: number | null;
  pours: number | null;
  nets: unknown;
  silk_count: number | null;
  silk_hash: string | null;
  silk_available: boolean;
  available: boolean;
  available_reasons: string[];
  doc_type: number | null;
  doc_type_mismatch: boolean | null;
  settled: boolean | null;
  settled_mismatch_keys: string[] | null;
  settled_retried: boolean | null;
  nets_available: boolean;
  drc_available: boolean;
  drc: number | null;
  drc_cat: Record<string, number> | null;
  drc_sub: Record<string, number> | null;
  cats: string[] | null;
  connection_leaf_hits: number | null;
  cats_connection_hits: number | null;
  connection_category_drift: boolean;
  reader_id: string;
  details_hash: string | null;
  details_count: number | null;
  designator_set_hash: string | null;
  designators_available: boolean;
  designators_count: number | null;
  drc_dup_removed: number | null;
  drc_count_mismatch: boolean | null;
  drc_leaf_hash: string | null;
  drc_raw_leaf_count: number | null;
  drc_leaf_count: number | null;
  eda_counts_available: boolean;
  eda_count_total: number | null;
  identity_incomplete: number | null;
  coord_missing: number | null;
  unresolved_identity: number | null;
  unresolved_coord: number | null;
  probes: Record<string, unknown>;
  comparable: boolean;
  reasons: string[];
  warnings: string[];
}

function parseDocType(raw: Record<string, unknown>): number | null {
  const value = raw.doc_type;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function docTypeMismatchOf(raw: Record<string, unknown>): boolean | null {
  if (!("doc_type" in raw) && !("doc_type_mismatch" in raw)) return null;
  if (raw.doc_type_mismatch === true) return true;
  const docType = parseDocType(raw);
  return docType === null || !DOC_TYPES_READABLE.has(docType);
}

function readoutAvailability(input: {
  docTypeMismatch: boolean | null;
  settled: boolean | null;
  lines: unknown;
  vias: unknown;
  comps: unknown;
  pours: unknown;
  netsAvailable: boolean;
  drcAvailable: boolean;
}): { available: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.docTypeMismatch === null) reasons.push("doc_type_unknown");
  else if (input.docTypeMismatch) reasons.push("doc_type_not_pcb");
  if (input.settled === null) reasons.push("settled_unknown");
  else if (!input.settled) reasons.push("readout_not_settled");
  for (const [name, value] of [
    ["lines", input.lines],
    ["vias", input.vias],
    ["comps", input.comps],
    ["pours", input.pours],
  ] as const) {
    if (value === null || value === undefined) reasons.push(`${name}_unavailable`);
  }
  if (!input.netsAvailable) reasons.push("nets_unavailable");
  if (!input.drcAvailable) reasons.push("drc_unavailable");
  return { available: reasons.length === 0, reasons };
}

function v1State(raw: Record<string, unknown>, reason: string): BoardState {
  const state: Record<string, unknown> = { ...raw };
  state.reader_id = raw.reader_id ?? V1_READER_ID;
  state.comparable = false;
  const defaults: Record<string, unknown> = {
    details_hash: null,
    details_count: null,
    drc_dup_removed: null,
    drc_count_mismatch: null,
    drc_leaf_hash: null,
    drc_cat: null,
    drc_sub: null,
    connection_leaf_hits: null,
    cats_connection_hits: null,
    connection_category_drift: false,
    eda_counts_available: false,
    identity_incomplete: null,
    coord_missing: null,
    unresolved_identity: null,
    unresolved_coord: null,
    designator_set_hash: null,
    designators_available: false,
    designators_count: null,
    doc_type: null,
    doc_type_mismatch: null,
    settled: null,
    settled_mismatch_keys: null,
    settled_retried: null,
    nets_available: Array.isArray(raw.nets),
    drc_available: false,
    available: false,
    available_reasons: ["v1_legacy_snapshot"],
    silk_count: null,
    silk_hash: null,
    silk_available: false,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in state)) state[key] = value;
  }
  state.probes = {
    drc_dup_removed: null,
    drc_count_mismatch: null,
    drc_leaf_hash: null,
    probe_complete: false,
    unresolved_identity: null,
    unresolved_coord: null,
  };
  state.reasons = [`v1_legacy_snapshot: ${reason}（计数型快照，comparable=false）`];
  state.warnings = [];
  return state as BoardState;
}

function passthroughState(raw: Record<string, unknown>, readerId: string): BoardState {
  const state: Record<string, unknown> = { ...raw };
  state.reader_id = readerId;
  const defaults: Record<string, unknown> = {
    comparable: false,
    designator_set_hash: null,
    designators_available: false,
    designators_count: null,
    doc_type: null,
    doc_type_mismatch: null,
    settled: null,
    settled_mismatch_keys: null,
    settled_retried: null,
    nets_available: Array.isArray(state.nets),
    drc_available: typeof state.drc === "number" && !Number.isNaN(state.drc),
    available: false,
    available_reasons: ["passthrough_without_readout_evidence"],
    silk_count: null,
    silk_hash: null,
    silk_available: false,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in state)) state[key] = value;
  }
  return state as BoardState;
}

/**
 * 把 `BOARD_READ_JS_V2` 的原始返回归一成 state。
 *
 * 三条路径都不抛异常：v1 计数型快照、已归一化的幂等透传、v2 双探针。v2 输出不含
 * 逐件坐标与位号明文，只留哈希与件数。
 */
export function normalizeBoardState(
  raw: unknown,
  options: { readerId?: string; tol?: number } = {},
): BoardState {
  const readerId = options.readerId ?? READER_ID;
  const tol = options.tol ?? DRC_COORD_TOL_DEFAULT;
  if (!isRecord(raw)) {
    return v1State({ offline: true }, `raw_not_dict:${raw === null ? "None" : typeof raw}`);
  }
  const rid = raw.reader_id;
  const hasLeaves = "drc_leaves" in raw;
  if (rid !== undefined && rid !== null && rid !== readerId) {
    return v1State(raw, `cross_reader_snapshot:${scalarText(rid)}`);
  }
  if (!hasLeaves && (rid === undefined || rid === null)) {
    return v1State(raw, "v1_or_legacy_format");
  }
  if (!hasLeaves && "probes" in raw) {
    return passthroughState(raw, readerId);
  }

  const leavesRaw = raw.drc_leaves;
  const drcAvailable = Array.isArray(leavesRaw);
  const leaves: unknown[] = drcAvailable ? [...(leavesRaw as unknown[])] : [];

  const netsRaw = raw.nets;
  const netsAvailable = Array.isArray(netsRaw);
  const docType = parseDocType(raw);
  const docTypeMismatch = docTypeMismatchOf(raw);
  const settled = typeof raw.settled === "boolean" ? raw.settled : null;
  const settledRetried = typeof raw.settled_retried === "boolean" ? raw.settled_retried : null;
  let settledKeys: string[] | null;
  if (Array.isArray(raw.settled_mismatch_keys)) {
    settledKeys = raw.settled_mismatch_keys.map((item) => String(item));
  } else {
    settledKeys = settled === null ? null : [];
  }

  let edaCounts: unknown = null;
  const groups = raw.eda_groups;
  if (Array.isArray(groups)) {
    const parsed: number[] = [];
    let valid = true;
    for (const group of groups) {
      if (!isRecord(group) || typeof group.count !== "number" || !Number.isFinite(group.count)) {
        valid = false;
        break;
      }
      parsed.push(Math.trunc(group.count));
    }
    if (valid) edaCounts = parsed;
  }

  const probe = dedupeDrcLeaves(leaves, { edaCounts, tol, readerId });
  let aggregate: DrcAggregate = aggregateDrc(probe.leaves);
  // DRC 不可读 ⇒ 所有叶子派生量一律 null（不是 0），探针覆盖同时置 false。
  let drcDupRemoved: number | null = probe.drc_dup_removed;
  let drcCountMismatch: boolean | null = probe.drc_count_mismatch;
  let drcLeafHashValue: string | null = probe.drc_leaf_hash;
  let drcRawLeafCount: number | null = probe.drc_raw_leaf_count;
  let drcLeafCount: number | null = probe.drc_leaf_count;
  let probeComplete = probe.probes.probe_complete;
  if (!drcAvailable) {
    aggregate = {
      drc: null,
      drc_cat: null,
      drc_sub: null,
      cats: null,
      connection_leaf_hits: null,
      cats_connection_hits: null,
      connection_category_drift: false,
    };
    drcDupRemoved = null;
    drcCountMismatch = null;
    drcLeafHashValue = null;
    drcRawLeafCount = null;
    drcLeafCount = null;
    probeComplete = false;
  }
  if (settled === false) probeComplete = false;

  const detailsRaw = raw.details;
  const detailsPresent = Array.isArray(detailsRaw);
  const digest = detailsPresent ? detailsHash(detailsRaw as unknown[], { readerId }) : null;
  const designators = designatorSet(detailsRaw as unknown[] | null);
  const designatorsAvailable = designators !== null;
  const designatorDigest = designators === null ? null : designatorDigestOf(designators, readerId);
  const designatorsCount = designators === null ? null : designators.length;

  const silksRaw = raw.silks;
  const silkRowsValue = silkRows(silksRaw as unknown[] | null);
  const silkDigest = silkRowsValue === null ? null : silkHash(silksRaw as unknown[], { readerId });
  const silkAvailable = silkRowsValue !== null;
  const silkCount = silkRowsValue === null ? null : silkRowsValue.length;

  let comps = numOrCount(raw.comps);
  if (comps === null && detailsPresent) comps = (detailsRaw as unknown[]).length;

  const reasons: string[] = [];
  if (docTypeMismatch === true) {
    reasons.push(
      `doc_type_mismatch: documentType=${docType === null ? "null" : docType} 不是 PCB(3)，` +
        "本次一个计数都未采集（历史上这种情况会被读成「全 0 且无报错」）",
    );
  }
  if (settled === false) {
    reasons.push(
      `readout_unsettled: 连读两次不一致（${settledKeys?.join(",") || "unknown"}），` +
        "禁止按部分读采信",
    );
  }
  if ("nets" in raw && netsRaw === null) {
    reasons.push(
      "nets_unavailable: getAllNetsName() 返回 null（无文档/无网络），不得读成「空网络表」",
    );
  }
  if ("drc_leaves" in raw && leavesRaw === null) {
    reasons.push(
      "drc_unavailable: DRC 采集返回 null（调用失败/无订阅），不得读成「0 个 DRC 错误」",
    );
  }
  if (!probeComplete) {
    reasons.push("probe_not_covered: EDA 自报计数对照缺失或分组元数据不完整");
  }
  if (drcCountMismatch === true) {
    reasons.push(
      `eda_count_mismatch: EDA 自报计数合计 ${probe.eda_count_total ?? "null"} != ` +
        `去重后叶子数 ${drcLeafCount ?? "null"}`,
    );
  }
  if (digest === null) reasons.push("details_hash_missing: 未采集到 comps details 指纹");
  if (raw.offline === true) reasons.push("offline_empty_snapshot: before 是离线空壳");
  if (aggregate.connection_category_drift) {
    reasons.push(
      `connection_category_drift: ${aggregate.connection_leaf_hits} 个叶子的类别字段含 ` +
        "connection，但 cats 里没有对应类别项；未布通可能被吞掉，禁止判 pass",
    );
  }

  const warnings: string[] = [];
  if (probe.identity_incomplete) {
    warnings.push(
      `identity_incomplete: ${probe.identity_incomplete} 个叶子身份字段缺失，各自独立未合并`,
    );
  }
  if (probe.coord_missing) {
    warnings.push(`coord_missing: ${probe.coord_missing} 个叶子坐标缺失，各自独立未合并`);
  }
  if (aggregate.connection_category_drift) {
    warnings.push("connection_category_drift: cats 类别名异常，已置 comparable=false");
  }

  const availability = readoutAvailability({
    docTypeMismatch,
    settled,
    lines: raw.lines,
    vias: raw.vias,
    comps,
    pours: raw.pours,
    netsAvailable,
    drcAvailable,
  });

  return {
    lines: numOrCount(raw.lines),
    vias: numOrCount(raw.vias),
    comps,
    pours: numOrCount(raw.pours),
    nets: netsAvailable ? netsRaw : null,
    silk_count: silkCount,
    silk_hash: silkDigest,
    silk_available: silkAvailable,
    available: availability.available,
    available_reasons: availability.reasons,
    doc_type: docType,
    doc_type_mismatch: docTypeMismatch,
    settled,
    settled_mismatch_keys: settledKeys,
    settled_retried: settledRetried,
    nets_available: netsAvailable,
    drc_available: drcAvailable,
    drc: aggregate.drc,
    drc_cat: aggregate.drc_cat,
    drc_sub: aggregate.drc_sub,
    cats: aggregate.cats,
    connection_leaf_hits: aggregate.connection_leaf_hits,
    cats_connection_hits: aggregate.cats_connection_hits,
    connection_category_drift: aggregate.connection_category_drift,
    reader_id: readerId,
    details_hash: digest,
    details_count: detailsPresent ? (detailsRaw as unknown[]).length : null,
    designator_set_hash: designatorDigest,
    designators_available: designatorsAvailable,
    designators_count: designatorsCount,
    drc_dup_removed: drcDupRemoved,
    drc_count_mismatch: drcCountMismatch,
    drc_leaf_hash: drcLeafHashValue,
    drc_raw_leaf_count: drcRawLeafCount,
    drc_leaf_count: drcLeafCount,
    eda_counts_available: probe.eda_counts_available,
    eda_count_total: probe.eda_count_total,
    identity_incomplete: probe.identity_incomplete,
    coord_missing: probe.coord_missing,
    unresolved_identity: probe.unresolved_identity,
    unresolved_coord: probe.unresolved_coord,
    probes: {
      ...probe.probes,
      drc_dup_removed: drcDupRemoved,
      drc_count_mismatch: drcCountMismatch,
      drc_leaf_hash: drcLeafHashValue,
      probe_complete: probeComplete,
    },
    comparable: reasons.length === 0,
    reasons,
    warnings,
  };
}

function designatorDigestOf(ids: readonly string[], readerId: string): string {
  return designatorDigest(ids, readerId);
}

function numOrCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return null;
}

// ─── 指纹汇总与快照比较 ───────────────────────────────────────────────

export interface BoardDigest {
  reader_id: string;
  snapshot_key: string;
  details_hash: string | null;
  designator_set_hash: string | null;
  silk_hash: string | null;
  drc_leaf_hash: string | null;
  drc_dup_removed: number | null;
  drc_count_mismatch: boolean | null;
  drc: number | null;
  drc_leaf_count: number | null;
  drc_raw_leaf_count: number | null;
  cats: string[] | null;
  details_count: number | null;
  designators_count: number | null;
  silk_count: number | null;
  comparable: boolean;
  judge: "judgeable" | "unjudgeable";
  reasons: string[];
  warnings: string[];
  probes: Record<string, unknown>;
}

/** 单次读数的指纹汇总。`comparable=false` 时 judge 一律 unjudgeable。 */
export function boardDigest(state: BoardState): BoardDigest {
  return {
    reader_id: state.reader_id,
    snapshot_key: snapshotKey(state),
    details_hash: state.details_hash,
    designator_set_hash: state.designator_set_hash,
    silk_hash: state.silk_hash,
    drc_leaf_hash: state.drc_leaf_hash,
    drc_dup_removed: state.drc_dup_removed,
    drc_count_mismatch: state.drc_count_mismatch,
    drc: state.drc,
    drc_leaf_count: state.drc_leaf_count,
    drc_raw_leaf_count: state.drc_raw_leaf_count,
    cats: state.cats,
    details_count: state.details_count,
    designators_count: state.designators_count,
    silk_count: state.silk_count,
    comparable: state.comparable,
    judge: state.comparable ? "judgeable" : "unjudgeable",
    reasons: state.reasons,
    warnings: state.warnings,
    probes: state.probes,
  };
}

export interface BoardDigestComparison {
  comparable: boolean;
  verdict: "pass" | "fail" | "unjudgeable";
  reasons: string[];
  reader_ids: string[];
  snapshot_key_before: string;
  snapshot_key_after: string;
  drc_leaf_hashes: Array<string | null>;
  states: { before: number; after: number };
}

/**
 * 比较两份读数：只有 reader_id 一致、双探针齐备、details 指纹存在时才判 pass/fail。
 * 其它情况一律 unjudgeable（既不判通过也不判失败）。
 */
export function compareBoardDigest(
  beforeRaw: unknown,
  afterRaw: unknown,
  options: { readerId?: string; tol?: number } = {},
): BoardDigestComparison {
  const readerId = options.readerId ?? READER_ID;
  const before = normalizeBoardState(beforeRaw, { readerId, tol: options.tol });
  const after = normalizeBoardState(afterRaw, { readerId, tol: options.tol });
  const reasons: string[] = [];
  if (isRecord(beforeRaw) && beforeRaw.offline === true) {
    reasons.push("offline_empty_snapshot: before 是离线空壳，四键无从核对");
  }
  const readerIds = [String(before.reader_id), String(after.reader_id)];
  if (new Set(readerIds).size !== 1) {
    reasons.push(
      `cross_reader_blocked: reader_id 不一致 ${JSON.stringify([...new Set(readerIds)].sort())}`,
    );
  }
  for (const [index, state] of [before, after].entries()) {
    if (state.reader_id !== readerId) {
      reasons.push(
        `v1_reader_blocked: 状态 ${index} 的 reader_id=${state.reader_id}，要求 ${readerId}`,
      );
    }
    if (!state.details_hash)
      reasons.push(`details_hash_missing: 状态 ${index} 无 details 指纹（G11）`);
    if (state.drc_count_mismatch === true) {
      reasons.push(`eda_count_mismatch: 状态 ${index} 的 EDA 自报计数与去重叶子数不符`);
    }
    if (state.eda_counts_available === false) {
      reasons.push(`eda_counts_missing: 状态 ${index} 无 EDA 自报计数对照`);
    }
    for (const key of PROBE_KEYS) {
      if (state[key] === null || state[key] === undefined) {
        reasons.push(`probe_not_covered: 状态 ${index}.${key} 缺失`);
      }
    }
    for (const reason of state.reasons) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  const comparable = reasons.length === 0 && before.comparable && after.comparable;
  const keyBefore = snapshotKey(before);
  const keyAfter = snapshotKey(after);
  let verdict: BoardDigestComparison["verdict"];
  if (!comparable) {
    if (reasons.length === 0) reasons.push("comparable_false: 至少一个状态 comparable=false");
    verdict = "unjudgeable";
  } else {
    verdict = keyBefore === keyAfter ? "pass" : "fail";
    if (verdict === "fail") reasons.push("snapshot_key_mismatch: before/after 快照主键不相等");
  }
  return {
    comparable,
    verdict,
    reasons,
    reader_ids: readerIds,
    snapshot_key_before: keyBefore,
    snapshot_key_after: keyAfter,
    drc_leaf_hashes: [before.drc_leaf_hash, after.drc_leaf_hash],
    states: { before: 1, after: 1 },
  };
}
