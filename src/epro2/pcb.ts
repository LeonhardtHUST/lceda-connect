/**
 * PCB 文档解析：权威网表 + 几何。
 *
 * 权威网表规则：
 * - 只有带 Designator 属性的 COMPONENT 是当前元件，无位号的是删除残留；
 * - PAD_NET 的 id 形如 ["PAD_NET", 元件id, 焊盘号, 引脚id]，同一 (元件, 焊盘)
 *   有多条历史记录，只取 ticket 最大的那条；
 * - 引脚号必须经元件所属符号解析：引脚 id 只在符号文档内唯一。
 *
 * 几何单位：PCB 坐标为 mil，与 CANVAS.unit 写的 mm 无关。
 */
import type {
  OutlineBox,
  OutlineEntry,
  OutlineUnion,
  ParsedDoc,
  PcbGeometry,
  PcbRow,
  PcbSegment,
  PcbTraceSummary,
  PcbVia,
  StackupEntry,
} from "./contract.ts";
import {
  type DeviceDoc,
  type FootprintDoc,
  type SymbolDoc,
  type SymbolPin,
  buildFootprints,
} from "./library.ts";
import { attrMap, docElements, isPlainRecord } from "./records.ts";
import { scalarText } from "./text.ts";

export const MIL_TO_MM = 0.0254;
export const BOARD_OUTLINE_LAYER = 11;
const COPPER_TYPES = new Set(["TOP", "BOTTOM", "INNER", "INNER1", "INNER2", "PLANE"]);

export interface ComponentMeta {
  designator: string | null;
  footprint: string | null;
  symbol: string | null;
  device: string | null;
  layerId: unknown;
  x: number;
  y: number;
  angle: number;
}

export interface PadNetInfo {
  padId: string | null;
  net: unknown;
}

type PadNetEntry = [number, PadNetInfo];

export function pcbDocs(docs: readonly ParsedDoc[]): ParsedDoc[] {
  return docs.filter((doc) => doc.docType === "PCB");
}

/** id 可能是数组，也可能是数组的 JSON 字符串。 */
export function asId(rid: unknown): unknown {
  if (typeof rid !== "string") return rid;
  try {
    const parsed: unknown = JSON.parse(rid);
    return Array.isArray(parsed) ? parsed : rid;
  } catch {
    return rid;
  }
}

function pyString(value: unknown): string {
  return scalarText(value, "None");
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : scalarText(value);
}

export function padNetKey(compId: string, padNum: string): string {
  return `${compId}\u0000${padNum}`;
}

/** {compId: {designator, footprint, symbol, device, layerId, x, y, angle}} */
export function componentMeta(
  byType: Map<string, [string, unknown][]>,
  devices?: Map<string, DeviceDoc>,
): Map<string, ComponentMeta> {
  const attrs = attrMap(byType);
  const out = new Map<string, ComponentMeta>();
  for (const [cid, comp] of byType.get("COMPONENT") ?? []) {
    if (!isPlainRecord(comp)) continue;
    const merged: Record<string, unknown> = { ...attrs.get(cid) };
    if (isPlainRecord(comp.attrs)) {
      for (const [key, value] of Object.entries(comp.attrs)) {
        if (!(key in merged)) merged[key] = value;
      }
    }
    const deviceUuid = merged.Device ? scalarText(merged.Device) : null;
    let symbolUuid = merged.Symbol ? scalarText(merged.Symbol) : null;
    if (!symbolUuid && deviceUuid) {
      const device = devices?.get(deviceUuid);
      const deviceSymbol = device?.attributes?.Symbol;
      symbolUuid = deviceSymbol ? scalarText(deviceSymbol) : null;
    }
    // 不能用 || 链：x / y / angle 为 0 是合法值（原点上的元件、0 度摆放）。
    const x = comp.x === null || comp.x === undefined ? numeric(comp.centerX) : numeric(comp.x);
    const y = comp.y === null || comp.y === undefined ? numeric(comp.centerY) : numeric(comp.y);
    const angle =
      comp.angle === null || comp.angle === undefined
        ? numeric(comp.rotation)
        : numeric(comp.angle);
    out.set(cid, {
      designator: textOrNull(merged.Designator),
      footprint: textOrNull(merged.Footprint),
      symbol: symbolUuid,
      device: deviceUuid,
      layerId: comp.layerId ?? null,
      x: x ?? 0,
      y: y ?? 0,
      angle: angle ?? 0,
    });
  }
  return out;
}

/** {(compId, padNum): (ticket, {padId, net})}，同键取最大 ticket。 */
export function padNetMap(doc: ParsedDoc): Map<string, PadNetEntry> {
  const best = new Map<string, PadNetEntry>();
  for (const [key, entry] of doc.elems) {
    const { type, id } = splitRecordKeySafe(key);
    if (type !== "PAD_NET" || !isPlainRecord(entry.payload)) continue;
    const parts = asId(id);
    if (!Array.isArray(parts) || parts.length < 3) continue;
    const compId = pyString(parts[1]);
    const padNum = pyString(parts[2]);
    const pinId = parts.length > 3 ? pyString(parts[3]) : null;
    const netKey = padNetKey(compId, padNum);
    const prev = best.get(netKey);
    if (prev === undefined || entry.ticket >= prev[0]) {
      best.set(netKey, [entry.ticket, { padId: pinId, net: entry.payload.padNet }]);
    }
  }
  return best;
}

function splitRecordKeySafe(key: string): { type: string; id: string } {
  const at = key.indexOf("\u0000");
  if (at < 0) return { type: key, id: "" };
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}

/** 返回 (rows, warnings)。rows: [{designator, pad, pinNumber, pinName, net, ticket}] */
export function buildNetlist(
  docs: readonly ParsedDoc[],
  symbols: Map<string, SymbolDoc>,
  devices?: Map<string, DeviceDoc>,
): { rows: PcbRow[]; warnings: string[] } {
  const rows: PcbRow[] = [];
  const warnings: string[] = [];
  let unresolved = 0;
  for (const doc of pcbDocs(docs)) {
    const { byType } = docElements(doc);
    const comps = componentMeta(byType, devices);
    const current = new Map<string, ComponentMeta>();
    for (const [cid, meta] of comps) {
      if (meta.designator) current.set(cid, meta);
    }
    const dropped = comps.size - current.size;
    if (dropped > 0) {
      warnings.push(`PCB 侧剔除 ${dropped} 个无位号元件（删除残留）`);
    }
    const nets = padNetMap(doc);
    for (const [key, [ticket, info]] of nets) {
      const at = key.indexOf("\u0000");
      const compId = key.slice(0, at);
      const padNum = key.slice(at + 1);
      const comp = current.get(compId);
      if (!comp) continue;
      let pinNumber: string | null = null;
      let pinName: string | null = null;
      const symbol = symbols.get(comp.symbol ?? "") ?? ({} as SymbolDoc);
      const pins = symbol.pins ?? new Map<string, SymbolPin>();
      // 物理引脚号 = 封装焊盘号，这是唯一可靠的匹配键。PAD_NET 第 4 个字段
      // 是封装焊盘 id，可能撞名却指向别的脚，只能在没有同号引脚时兜底。
      let pin: SymbolPin | null = null;
      for (const candidate of pins.values()) {
        if (pyString(candidate.number) === pyString(padNum)) {
          pin = candidate;
          break;
        }
      }
      if (!pin) pin = pins.get(info.padId ?? "") ?? null;
      if (pin) {
        pinNumber = pin.number;
        pinName = pin.name;
      } else {
        unresolved += 1;
      }
      rows.push({
        designator: comp.designator ?? "",
        component: compId,
        pad: padNum,
        pinNumber,
        pinName,
        net: info.net ? scalarText(info.net) : "",
        ticket,
      });
    }
  }
  rows.sort((a, b) => compareNatural(a.designator, b.designator) || compareNatural(a.pad, b.pad));
  if (unresolved > 0) {
    warnings.push(
      `${unresolved} 个焊盘无法映射到引脚号（符号 Pin Number 缺失），两侧网表比对会因此不完整`,
    );
  }
  return { rows, warnings };
}

/** 自然排序键：前缀字符串 + 第一个数字串。 */
export function naturalKey(value: unknown): [string, number] {
  const text = value === null || value === undefined ? "" : scalarText(value);
  const digits = text.replace(/[^\p{Nd}]/gu, "");
  const prefix = text.replace(/[\p{Nd}]/gu, "");
  return [prefix, digits ? Number.parseInt(digits, 10) : -1];
}

function compareNatural(a: unknown, b: unknown): number {
  const [pa, na] = naturalKey(a);
  const [pb, nb] = naturalKey(b);
  if (pa < pb) return -1;
  if (pa > pb) return 1;
  return na - nb;
}

/** 封装本地坐标 → 元件坐标系。PCB 的 angle 是逆时针正方向（实测）。 */
export function rotate(x: number, y: number, deg: number): [number, number] {
  if (!deg) return [x, y];
  const theta = (deg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  return [x * cosT - y * sinT, x * sinT + y * cosT];
}

function toFloat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/** 板框路径 → [(x, y)]。支持 ["R",x,y,w,h,rot,r] 与点序列两种写法。 */
export function polyPoints(payload: Record<string, unknown>): [number, number][] {
  const path = payload.path || payload.points || payload.polygon;
  if (!Array.isArray(path)) return [];
  const points: [number, number][] = [];
  let i = 0;
  while (i < path.length) {
    const item = path[i];
    if (typeof item === "string" && item.toUpperCase() === "R") {
      const x = toFloat(path[i + 1]);
      const y = toFloat(path[i + 2]);
      const w = toFloat(path[i + 3]);
      const h = toFloat(path[i + 4]);
      if (x === null || y === null || w === null || h === null) return points;
      points.push([x, y], [x + w, y], [x + w, y + h], [x, y + h]);
      i += 5;
      // R 形式末尾跟着 rotation 与 radius 两个数字，它们不是坐标点。
      if (i + 2 === path.length && typeof path[i] === "number" && typeof path[i + 1] === "number") {
        i += 2;
      }
      continue;
    }
    if (typeof item === "number" && typeof path[i + 1] === "number") {
      points.push([item, path[i + 1] as number]);
      i += 2;
      continue;
    }
    if (Array.isArray(item) && item.length >= 2) {
      const x = toFloat(item[0]);
      const y = toFloat(item[1]);
      if (x !== null && y !== null) points.push([x, y]);
    }
    i += 1;
  }
  return points;
}

function modeOf(counts: Map<string, number>): string | null {
  if (counts.size === 0) return null;
  const entries = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  return entries[0]?.[0] ?? null;
}

/** 过孔孔径键：Python 对 float 用 str()，整数 20.0 会写成 "20.0"。 */
function floatKey(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) return `${value}.0`;
  return pyString(value);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function outlineBox(points: readonly [number, number][]): OutlineBox {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const widthMil = maxX - minX;
  const heightMil = maxY - minY;
  return {
    min_x: minX,
    max_x: maxX,
    min_y: minY,
    max_y: maxY,
    width_mil: Math.round(widthMil * 100) / 100,
    height_mil: Math.round(heightMil * 100) / 100,
    width_mm: Math.round(widthMil * MIL_TO_MM * 100) / 100,
    height_mm: Math.round(heightMil * MIL_TO_MM * 100) / 100,
  };
}

/**
 * 返回几何字典。所有长度同时给原始 mil 与换算后的 mm。
 *
 * 多 PCB 文档的走线/过孔/铜层计数跨文档累加；板框逐板记在 outlines 里，
 * outline 给所有板框的并集范围。segments[] 与 pads[] 是逐图元原始记录，
 * traces 是按网络汇总的统计口径，两者不要混用。
 */
export function buildGeometry(docs: readonly ParsedDoc[]): PcbGeometry {
  const geo: PcbGeometry = {
    unit: "mil",
    outline: null,
    outlines: [],
    layers: [],
    stackup: [],
    traces: [],
    segments: [],
    vias: [],
    pads: [],
    warnings: [],
  };
  const footprints: Map<string, FootprintDoc> = buildFootprints(docs);
  const usedLayers = new Set<unknown>();
  const netLen = new Map<
    string,
    { net: string; segments: number; length_mil: number; widths: Map<string, number> }
  >();
  const viaSizes = new Map<string, number>();
  const outlineBoxes: OutlineEntry[] = [];

  for (const doc of pcbDocs(docs)) {
    const { byType } = docElements(doc);

    for (const [rid, layer] of byType.get("LAYER") ?? []) {
      const parts = asId(rid);
      const layerId = Array.isArray(parts) && parts.length > 1 ? parts[1] : rid;
      if (isPlainRecord(layer)) {
        geo.layers.push({
          id: layerId,
          type:
            layer.layerType === null || layer.layerType === undefined
              ? null
              : scalarText(layer.layerType),
          name:
            layer.layerName === null || layer.layerName === undefined
              ? null
              : scalarText(layer.layerName),
        });
      }
    }

    for (const [, line] of byType.get("LINE") ?? []) {
      if (!isPlainRecord(line)) continue;
      const net = line.netName ? scalarText(line.netName) : "";
      const x1 = toFloat(line.startX) ?? 0;
      const y1 = toFloat(line.startY) ?? 0;
      const x2 = toFloat(line.endX) ?? 0;
      const y2 = toFloat(line.endY) ?? 0;
      const length = Math.hypot(x2 - x1, y2 - y1);
      usedLayers.add(line.layerId);
      let entry = netLen.get(net);
      if (!entry) {
        entry = { net, segments: 0, length_mil: 0, widths: new Map() };
        netLen.set(net, entry);
      }
      entry.segments += 1;
      entry.length_mil += length;
      const width = line.width;
      if (width !== null && width !== undefined) {
        const key = pyString(width);
        entry.widths.set(key, (entry.widths.get(key) ?? 0) + 1);
      }
      if (length > 0) {
        const segment: PcbSegment = {
          net,
          layer_id: line.layerId ?? null,
          x1: round3(x1),
          y1: round3(y1),
          x2: round3(x2),
          y2: round3(y2),
          width: width ?? null,
        };
        geo.segments.push(segment);
      }
    }

    for (const [, via] of byType.get("VIA") ?? []) {
      if (!isPlainRecord(via)) continue;
      const hole = via.holeDiameter ?? null;
      const holeKey = floatKey(hole);
      viaSizes.set(holeKey, (viaSizes.get(holeKey) ?? 0) + 1);
      const entry: PcbVia = {
        net: via.netName ? scalarText(via.netName) : "",
        x: via.centerX ?? null,
        y: via.centerY ?? null,
        hole,
        diameter: via.viaDiameter ?? null,
        type: via.viaType ?? null,
      };
      geo.vias.push(entry);
    }

    // 焊盘绝对坐标 = 元件坐标 + 旋转后的封装本地坐标。只保留有位号的元件。
    const comps = componentMeta(byType);
    const padNets = padNetMap(doc);
    for (const [compId, comp] of comps) {
      if (!comp.designator) continue;
      const footprint = footprints.get(comp.footprint ?? "") ?? ({} as FootprintDoc);
      for (const pad of footprint.pads ?? []) {
        const num = pyString(pad.num);
        const [ax, ay] = rotate(pad.x, pad.y, comp.angle || 0);
        let layerId = pad.layer_id || 12;
        if (Math.trunc(layerId) === 12) layerId = Number(comp.layerId) || 1;
        const hit = padNets.get(padNetKey(compId, num));
        const net = hit?.[1].net ? scalarText(hit[1].net) : "";
        geo.pads.push({
          component: comp.designator,
          pin: num,
          net,
          x: round3(comp.x + ax),
          y: round3(comp.y + ay),
          layer_id: Math.trunc(layerId),
          w: pad.w,
          h: pad.h,
        });
        usedLayers.add(Math.trunc(layerId));
      }
    }

    const points: [number, number][] = [];
    for (const [, poly] of byType.get("POLY") ?? []) {
      if (!isPlainRecord(poly)) continue;
      if (poly.polyType === "BOARD_OUTLINE" || poly.layerId === BOARD_OUTLINE_LAYER) {
        points.push(...polyPoints(poly));
      }
    }
    if (points.length > 0) {
      const box = outlineBox(points);
      const listed: OutlineEntry = { ...box, doc: doc.uuid };
      outlineBoxes.push(listed);
      geo.outlines.push(listed);
    }

    for (const [rid, rec] of byType.get("LAYER_PHYS") ?? []) {
      if (isPlainRecord(rec)) {
        const entry: StackupEntry = { id: asId(rid), raw: rec };
        geo.stackup.push(entry);
      }
    }
  }

  // ---- 跨文档汇总：这里只算一次，避免多 PCB 文档互相覆盖 ----
  if (geo.stackup.length === 0) {
    geo.warnings.push("没有 LAYER_PHYS 记录，叠层无法确认");
  }

  for (const entry of netLen.values()) {
    const widths = entry.widths;
    const trace: PcbTraceSummary = {
      net: entry.net,
      segments: entry.segments,
      length_mil: Math.round(entry.length_mil * 100) / 100,
      width_mil_mode: modeOf(widths),
      length_mm: Math.round(entry.length_mil * MIL_TO_MM * 100) / 100,
    };
    geo.traces.push(trace);
  }
  geo.traces.sort((a, b) => b.length_mil - a.length_mil);

  geo.via_hole_histogram = Object.fromEntries([...viaSizes.entries()].sort((a, b) => b[1] - a[1]));

  if (outlineBoxes.length > 0) {
    const minX = Math.min(...outlineBoxes.map((box) => box.min_x));
    const maxX = Math.max(...outlineBoxes.map((box) => box.max_x));
    const minY = Math.min(...outlineBoxes.map((box) => box.min_y));
    const maxY = Math.max(...outlineBoxes.map((box) => box.max_y));
    const widthMil = maxX - minX;
    const heightMil = maxY - minY;
    const union: OutlineUnion = {
      min_x: minX,
      max_x: maxX,
      min_y: minY,
      max_y: maxY,
      width_mil: Math.round(widthMil * 100) / 100,
      height_mil: Math.round(heightMil * 100) / 100,
      width_mm: Math.round(widthMil * MIL_TO_MM * 100) / 100,
      height_mm: Math.round(heightMil * MIL_TO_MM * 100) / 100,
      boards: outlineBoxes.length,
    };
    geo.outline = union;
    if (outlineBoxes.length > 1) {
      geo.warnings.push(
        `工程含 ${outlineBoxes.length} 个 PCB 文档（多板）：板框给的是各板并集尺寸` +
          "（逐板尺寸见 outlines），走线与过孔按网络名跨板合并，未按板拆分",
      );
    }
  }

  const copper = geo.layers.filter((layer) => COPPER_TYPES.has((layer.type ?? "").toUpperCase()));
  const used = copper.filter((layer) => usedLayers.has(layer.id));
  geo.copper_layers_used = used.length;
  geo.copper_layers_declared = copper.length;
  geo.segment_count = geo.segments.length;
  geo.pad_count = geo.pads.length;
  return geo;
}

/** PCB 权威网表 CSV。BOM 由写文件的一方补，这个函数只负责正文。 */
export function formatNetlistCsv(rows: readonly PcbRow[]): string {
  const header = "位号,焊盘号,引脚号,引脚名,网络\n";
  const body = rows
    .map((row) =>
      [row.designator, row.pad, row.pinNumber, row.pinName, row.net].map(csvField).join(","),
    )
    .map((line) => `${line}\n`)
    .join("");
  return header + body;
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = scalarText(value);
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}
