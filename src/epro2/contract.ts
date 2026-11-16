/**
 * `.epro2` 解析产物的类型契约。
 *
 * 这些类型对应 references/output-contract.md 里的稳定字段：字段只增不改，
 * 单位与坐标口径保持不变。下游（ngspice 仿真、eprj3 导出）只依赖这里声明的字段。
 */

/** 一个文档段的归约结果。`elems` 的键由 records.ts 的 makeRecordKey 生成。 */
export interface RecordEntry {
  ticket: number;
  payload: unknown;
}

export interface ParsedDoc {
  docType: string | null;
  uuid: string | null;
  editVersion: unknown;
  title: string;
  elems: Map<string, RecordEntry>;
}

/** 原理图侧引脚 → 网络名。键由 pinKey() 生成，值为 `N$n` 或显式网络名。 */
export type PinNetMap = Map<string, string>;

/** 跨页同位号落到不同网络时的候选网络名。 */
export type AmbiguousMap = Map<string, string[]>;

export interface PageInfo {
  uuid: string | null;
  name: string;
  docType: string | null;
  /** 同名页去重后的展示标签：P1、P1#2 … 只在分析产物里出现。 */
  label?: string;
}

export interface IrPin {
  number: string | null;
  name: string | null;
  /** 已做 y 轴翻转的绝对坐标。 */
  x: number;
  y: number;
}

export interface IrComponent {
  id: string;
  componentType: string;
  designator: string | null;
  deviceUuid: string | null;
  deviceTitle: string | null;
  manufacturerPart: string | null;
  value: string | null;
  x: number;
  y: number;
  rotation: number | string;
  mirror: boolean;
  pins: IrPin[];
  attrs: Record<string, unknown>;
  /** 仅 netflag / netport 元件：该符号代表的网络名。 */
  net?: string | null;
}

export interface IrWire {
  id: string;
  line: [number, number, number, number];
  net: string;
}

export interface NetPin {
  designator: string | null;
  pinNumber: string | null;
  pinName: string | null;
  componentType: string | null;
}

export interface SchematicNet {
  name: string;
  named: boolean;
  conflicts: string[];
  pins: NetPin[];
}

export interface SchematicIr {
  project: string | null;
  page: PageInfo;
  components: IrComponent[];
  wires: IrWire[];
  nets: SchematicNet[];
  warnings: string[];
}

export interface OutlineBox {
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
  width_mil: number;
  height_mil: number;
  width_mm: number;
  height_mm: number;
}

export interface OutlineEntry extends OutlineBox {
  doc: string | null;
}

export interface OutlineUnion extends OutlineBox {
  boards: number;
}

export interface PcbLayer {
  id: unknown;
  type: string | null;
  name: string | null;
}

export interface StackupEntry {
  id: unknown;
  raw: Record<string, unknown>;
}

export interface PcbSegment {
  net: string;
  layer_id: unknown;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: unknown;
}

export interface PcbTraceSummary {
  net: string;
  segments: number;
  length_mil: number;
  width_mil_mode: string | null;
  length_mm: number;
}

export interface PcbVia {
  net: string;
  x: unknown;
  y: unknown;
  hole: unknown;
  diameter: unknown;
  type: unknown;
}

export interface PcbPad {
  component: string;
  pin: string;
  net: string;
  x: number;
  y: number;
  layer_id: number;
  w: unknown;
  h: unknown;
}

export interface PcbGeometry {
  unit: "mil";
  outline: OutlineUnion | null;
  outlines: OutlineEntry[];
  layers: PcbLayer[];
  stackup: StackupEntry[];
  traces: PcbTraceSummary[];
  segments: PcbSegment[];
  vias: PcbVia[];
  pads: PcbPad[];
  warnings: string[];
  via_hole_histogram?: Record<string, number>;
  copper_layers_used?: number;
  copper_layers_declared?: number;
  segment_count?: number;
  pad_count?: number;
}

export interface PcbRow {
  designator: string;
  component: string;
  pad: string;
  pinNumber: string | null;
  pinName: string | null;
  net: string;
  ticket: number;
}

export interface MetaDocument {
  docType: string | null;
  uuid: string | null;
  title: string | null;
}

export interface MetaPage {
  uuid: string | null;
  name: string;
  docType: string | null;
}

export interface ArtifactMeta {
  project: string;
  source: string;
  epru: string;
  record_lines: number;
  record_unparsed: number;
  project_meta: Record<string, unknown>;
  documents: MetaDocument[];
  library: { symbols: number; devices: number; footprints: number };
  pages: MetaPage[];
  pages_analyzed: string[];
  pages_analyzed_uuids: (string | null)[];
}

export interface ConsistencyStats {
  compared: number;
  mismatch: number;
  skipped_unnamed: number;
  ambiguous: number;
  duplicate_designators: number;
  duplicate_pin_keys: number;
  duplicate_pin_conflicts: number;
  multi_page: number;
  pcb_rows: number;
  schematic_nets: number;
}

export interface Mismatch {
  designator: string;
  pin: string | null;
  schematic: string;
  pcb: string;
}

export interface FloatingNet {
  net: string;
  page: string;
  pins: NetPin[];
}

export interface Artifacts {
  meta: ArtifactMeta;
  pages_ir: SchematicIr[];
  pin_net: PinNetMap;
  ambiguous: AmbiguousMap;
  multi_page_designators: Record<string, string[]>;
  pcb_rows: PcbRow[];
  pcb_warnings: string[];
  geometry: PcbGeometry;
}

export interface NetsDump {
  pages: { page: PageInfo; nets: SchematicNet[] }[];
}

export interface DiffRecordChange {
  key: string;
  type: string;
  payload?: unknown;
  before?: unknown;
  after?: unknown;
}

export interface DiffRecordResult {
  records_old: number;
  records_new: number;
  added: DiffRecordChange[];
  removed: DiffRecordChange[];
  changed: DiffRecordChange[];
  noise_filtered: number;
}

export interface DiffNetlistChange {
  designator: string;
  pad: string;
  fields: string[];
  before: string;
  after: string;
  pin_before: { number: string | null; name: string | null };
  pin_after: { number: string | null; name: string | null };
}

export interface DiffNetlistResult {
  added: PcbRow[];
  removed: PcbRow[];
  changed: DiffNetlistChange[];
}

export interface DiffResult {
  old: { path: string; records: number };
  new: { path: string; records: number };
  elements: DiffRecordResult;
  netlist: DiffNetlistResult;
  netlist_rows: { old: number; new: number };
}
