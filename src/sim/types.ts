/**
 * ngspice 仿真模块的公共类型。
 *
 * 字段口径来自源仓库 leonskill-easyeda-ngspice-sim 的 ir_common.py / netlist_gen.py /
 * metrics.py / parse_raw.py / sim_manifest.py，JSON 键名保持 snake_case，
 * 这样同一份 sim_config.json / ir.json / 报告可以直接在 Python 与 TS 之间互换。
 */

/** 领域内可预期的失败：带机器可读的 code，CLI / MCP 用它决定退出码与错误码。 */
export class SimError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SimError";
    this.code = code;
    this.details = details;
  }
}

/** 把 unknown 转成文本：字符串原样，数值/布尔 String()，其余走 JSON（避免 [object Object]）。 */
export function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null || value === undefined) return fallback;
  if (typeof value === "symbol") return value.description ?? fallback;
  if (typeof value === "object") return JSON.stringify(value) ?? fallback;
  return fallback;
}

// ---------------------------------------------------------------------------
// IR（中间表示）
// ---------------------------------------------------------------------------

export interface SimIrPin {
  /** 引脚号，统一存字符串。 */
  number: string | null;
  name: string | null;
  x?: number;
  y?: number;
  /** bridge 提取时会直接带网络名；离线解析时由 nets 反查。 */
  net?: string | null;
}

export interface SimIrComponent {
  id?: string | null;
  componentType: string;
  designator: string | null;
  name?: string | null;
  deviceUuid?: string | null;
  deviceTitle?: string | null;
  manufacturerPart?: string | null;
  value?: string | null;
  x?: number;
  y?: number;
  rotation?: number | string;
  mirror?: boolean;
  /** 位号字母前缀（R / C / U / DA …），由 normalizeIr 从 designator 推出来。 */
  pinPrefix?: string | null;
  pins: SimIrPin[];
  attrs?: Record<string, unknown>;
  /** 仅 netflag / netport：该符号代表的网络名。 */
  net?: string | null;
}

export interface SimIrWire {
  id?: string | null;
  line: number[];
  net?: string;
}

export interface SimIrNetMember {
  component: string;
  pin: string;
  pinName?: string | null;
}

export interface SimIrNet {
  name: string;
  /** netflag = 网络名来自电源/地网标；wire = 导线上的显式名；auto = 自动编号。 */
  origin?: string;
  named?: boolean;
  conflicts?: string[];
  members: SimIrNetMember[];
  pinCount?: number;
}

export interface SimIrPage {
  uuid?: string | null;
  name?: string;
  docType?: string | null;
  [key: string]: unknown;
}

export interface SimIr {
  version: number;
  source: string | null;
  project: string | null;
  page: SimIrPage;
  components: SimIrComponent[];
  wires: SimIrWire[];
  lines: unknown[];
  nets: SimIrNet[];
  warnings: string[];
  /** 多页时 ir_from_analysis.py 会把它挂在 `_pages` 上。 */
  _pages?: { uuid: string | null; name: string; docType: string | null }[];
}

/** 位号 → 引脚号 → 网络名。netlist_gen.py 的 pin_net 参数就是这个形状。 */
export type PinNetTable = Record<string, Record<string, string>>;

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface ExternalSupply {
  net?: string;
  node?: string;
  voltage?: number | string;
  v?: number | string;
}

/** sim_config.json 的形态（键名与 Python 版一致）。 */
export interface SimConfig {
  power_policy: string;
  strict: boolean;
  allow_partial_model: boolean;
  behavioral: boolean;
  max_cases: number;
  ground_aliases: Record<string, string | string[]> | null;
  models: string | null;
  behavioral_models: string | null;
  override: string | null;
  external_supplies: ExternalSupply[];
  analysis: Record<string, unknown>;
  metrics: MetricSpec[];
  sweep: unknown;
  ibis?: unknown;
  fidelity_labels?: Record<string, string>;
  ngspice_bin?: string;
  python?: string;
  f_start?: number | string;
  f_stop?: number | string;
  ppd?: number;
  /** config 所在目录，加载时写入。 */
  _dir: string;
  _path: string | null;
  [key: string]: unknown;
}

export interface MetricSpec {
  name?: string;
  metric?: string;
  node?: string;
  var?: string;
  a?: string;
  b?: string;
  threshold?: number;
  cluster_gap?: number;
  t0?: number;
  t1?: number;
  v_low?: number;
  v_high?: number;
  amplitude?: number;
  at?: number[];
  f0?: number;
  n?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// raw / 指标
// ---------------------------------------------------------------------------

/** 实数点是 number；AC（complex）点里每个值连同 X 轴都是 [re, im]。 */
export type RawValue = number | [number, number];

export interface RawPlot {
  title: string;
  plotname: string;
  flags: string;
  n_vars: number;
  n_points: number;
  vars: string[];
  points: RawValue[][];
}

export interface MetricErrorEntry {
  metric: string;
  code: string;
  message: string;
}

export interface MetricResult {
  metrics: Record<string, Record<string, unknown>>;
  errors: MetricErrorEntry[];
}

// ---------------------------------------------------------------------------
// 网表报告
// ---------------------------------------------------------------------------

export interface NetlistReportError {
  code: string;
  message: string;
  designator?: string;
  net?: string;
  [key: string]: unknown;
}

export interface NetlistReport {
  version: string;
  included: Record<string, unknown>[];
  excluded: Record<string, unknown>[];
  generic: Record<string, unknown>[];
  powers: Record<string, unknown>[];
  dangling_nets: string[];
  warnings: string[];
  errors: NetlistReportError[];
  models: Record<string, unknown>[];
  behavioral: Record<string, unknown>[];
  ibis: Record<string, unknown>[];
  overrides: Record<string, unknown>[];
  ground_mapping: Record<string, string>;
  ground_lines?: string[];
  net_segments: Record<string, unknown>[];
  virtual_nodes: string[];
  power_policy: string;
  strict: boolean;
  fidelity: FidelityTable;
  includes: string[];
  ground_link_found?: boolean;
  counts?: Record<string, number>;
}

export interface FidelityTable {
  blocks: Record<string, { level: number; what: string; designator: string | null }>;
  overall_level: number;
}

// ---------------------------------------------------------------------------
// 运行产物
// ---------------------------------------------------------------------------

export interface SimRawFile {
  /** 相对 workDir 的文件名。 */
  name: string;
  path: string;
  csv: string | null;
  plots: { plotname: string; vars: string[]; n_points: number }[];
  error?: string;
}

export interface SimRunRecord {
  id: string;
  index: number;
  params: Record<string, unknown>;
  returncode: number;
  dir: string;
  raw: string[];
  metrics: Record<string, unknown>;
  metric_errors: MetricErrorEntry[];
  raw_errors?: string[];
}

export interface SimManifest {
  source_project: string | null;
  source_hash: string | null;
  skill_version: string;
  ngspice_version: string | null;
  analysis: Record<string, unknown>;
  workdir: string | null;
  models: Record<string, unknown>[];
  behavioral_models: Record<string, unknown>[];
  excluded_components: Record<string, unknown>[];
  ground_mapping: Record<string, string>;
  power_sources: Record<string, unknown>[];
  overrides: Record<string, unknown>[];
  net_segments: Record<string, unknown>[];
  virtual_nodes: string[];
  includes: string[];
  fidelity: FidelityTable | Record<string, unknown>;
  power_policy: string | undefined;
  strict: boolean | undefined;
  warnings: string[];
  errors: Record<string, unknown>[];
  runs: SimRunRecord[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 叠层 / 传输线 / 过孔
// ---------------------------------------------------------------------------

export interface StackupLayer {
  name: string;
  type: string;
  copper_um: number | null;
  _filled_from?: string;
  [key: string]: unknown;
}

export interface StackupDielectric {
  between: string[];
  thickness_mm: number | null;
  er: number | null;
  loss_tangent?: number | null;
  material?: string | null;
  from_pcb?: boolean;
  _filled_from?: string;
  _z?: unknown;
  [key: string]: unknown;
}

/** PCB_GEOMETRY 产物里一段走线的形状（由 pcb_geometry.py 生成）。 */
export interface TraceSegment {
  layer: string;
  width_mm: number | number[] | null;
  length_mm?: number;
  from?: string;
  to?: string;
  [key: string]: unknown;
}

export interface ViaGeometry {
  id?: string;
  drill_mm?: number;
  pad_mm?: number;
  length_mm?: number;
  nodes?: string[];
  [key: string]: unknown;
}

export interface GeometryNet {
  segments?: TraceSegment[];
  vias?: ViaGeometry[];
  [key: string]: unknown;
}

export interface GeometryLike {
  nets?: Record<string, GeometryNet>;
  warnings?: string[];
  [key: string]: unknown;
}
