/**
 * `.eprj3` 网表（移植自源仓库 `scripts/lib/netlist.js` + `geom.js` / `parts.js`
 * 里网表需要的那部分）。
 *
 * 连通规则与客户端一致：
 * - 一条 WIRE 的多个线段共享端点；
 * - 引脚在 TIP 坐标上连接导线端点（精确相等，客户端就是按这个吸附的）；
 * - 落在导线端点上的两个引脚直接相连；
 * - 带同一 NET 名的 WIRE 属于同一网络（标签语义）；
 * - 电源旗标 / 网络端口在原点连接并注入网名。
 *
 * 与源仓库的差异：源版直接读原始记录，客户端编辑过的工程里墓碑（空体删除）
 * 会残留；这里每个文档先归约，再取存活记录。坐标单位一律 mil。
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { loadEprj3Project, pcbFile, sheetFile, type Eprj3Project } from "./project.ts";
import { docTypeNumber, readDocumentFile, reduceDocSection, type Eprj3Record } from "./records.ts";

const EPS = 1e-6;
const PIN_LEN = 10;
const SYMBOL_DOC_TYPES: Record<number, string> = { 2: "symbol", 18: "power", 19: "port" };

interface Point {
  x: number;
  y: number;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function rad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** 绕原点逆时针旋转。 */
export function rotate(x: number, y: number, degrees: number): Point {
  const d = ((degrees % 360) + 360) % 360;
  if (d === 0) return { x, y };
  if (d === 90) return { x: -y, y: x };
  if (d === 180) return { x: -x, y: -y };
  if (d === 270) return { x: y, y: -x };
  const c = Math.cos(rad(d));
  const s = Math.sin(rad(d));
  return { x: x * c - y * s, y: x * s + y * c };
}

/** 坐标取到 0.001 mil（网表键按这个精度比较）。 */
export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 引脚在页面/PCB 坐标里的连接点（TIP）。
 *
 * PIN 记录的 (x,y) 本身就是热点；`length` 是从热点往体内画的长度，不参与坐标。
 * 源仓库 1.16.0 已改成这个口径（旧版多算了一个引脚长度，生成导线会飘在引脚外）。
 */
export function pinTip(
  pin: SymbolPin,
  originX: number,
  originY: number,
  originRotation: number,
): Point {
  const rotated = rotate(pin.x, pin.y, originRotation || 0);
  return { x: round(originX + rotated.x), y: round(originY + rotated.y) };
}

/** 点到线段距离（mil）。 */
export function pointSegDist(point: Point, segment: Segment): number {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const length2 = dx * dx + dy * dy;
  if (length2 < EPS) return Math.hypot(point.x - segment.x1, point.y - segment.y1);
  let t = ((point.x - segment.x1) * dx + (point.y - segment.y1) * dy) / length2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (segment.x1 + t * dx), point.y - (segment.y1 + t * dy));
}

export function netKey(x: number, y: number): string {
  return `${round(x)},${round(y)}`;
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(value: string): string {
    if (!this.parent.has(value)) this.parent.set(value, value);
    let root = value;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root) ?? root;
    }
    let cursor = value;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor) ?? root;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

export interface SymbolPin {
  num: string;
  name: string;
  type: string;
  x: number;
  y: number;
  length: number;
  rotation: number;
  elemId: string | null;
  partId: string | null;
  tip: Point;
}

export interface SymbolEntry {
  kind: string;
  docType: number | undefined;
  pins: SymbolPin[];
  pinByNum: Map<string, SymbolPin>;
  pinsByPart: Map<string, SymbolPin[]>;
  parts: { partId: string; pins: SymbolPin[] }[];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

/** 解析一个 SYMBOL / 电源符号 / 端口符号文档的引脚（含 tip 与多部件分组）。 */
export function parseSymbolEntry(records: readonly Eprj3Record[]): SymbolEntry {
  const docType = docTypeNumber(records);
  const kind = docType === undefined ? "symbol" : (SYMBOL_DOC_TYPES[docType] ?? "symbol");
  const pins: SymbolPin[] = [];
  const byId = new Map<string, SymbolPin>();

  for (const record of records) {
    if (record.type !== "PIN") continue;
    const body = record.body;
    const pin: SymbolPin = {
      num: "",
      name: "",
      type: "Undefined",
      x: numberOr(body.x, 0),
      y: numberOr(body.y, 0),
      length: body.length === undefined ? PIN_LEN : numberOr(body.length, PIN_LEN),
      rotation: numberOr(body.rotation, 0),
      elemId: record.id,
      partId: typeof body.partId === "string" ? body.partId : null,
      tip: { x: 0, y: 0 },
    };
    // 电源旗标 / 网络端口按原点摆放：符号本体画在连接点之外。
    if (docType === 18 || docType === 19 || pin.length === 0) {
      pin.x = 0;
      pin.y = 0;
      pin.length = 0;
    }
    pin.tip = pinTip(pin, 0, 0, 0);
    pins.push(pin);
    if (record.id !== null) byId.set(record.id, pin);
  }

  for (const record of records) {
    if (record.type !== "ATTR" || typeof record.body.parentId !== "string") continue;
    const pin = byId.get(record.body.parentId);
    if (pin === undefined) continue;
    const key = record.body.key;
    const value = record.body.value;
    if (key === "Pin Number") pin.num = stringOr(value);
    else if (key === "Pin Name") pin.name = stringOr(value);
    else if (key === "Pin Type") pin.type = stringOr(value);
  }
  pins.forEach((pin, index) => {
    if (pin.num === "") pin.num = pin.name === "" ? String(index + 1) : pin.name;
    if (pin.name === "") pin.name = pin.num;
  });

  const pinsByPart = new Map<string, SymbolPin[]>();
  for (const pin of pins) {
    const partId = pin.partId ?? "";
    const list = pinsByPart.get(partId) ?? [];
    list.push(pin);
    pinsByPart.set(partId, list);
  }
  return {
    kind,
    docType,
    pins,
    pinByNum: new Map(pins.map((pin) => [pin.num, pin])),
    pinsByPart,
    parts: [...pinsByPart.entries()].map(([partId, list]) => ({ partId, pins: list })),
  };
}

export interface SheetDoc {
  docType: string | null;
  uuid: string | null;
  records: Eprj3Record[];
}

export interface SheetRead {
  docs: SheetDoc[];
  main: SheetDoc;
}

/** 把页容器拆成嵌入文档与主 SCH_PAGE；空文件返回一个空壳而不是抛异常。 */
export function readSheet(file: string): SheetRead {
  const split = readDocumentFile(file);
  const docs: SheetDoc[] = split.sections.map((section) => ({
    docType: section.docType,
    uuid: section.uuid,
    records: reduceDocSection(section).records,
  }));
  const main = docs.find((doc) => doc.docType === "SCH_PAGE") ??
    docs[docs.length - 1] ?? { docType: null, uuid: null, records: [] };
  return { docs, main };
}

function attrsByParent(records: readonly Eprj3Record[], parentId: string | null): Eprj3Record[] {
  if (parentId === null) return [];
  return records.filter((record) => record.type === "ATTR" && record.body.parentId === parentId);
}

export interface NetlistPin {
  ref: string;
  num: string;
  name: string;
  x: number;
  y: number;
}

export interface NetlistNet {
  name: string;
  pins: NetlistPin[];
  flags: number;
  auto: boolean;
}

export interface NetlistComponent {
  ref: string;
  x: number;
  y: number;
  rotation: number;
  symbolUuid: string | null;
  partId: string | null;
  multipart: boolean;
  power: string | null;
  pins: { num: string; name: string; x: number; y: number }[];
}

export interface SheetNetlist {
  components: NetlistComponent[];
  nets: NetlistNet[];
  unconnected: { ref: string; num: string; name: string; x: number; y: number }[];
  pinCount: number;
  wireCount: number;
}

/** 单页原理图的电气网表。 */
export function sheetNetlist(file: string): SheetNetlist {
  const { docs, main } = readSheet(file);
  const records = main.records;

  const symbolByUuid = new Map<string, SymbolEntry>();
  for (const doc of docs) {
    if (doc.docType !== "SYMBOL" || doc.uuid === null) continue;
    symbolByUuid.set(doc.uuid, parseSymbolEntry(doc.records));
  }

  const components: NetlistComponent[] = [];
  const nodes: { x: number; y: number; net: string }[] = [];
  for (const record of records) {
    if (record.type !== "COMPONENT") continue;
    const body = record.body;
    const attrs = attrsByParent(records, record.id);
    const designator = attrs.find((attr) => attr.body.key === "Designator")?.body;
    const symAttr = attrs.find((attr) => attr.body.key === "Symbol");
    const globalNet = attrs.find((attr) => attr.body.key === "Global Net Name");
    let deviceName: string | null = null;
    const attrsBlock = body.attrs;
    if (attrsBlock !== null && typeof attrsBlock === "object" && !Array.isArray(attrsBlock)) {
      const raw = (attrsBlock as Record<string, unknown>).DeviceName;
      if (typeof raw === "string") {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            deviceName = stringOr((parsed as Record<string, unknown>).name, "");
          }
        } catch {
          deviceName = null;
        }
      }
    }
    const symbolUuid = typeof symAttr?.body.value === "string" ? symAttr.body.value : null;
    const symbol = symbolUuid === null ? undefined : symbolByUuid.get(symbolUuid);
    const ref = stringOr(designator?.value, deviceName ?? "?");

    const partId = typeof body.partId === "string" ? body.partId : null;
    const partPins =
      symbol === undefined
        ? []
        : partId !== null && symbol.pinsByPart.has(partId)
          ? (symbol.pinsByPart.get(partId) ?? [])
          : symbol.pins;

    const x = numberOr(body.x, 0);
    const y = numberOr(body.y, 0);
    const rotation = numberOr(body.rotation, 0);
    const pins = partPins.map((pin) => {
      const tip = pinTip(pin, x, y, rotation);
      return { num: pin.num, name: pin.name, x: tip.x, y: tip.y };
    });
    components.push({
      ref,
      x,
      y,
      rotation,
      symbolUuid,
      partId,
      multipart: symbol !== undefined && symbol.parts.length > 1,
      power: typeof globalNet?.body.value === "string" ? globalNet.body.value : null,
      pins,
    });
    if (typeof globalNet?.body.value === "string") {
      nodes.push({ x, y, net: globalNet.body.value });
    }
  }

  // ------------------------------------------------------------- 导线
  const unionFind = new UnionFind();
  const wireNets: { wire: string; net: string }[] = [];
  const segments: { a: string; c: string; seg: Segment; wire: string }[] = [];
  const wireIds = new Set(
    records
      .filter((record) => record.type === "WIRE" && record.id !== null)
      .map((record) => record.id as string),
  );
  for (const record of records) {
    const lineGroup = record.body.lineGroup;
    if (record.type !== "LINE" || typeof lineGroup !== "string") continue;
    if (!wireIds.has(lineGroup)) continue;
    const body = record.body;
    const x1 = body.startX;
    const y1 = body.startY;
    const x2 = body.endX;
    const y2 = body.endY;
    if (
      typeof x1 !== "number" ||
      typeof y1 !== "number" ||
      typeof x2 !== "number" ||
      typeof y2 !== "number"
    ) {
      continue;
    }
    const a = netKey(x1, y1);
    const c = netKey(x2, y2);
    unionFind.union(a, c);
    segments.push({ a, c, seg: { x1, y1, x2, y2 }, wire: lineGroup });
  }
  for (const record of records) {
    if (record.type !== "ATTR" || record.body.key !== "NET") continue;
    if (typeof record.body.parentId !== "string") continue;
    if (!wireIds.has(record.body.parentId)) continue;
    // 空值不命名任何网络：把无名短线全都并成一张网会短路。
    if (typeof record.body.value !== "string" || record.body.value === "") continue;
    wireNets.push({ wire: record.body.parentId, net: record.body.value });
  }
  // 网络标签（客户端 addNetLabel 写的 _NETLABEL_ 原子）给所在导线命名。
  for (const record of records) {
    if (record.type !== "ATTR" || record.body.key !== "_NETLABEL_") continue;
    if (typeof record.body.value !== "string" || record.body.value === "") continue;
    if (typeof record.body.x !== "number" || typeof record.body.y !== "number") continue;
    const point = { x: record.body.x, y: record.body.y };
    const hit = segments.find((segment) => pointSegDist(point, segment.seg) < 0.01);
    if (hit !== undefined) wireNets.push({ wire: hit.wire, net: record.body.value });
  }

  // 标签语义：同名的每一段 WIRE 属于同一网络。
  const netRoots = new Map<string, string[]>();
  for (const wireNet of wireNets) {
    const wireSegments = segments.filter((segment) => segment.wire === wireNet.wire);
    const first = wireSegments[0];
    if (first === undefined) continue;
    const roots = netRoots.get(wireNet.net) ?? [];
    roots.push(unionFind.find(first.a));
    netRoots.set(wireNet.net, roots);
  }
  for (const roots of netRoots.values()) {
    const first = roots[0];
    if (first === undefined) continue;
    for (let index = 1; index < roots.length; index += 1) {
      const other = roots[index];
      if (other !== undefined) unionFind.union(first, other);
    }
  }

  // ------------------------------------------------------------- 引脚
  const pinNodes: {
    key: string;
    comp: string;
    pin: string;
    name: string;
    x: number;
    y: number;
    flag: boolean;
  }[] = [];
  const unconnected: { ref: string; num: string; name: string; x: number; y: number }[] = [];
  for (const component of components) {
    for (const pin of component.pins) {
      const pointKey = netKey(pin.x, pin.y);
      // 只有导线端点落在引脚上才算连上；导线从引脚上跨过不算（客户端也不连）。
      const segment = segments.find(
        (candidate) => candidate.a === pointKey || candidate.c === pointKey,
      );
      if (segment !== undefined) {
        unionFind.union(pointKey, segment.a);
        pinNodes.push({
          key: pointKey,
          comp: component.ref,
          pin: pin.num,
          name: pin.name,
          x: pin.x,
          y: pin.y,
          flag: component.power !== null,
        });
      } else {
        unconnected.push({ ref: component.ref, num: pin.num, name: pin.name, x: pin.x, y: pin.y });
        pinNodes.push({
          key: pointKey,
          comp: component.ref,
          pin: pin.num,
          name: pin.name,
          x: pin.x,
          y: pin.y,
          flag: component.power !== null,
        });
      }
    }
  }
  for (const node of nodes) unionFind.union(netKey(node.x, node.y), `net:${node.net}`);

  // ----------------------------------------------------------- 网络命名
  const rootNet = new Map<string, string>();
  for (const wireNet of wireNets) {
    const wireSegments = segments.filter((segment) => segment.wire === wireNet.wire);
    // 每段都登记：一条 WIRE 可能有几段互不相连的短线（stub + label 写法）。
    for (const segment of wireSegments) {
      rootNet.set(unionFind.find(segment.a), wireNet.net);
      rootNet.set(unionFind.find(segment.c), wireNet.net);
    }
  }
  for (const node of nodes) rootNet.set(unionFind.find(netKey(node.x, node.y)), node.net);

  const groups = new Map<string, { name: string | null; pins: NetlistPin[]; flags: number }>();
  for (const pinNode of pinNodes) {
    const root = unionFind.find(pinNode.key);
    let group = groups.get(root);
    if (group === undefined) {
      group = { name: rootNet.get(root) ?? null, pins: [], flags: 0 };
      groups.set(root, group);
    }
    // 电源旗标 / 网络端口是连接点，不是元件电极：命名网络但不进引脚表。
    if (pinNode.flag || pinNode.comp === "?") group.flags += 1;
    else
      group.pins.push({
        ref: pinNode.comp,
        num: pinNode.pin,
        name: pinNode.name,
        x: pinNode.x,
        y: pinNode.y,
      });
  }
  for (const [root, group] of groups) {
    if (group.name !== null) continue;
    const named = pinNodes.find(
      (pinNode) => unionFind.find(pinNode.key) === root && rootNet.has(root),
    );
    if (named !== undefined) group.name = rootNet.get(root) ?? null;
  }

  const named = new Map<string, NetlistNet>();
  let autoIndex = 0;
  for (const group of groups.values()) {
    if (group.pins.length === 0) continue;
    let name = group.name;
    if (name === null && group.pins.length > 1) {
      autoIndex += 1;
      name = `N$${autoIndex}`;
    }
    if (name === null) continue;
    const existing = named.get(name);
    if (existing !== undefined) {
      existing.pins.push(...group.pins);
      existing.flags += group.flags;
    } else {
      named.set(name, {
        name,
        pins: group.pins.slice(),
        flags: group.flags,
        auto: name.startsWith("N$"),
      });
    }
  }

  // 直接摆在引脚上的网络端口不算悬空。
  const namedUnconnected = unconnected.filter((pin) => {
    const root = unionFind.find(netKey(pin.x, pin.y));
    return !rootNet.has(root);
  });

  return {
    components,
    nets: [...named.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unconnected: namedUnconnected,
    pinCount: pinNodes.length,
    wireCount: segments.length,
  };
}

export interface PcbPad {
  ref: string;
  num: string;
  net: string;
}

export interface PcbNetlist {
  pads: PcbPad[];
  nets: { name: string; pins: { ref: string; num: string }[] }[];
}

/** PCB 网表：PAD_NET 是权威数据。 */
export function pcbNetlist(file: string): PcbNetlist {
  const split = readDocumentFile(file);
  const records = split.sections.flatMap((section) => reduceDocSection(section).records);
  const refByComponent = new Map<string, string>();
  for (const record of records) {
    if (record.type !== "ATTR" || typeof record.body.parentId !== "string") continue;
    if (record.body.key === "Designator" && typeof record.body.value === "string") {
      refByComponent.set(record.body.parentId, record.body.value);
    }
  }
  const pads: PcbPad[] = [];
  for (const record of records) {
    if (record.type !== "PAD_NET" || record.id === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.id);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed[0] !== "PAD_NET") continue;
    const component = stringOr(parsed[1]);
    pads.push({
      ref: refByComponent.get(component) ?? component,
      num: stringOr(parsed[2]),
      net: typeof record.body.padNet === "string" ? record.body.padNet : "",
    });
  }
  const nets = new Map<string, { ref: string; num: string }[]>();
  for (const pad of pads) {
    if (pad.net === "") continue;
    const list = nets.get(pad.net) ?? [];
    list.push({ ref: pad.ref, num: pad.num });
    nets.set(pad.net, list);
  }
  return {
    pads,
    nets: [...nets.entries()]
      .map(([name, pins]) => ({ name, pins }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export interface SheetNetlistEntry {
  schematic: string | null;
  sheet: string;
  file: string;
  netlist: SheetNetlist;
}

export interface PcbNetlistEntry {
  pcb: string;
  file: string;
  netlist: PcbNetlist;
}

export interface Eprj3ProjectNetlist {
  project: { name: string; dir: string };
  perSheet: SheetNetlistEntry[];
  pcb: PcbNetlistEntry[];
  warnings: string[];
}

/** 整个工程的网表：逐页原理图 + 逐 PCB。 */
export function netlistProject(dir: string): Eprj3ProjectNetlist {
  const project: Eprj3Project = loadEprj3Project(dir);
  const warnings: string[] = [];
  const perSheet: SheetNetlistEntry[] = [];
  for (const sheet of Object.values(project.profile.sheets)) {
    const file = sheetFile(project, sheet);
    if (file === null || !existsSync(file)) {
      warnings.push(`页 ${typeof sheet.title === "string" ? sheet.title : "?"} 的文件缺失`);
      continue;
    }
    const schematicUuid = typeof sheet.schematic_uuid === "string" ? sheet.schematic_uuid : "";
    const schematic = project.profile.schematics[schematicUuid];
    perSheet.push({
      schematic:
        schematic !== undefined && typeof schematic.name === "string" ? schematic.name : null,
      sheet: typeof sheet.title === "string" ? sheet.title : "?",
      file,
      netlist: sheetNetlist(file),
    });
  }
  const pcb: PcbNetlistEntry[] = [];
  for (const entry of Object.values(project.profile.pcbs)) {
    const file = pcbFile(project, entry);
    if (file === null || !existsSync(file)) {
      warnings.push(`PCB ${typeof entry.title === "string" ? entry.title : "?"} 的文件缺失`);
      continue;
    }
    pcb.push({
      pcb: typeof entry.title === "string" ? entry.title : "?",
      file,
      netlist: pcbNetlist(file),
    });
  }
  return {
    project: { name: project.name, dir: path.resolve(project.rootDir) },
    perSheet,
    pcb,
    warnings,
  };
}
