/**
 * IR（中间表示）：把 `.epro2` 原理图解析产物转成本模块的 IR
 * （源仓库 scripts/ir_common.py + scripts/ir_from_analysis.py）。
 *
 * 两个 skill 的 IR 字段本来就很接近（components / pins 绝对坐标 / wires / page），
 * 这里只做字段补齐，**不重新解释 .epru 记录**——那是 src/epro2 的职责。
 */
import { readFileSync, writeFileSync } from "node:fs";

import { collect } from "../epro2/analyze.ts";
import type { SchematicIr } from "../epro2/contract.ts";
import type {
  PinNetTable,
  SimIr,
  SimIrComponent,
  SimIrNet,
  SimIrNetMember,
  SimIrPage,
  SimIrPin,
  SimIrWire,
} from "./types.ts";
import { SimError, asText } from "./types.ts";

export const IR_VERSION = 1;

/** 坐标归一化：消除浮点噪声（324.99999999 -> 325）。 */
export function roundCoord(value: unknown, digits = 2): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(digits));
}

/** 清洗元件值：删 Ω/欧姆符号、µ→u、统一空白。 */
export function cleanValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = asText(value)
    .trim()
    .replace(/Ω/g, "")
    .replace(/欧/g, "")
    .replace(/[µμ]/g, "u")
    .replace(/\s+/g, "");
  return text;
}

export function newSimIr(
  source: string,
  project: string | null = null,
  page: SimIrPage | null = null,
): SimIr {
  return {
    version: IR_VERSION,
    source,
    project,
    page: page ?? {},
    components: [],
    wires: [],
    lines: [],
    nets: [],
    warnings: [],
  };
}

function designatorPrefix(designator: string | null | undefined): string | null {
  const match = /^[A-Za-z]+/.exec((designator ?? "").trim());
  return match ? match[0] : null;
}

/**
 * 统一归一化：坐标 round、值清洗、补 pinPrefix。
 * 对已经是本模块形状的 IR 是幂等的，因此可安全用于 loadSimIr 之后。
 */
export function normalizeIr(ir: SimIr): SimIr {
  for (const comp of ir.components ?? []) {
    comp.x = roundCoord(comp.x) ?? 0;
    comp.y = roundCoord(comp.y) ?? 0;
    if (comp.value) comp.value = cleanValue(comp.value);
    comp.pins = comp.pins ?? [];
    for (const pin of comp.pins) {
      if (pin.x !== undefined) pin.x = roundCoord(pin.x) ?? 0;
      if (pin.y !== undefined) pin.y = roundCoord(pin.y) ?? 0;
      if (pin.number !== null && pin.number !== undefined) pin.number = String(pin.number);
    }
    comp.pinPrefix = designatorPrefix(comp.designator);
  }
  for (const wire of ir.wires ?? []) {
    wire.line = (wire.line ?? []).map((value) => roundCoord(value) ?? 0);
  }
  ir.nets = ir.nets ?? [];
  ir.warnings = ir.warnings ?? [];
  ir.lines = ir.lines ?? [];
  return ir;
}

const NETFLAG_TYPES = new Set(["netflag", "netport"]);

/** `.epro2` 的原理图 IR → 本模块 IR（字段补齐，不重新解释记录流）。 */
export function fromSchematicIr(schematic: SchematicIr): SimIr {
  const page = (schematic.page ?? {}) as unknown as SimIrPage;
  const ir = newSimIr("analysis", schematic.project ?? null, page);
  for (const source of schematic.components ?? []) {
    const attrs = source.attrs ?? {};
    const component: SimIrComponent = {
      id: source.id,
      componentType: source.componentType,
      designator: source.designator,
      name:
        source.deviceTitle ?? (typeof attrs["Name"] === "string" ? attrs["Name"] : null) ?? null,
      deviceUuid: source.deviceUuid ?? null,
      deviceTitle: source.deviceTitle ?? null,
      manufacturerPart: source.manufacturerPart ?? null,
      value: cleanValue(source.value),
      x: roundCoord(source.x) ?? 0,
      y: roundCoord(source.y) ?? 0,
      rotation: source.rotation ?? 0,
      mirror: Boolean(source.mirror),
      pinPrefix: designatorPrefix(source.designator),
      pins: (source.pins ?? []).map((pin): SimIrPin => ({
        number: pin.number === null || pin.number === undefined ? null : String(pin.number),
        name: pin.name ?? null,
        x: roundCoord(pin.x) ?? 0,
        y: roundCoord(pin.y) ?? 0,
      })),
      attrs: { ...attrs },
    };
    if (NETFLAG_TYPES.has(source.componentType)) component.net = source.net ?? null;
    ir.components.push(component);
  }
  for (const source of schematic.wires ?? []) {
    ir.wires.push({
      id: source.id,
      line: (source.line ?? []).map((value) => roundCoord(value) ?? 0),
      net: source.net ?? "",
    } satisfies SimIrWire);
  }
  for (const net of schematic.nets ?? []) {
    const members: SimIrNetMember[] = [];
    let hasNetflag = false;
    for (const pin of net.pins ?? []) {
      if (pin.componentType && NETFLAG_TYPES.has(pin.componentType)) hasNetflag = true;
      if (!pin.designator) continue;
      members.push({
        component: pin.designator,
        pin: pin.pinNumber === null || pin.pinNumber === undefined ? "" : String(pin.pinNumber),
        pinName: pin.pinName ?? null,
      });
    }
    const powerName = /^[+-]/.test(net.name);
    ir.nets.push({
      name: net.name,
      origin: hasNetflag || powerName ? "netflag" : net.named ? "wire" : "auto",
      named: net.named,
      conflicts: net.conflicts ?? [],
      members,
      pinCount: (net.pins ?? []).length,
    } satisfies SimIrNet);
  }
  ir.warnings.push(...(schematic.warnings ?? []));
  return normalizeIr(ir);
}

export interface Epro2SimIrResult {
  ir: SimIr;
  /** 工程里所有原理图页（供 CLI/MCP 提示可用页名）。 */
  pages: { uuid: string | null; name: string; docType: string | null; label?: string }[];
}

/**
 * 从 `.epro2` 生成 IR。`page` 可传页名或 uuid；不传取第一页原理图。
 * 解析失败按 ProjectError 抛出（调用方统一映射成 EPRO2_PROJECT_ERROR）。
 */
export function fromEpro2File(file: string, page?: string | null): Epro2SimIrResult {
  const collected = collect(file, page ?? null);
  const first = collected.artifacts.pages_ir[0];
  if (!first) {
    throw new SimError("SIM_IR_EMPTY", `工程 ${file} 里没有可用的原理图页`);
  }
  const pages = collected.artifacts.pages_ir.map((item) => ({
    uuid: item.page.uuid,
    name: item.page.name,
    docType: item.page.docType,
    label: item.page.label,
  }));
  return { ir: fromSchematicIr(first), pages };
}

/** 读取 IR JSON（兼容 bridge 的 {result: "<json>"} 包裹）。 */
export function loadSimIr(file: string): SimIr {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  let data: unknown = parsed;
  if (data && typeof data === "object" && !Array.isArray(data) && "result" in data) {
    const wrapped = (data as { result?: unknown }).result;
    if (typeof wrapped === "string") data = JSON.parse(wrapped);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new SimError("SIM_IR_INVALID", `IR 文件不是 JSON 对象: ${file}`);
  }
  const ir = data as SimIr;
  ir.version = typeof ir.version === "number" ? ir.version : IR_VERSION;
  ir.source = ir.source ?? null;
  ir.project = ir.project ?? null;
  ir.page = (ir.page ?? {}) as SimIrPage;
  ir.components = Array.isArray(ir.components) ? ir.components : [];
  ir.wires = Array.isArray(ir.wires) ? ir.wires : [];
  ir.lines = Array.isArray(ir.lines) ? ir.lines : [];
  ir.nets = Array.isArray(ir.nets) ? ir.nets : [];
  ir.warnings = Array.isArray(ir.warnings) ? ir.warnings : [];
  return normalizeIr(ir);
}

/** 写 IR：与 Python 版一致用 indent=1。 */
export function saveSimIr(ir: SimIr, file: string): string {
  writeFileSync(file, JSON.stringify(ir, null, 1), "utf8");
  return file;
}

/** 基本完整性检查，返回 warning 列表（不抛异常）。 */
export function validateIr(ir: SimIr): string[] {
  const warnings: string[] = [];
  const components = ir.components ?? [];
  const parts = components.filter((comp) => comp.componentType === "part");
  if (parts.length === 0) warnings.push("IR 中没有任何 part 元件");
  const pinCount = parts.reduce((sum, comp) => sum + (comp.pins ?? []).length, 0);
  if (parts.length > 0 && pinCount === 0) {
    warnings.push("part 元件均无引脚数据（提取可能失败）");
  }
  if ((ir.wires ?? []).length === 0 && (ir.lines ?? []).length === 0) {
    warnings.push("IR 中没有任何导线/线段（连通性将仅依赖引脚坐标重合）");
  }
  const missing = parts.filter((comp) => !comp.designator);
  if (missing.length > 0) warnings.push(`${missing.length} 个元件缺少位号`);
  return warnings;
}

/** IR 的 nets 成员表 → 位号/引脚 → 网络名（与 netlist.ts 的同名工具等价）。 */
export function pinNetTableOf(ir: SimIr): PinNetTable {
  const table: PinNetTable = {};
  for (const net of ir.nets ?? []) {
    for (const member of net.members ?? []) {
      if (!member?.component) continue;
      const pins = (table[member.component] ??= {});
      pins[String(member.pin)] = net.name;
    }
  }
  return table;
}
