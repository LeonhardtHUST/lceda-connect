/**
 * 原理图页 → IR → 网络。
 *
 * 连通性判定只认三种几何接触：
 * 1. 点与点重合（容差 0.02，即 TOL）；
 * 2. 线段端点与另一线段端点重合；
 * 3. 点严格落在线段内部（EDA 的 junction 语义）。
 * 不做 ±1 以上的宽松匹配，否则平行引线会被误短接。
 */
import type {
  IrComponent,
  IrPin,
  IrWire,
  PageInfo,
  ParsedDoc,
  PinNetMap,
  SchematicIr,
  SchematicNet,
} from "./contract.ts";
import {
  Y_SIGN,
  componentType,
  deviceUuidOf,
  placementOf,
  transformPin,
  valueLike,
  type DeviceDoc,
  type SymbolDoc,
  type SymbolPin,
} from "./library.ts";
import { attrMap, docElements, isPlainRecord } from "./records.ts";
import { scalarText } from "./text.ts";

export const TOL = 0.02;

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: string): string {
    this.add(key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root) ?? root;
    while (this.parent.get(key) !== root) {
      const next = this.parent.get(key) ?? root;
      this.parent.set(key, root);
      key = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }

  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const list = out.get(root);
      if (list) list.push(key);
      else out.set(root, [key]);
    }
    return out;
  }
}

/** 坐标点键：两位小数，与 Python 版 `%.2f,%.2f` 一致。 */
export function pointKey(x: number, y: number): string {
  return `${formatFixed(x, 2)},${formatFixed(y, 2)}`;
}

function formatFixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : scalarText(value);
}

/** 点严格落在线段内部（不包含两端点）。 */
export function onSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  eps = TOL,
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const sq = dx * dx + dy * dy;
  if (sq === 0) return false;
  const cross = dx * (py - y1) - dy * (px - x1);
  if (Math.abs(cross) > eps * Math.sqrt(sq)) return false;
  const t = ((px - x1) * dx + (py - y1) * dy) / sq;
  return 0.001 < t && t < 0.999;
}

type Segment = [number, number, number, number];

/**
 * 线段的空间索引：按包围盒登记进固定尺寸网格桶。
 *
 * 只用来筛掉不可能接触的线段，接触判定仍然交给 onSegment，所以连通性语义
 * 与逐条遍历完全一致。线段跨格时登记它覆盖的所有格子；引脚查本格 + 邻格；
 * 超长线段降级到 8 倍粗网格，粗网格仍超限则放进 loose 线性表。
 */
class SegmentGrid {
  private static readonly MAX_CELLS = 64;
  private readonly segments: readonly Segment[];
  private readonly buckets = new Map<string, number[]>();
  private readonly coarse = new Map<string, number[]>();
  private readonly loose: number[] = [];
  private readonly cell: number;
  private readonly coarseCell: number;

  constructor(segments: readonly Segment[], tol: number) {
    this.segments = segments;
    if (segments.length === 0) {
      this.cell = Math.max(tol * 10, 1);
      this.coarseCell = this.cell * 8;
      return;
    }
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [x1, y1, x2, y2] of segments) {
      minX = Math.min(minX, x1, x2);
      maxX = Math.max(maxX, x1, x2);
      minY = Math.min(minY, y1, y2);
      maxY = Math.max(maxY, y1, y2);
    }
    const span = Math.max(maxX - minX, maxY - minY, 0);
    this.cell = Math.max(tol * 10, span / Math.max(1, Math.sqrt(segments.length)));
    this.coarseCell = this.cell * 8;
    segments.forEach((seg, index) => {
      if (this.insert(index, seg, this.cell, this.buckets)) return;
      if (this.insert(index, seg, this.coarseCell, this.coarse)) return;
      this.loose.push(index);
    });
  }

  private cells(seg: Segment, cell: number): [number, number, number, number] {
    const [x1, y1, x2, y2] = seg;
    return [
      Math.floor(Math.min(x1, x2) / cell),
      Math.floor(Math.max(x1, x2) / cell),
      Math.floor(Math.min(y1, y2) / cell),
      Math.floor(Math.max(y1, y2) / cell),
    ];
  }

  private insert(
    index: number,
    seg: Segment,
    cell: number,
    buckets: Map<string, number[]>,
  ): boolean {
    const [i0, i1, j0, j1] = this.cells(seg, cell);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > SegmentGrid.MAX_CELLS) return false;
    for (let i = i0; i <= i1; i += 1) {
      for (let j = j0; j <= j1; j += 1) {
        const key = `${i},${j}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(index);
        else buckets.set(key, [index]);
      }
    }
    return true;
  }

  private collect(
    out: number[],
    buckets: Map<string, number[]>,
    px: number,
    py: number,
    cell: number,
  ): void {
    const ci = Math.floor(px / cell);
    const cj = Math.floor(py / cell);
    for (const di of [-1, 0, 1]) {
      for (const dj of [-1, 0, 1]) {
        const bucket = buckets.get(`${ci + di},${cj + dj}`);
        if (bucket) out.push(...bucket);
      }
    }
  }

  /** 返回可能与 (px, py) 接触的线段下标（含少量假阳性，由调用方精确判定）。 */
  query(px: number, py: number): number[] {
    if (this.segments.length === 0) return [];
    const out = [...this.loose];
    this.collect(out, this.buckets, px, py, this.cell);
    if (this.coarse.size > 0) this.collect(out, this.coarse, px, py, this.coarseCell);
    return out;
  }
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return null;
  return scalarText(value).trim();
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function pageNameOf(meta: Record<string, unknown>, pageName?: string | null): string {
  if (pageName) return pageName;
  return stringValue(meta.title) ?? "";
}

/** 原理图页 → IR。 */
export function pageToIr(
  doc: ParsedDoc,
  symbols: Map<string, SymbolDoc>,
  devices: Map<string, DeviceDoc>,
  project: string | null = null,
  pageName?: string | null,
): SchematicIr {
  const { byType, meta } = docElements(doc);
  const attrsByParent = attrMap(byType);
  const page: PageInfo = {
    uuid: doc.uuid,
    name: pageNameOf(meta, pageName),
    docType: doc.docType,
  };
  const ir: SchematicIr = {
    project,
    page,
    components: [],
    wires: [],
    nets: [],
    warnings: [],
  };

  for (const [cid, comp] of byType.get("COMPONENT") ?? []) {
    if (!isPlainRecord(comp)) continue;
    const inline = isPlainRecord(comp.attrs) ? comp.attrs : {};
    const merged: Record<string, unknown> = { ...attrsByParent.get(cid) };
    for (const [key, value] of Object.entries(inline)) {
      if (!(key in merged)) merged[key] = value;
    }

    const devUuid = deviceUuidOf(inline, merged);
    const device = devices.get(devUuid ?? "") ?? ({} as DeviceDoc);
    const devAttrs = isPlainRecord(device.attributes) ? device.attributes : {};
    const symUuid = merged.Symbol || devAttrs.Symbol;
    const symbol = symbols.get(symUuid ? scalarText(symUuid) : "") ?? ({} as SymbolDoc);
    const ctype = componentType(symbol, device);

    const item: IrComponent = {
      id: cid,
      componentType: ctype,
      designator: firstString(merged.Designator, devAttrs.Designator),
      deviceUuid: devUuid,
      deviceTitle: firstString(device.title, merged.Name),
      manufacturerPart: firstString(
        merged["Manufacturer Part"],
        devAttrs["Manufacturer Part"],
        devAttrs.Name,
      ),
      value: firstString(
        merged.Value,
        devAttrs.Value,
        valueLike(merged.Name),
        valueLike(devAttrs.Name),
      ),
      x: round2((comp.x as number) || 0),
      y: round2(Y_SIGN * ((comp.y as number) || 0)),
      rotation: (comp.rotation as number | string) || 0,
      mirror: Boolean(comp.isMirror),
      pins: [],
      attrs: Object.fromEntries(
        Object.entries(merged).filter(([, value]) => value !== null && value !== undefined),
      ),
    };

    // 记录的摆放字段名（isMirror）与变换函数入参名（mirror）不同，
    // 归一集中由 placementOf() 负责；不归一镜像分支就读不到。
    const placement = placementOf(comp);
    for (const pin of (symbol.pins ?? new Map<string, SymbolPin>()).values()) {
      const absolute = transformPin(pin.x, pin.y, placement);
      item.pins.push({
        number: pin.number,
        name: pin.name,
        x: round2(absolute.x),
        y: round2(Y_SIGN * absolute.y),
      });
    }
    if (ctype === "netflag" || ctype === "netport") {
      item.net = firstString(
        merged["Global Net Name"],
        symbol.globalNetName,
        merged.Name,
        devAttrs.Name,
      );
    }
    ir.components.push(item);
  }

  const wireNet = new Map<string, string>();
  for (const [wid] of byType.get("WIRE") ?? []) {
    const attrs = attrsByParent.get(wid) ?? {};
    wireNet.set(wid, stringValue(attrs.NET) ?? "");
  }

  for (const [lid, line] of byType.get("LINE") ?? []) {
    if (!isPlainRecord(line)) continue;
    const group = line.lineGroup;
    const groupKey = scalarText(group);
    if (group === null || group === undefined || !wireNet.has(groupKey)) continue;
    const x1 = Number(line.startX || 0);
    const y1 = Y_SIGN * Number(line.startY || 0);
    const x2 = Number(line.endX || 0);
    const y2 = Y_SIGN * Number(line.endY || 0);
    if (Math.abs(x1 - x2) < 1e-9 && Math.abs(y1 - y2) < 1e-9) continue;
    const wire: IrWire = {
      id: lid,
      line: [round2(x1), round2(y1), round2(x2), round2(y2)],
      net: wireNet.get(groupKey) ?? "",
    };
    ir.wires.push(wire);
  }
  return ir;
}

/** 原理图侧 (位号, 引脚号) 的键。用 JSON 数组保证 null 与空串不会撞键。 */
export function pinKey(designator: string | null, pinNumber: string | null): string {
  return JSON.stringify([designator, pinNumber]);
}

/** pinKey 的逆运算，用于两侧比对时取回位号与引脚号。 */
export function splitPinKey(key: string): [string | null, string | null] {
  try {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && parsed.length >= 2) {
      return [
        parsed[0] === null ? null : scalarText(parsed[0]),
        parsed[1] === null ? null : scalarText(parsed[1]),
      ];
    }
  } catch {
    // 非本模块生成的键，按不可解析处理。
  }
  return [null, null];
}

/** 填 ir.nets，返回 {(designator, pinNumber): netName}。 */
export function buildNets(ir: SchematicIr, tol = TOL): PinNetMap {
  const uf = new UnionFind();
  const pins: { key: string; comp: IrComponent; pin: IrPin }[] = [];
  for (const comp of ir.components) {
    for (const pin of comp.pins) {
      const key = pointKey(pin.x, pin.y);
      uf.add(key);
      pins.push({ key, comp, pin });
    }
  }

  const segments: Segment[] = [];
  for (const wire of ir.wires) {
    const [x1, y1, x2, y2] = wire.line;
    const a = pointKey(x1, y1);
    const b = pointKey(x2, y2);
    uf.union(a, b);
    segments.push([x1, y1, x2, y2]);
  }

  const grid = new SegmentGrid(segments, tol);
  for (const { key, pin } of pins) {
    const px = pin.x;
    const py = pin.y;
    const seen = new Set<number>();
    for (const index of grid.query(px, py)) {
      if (seen.has(index)) continue;
      seen.add(index);
      const [x1, y1, x2, y2] = segments[index] ?? [0, 0, 0, 0];
      if (
        Math.min(x1, x2) - tol <= px &&
        px <= Math.max(x1, x2) + tol &&
        Math.min(y1, y2) - tol <= py &&
        py <= Math.max(y1, y2) + tol
      ) {
        if (onSegment(px, py, x1, y1, x2, y2)) {
          uf.union(key, pointKey(x1, y1));
        }
      }
    }
  }

  // 显式网络名：导线 NET 属性 + 网络标识/端口元件。
  const names = new Map<string, Set<string>>();
  const addName = (key: string, name: string | null): void => {
    if (!name) return;
    const set = names.get(key) ?? new Set<string>();
    set.add(name);
    names.set(key, set);
  };
  for (const wire of ir.wires) {
    const name = (wire.net || "").trim();
    if (!name) continue;
    const [x1, y1, x2, y2] = wire.line;
    addName(pointKey(x1, y1), name);
    addName(pointKey(x2, y2), name);
  }
  for (const comp of ir.components) {
    if (comp.componentType !== "netflag" && comp.componentType !== "netport") continue;
    const name = (comp.net || "").trim();
    if (!name) continue;
    for (const pin of comp.pins) addName(pointKey(pin.x, pin.y), name);
  }

  // 同名网络全局合并。
  let rootNames = new Map<string, Set<string>>();
  for (const [key, ns] of names) {
    const root = uf.find(key);
    const set = rootNames.get(root) ?? new Set<string>();
    for (const name of ns) set.add(name);
    rootNames.set(root, set);
  }
  const byName = new Map<string, string[]>();
  for (const [root, ns] of rootNames) {
    for (const name of ns) {
      const roots = byName.get(name) ?? [];
      roots.push(root);
      byName.set(name, roots);
    }
  }
  for (const roots of byName.values()) {
    for (const root of roots.slice(1)) uf.union(roots[0] ?? root, root);
  }

  // 合并后重算，根节点可能已经变了。
  rootNames = new Map<string, Set<string>>();
  for (const [key, ns] of names) {
    const root = uf.find(key);
    const set = rootNames.get(root) ?? new Set<string>();
    for (const name of ns) set.add(name);
    rootNames.set(root, set);
  }

  const groups = uf.groups();
  const membersByRoot = new Map<string, SchematicNet["pins"]>();
  for (const { key, comp, pin } of pins) {
    const root = uf.find(key);
    const members = membersByRoot.get(root) ?? [];
    members.push({
      designator: comp.designator,
      pinNumber: pin.number,
      pinName: pin.name,
      componentType: comp.componentType,
    });
    membersByRoot.set(root, members);
  }

  const pinNet: PinNetMap = new Map();
  const nets: SchematicNet[] = [];
  for (const root of groups.keys()) {
    const members = membersByRoot.get(root) ?? [];
    if (members.length === 0) continue;
    const ns = [...(rootNames.get(root) ?? new Set<string>())].sort();
    const name = ns[0] ?? `N$${nets.length}`;
    nets.push({
      name,
      named: ns.length > 0,
      conflicts: ns.slice(1),
      pins: members,
    });
    for (const member of members) {
      pinNet.set(pinKey(member.designator, member.pinNumber), name);
    }
  }

  nets.sort((a, b) => {
    if (a.named !== b.named) return a.named ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  ir.nets = nets;

  const conflicts = nets.filter((net) => net.conflicts.length > 0);
  if (conflicts.length > 0) {
    ir.warnings.push(`${conflicts.length} 个网络存在多个名字（可能是真短路或历史残留线段）`);
  }
  if (ir.wires.length === 0) {
    ir.warnings.push("本页没有导线记录，连通性仅依赖引脚坐标重合");
  }
  return pinNet;
}

export function validate(ir: SchematicIr): string[] {
  const warns = [...(ir.warnings ?? [])];
  const parts = ir.components.filter((comp) => comp.componentType === "part");
  if (parts.length === 0) {
    warns.push("没有识别到任何元件");
  } else if (!parts.some((comp) => comp.pins.length > 0)) {
    warns.push("元件都没有引脚数据，符号表可能没解析到");
  }
  const missing = parts.filter((comp) => !comp.designator);
  if (missing.length > 0) warns.push(`${missing.length} 个元件没有位号`);
  return warns;
}
