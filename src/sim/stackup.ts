/**
 * 叠层模型 + 传输线 / 过孔参数解析估计
 * （源仓库 scripts/stackup.py + trace_extract.py + via_extract.py）。
 *
 * 设计原则：
 *   - PCB 文件缺叠层时**禁止**默认为 FR4 εr=4.5 后静默继续 → 必须报
 *     `STACKUP_INCOMPLETE`，并允许用户用 stackup.json 补齐/覆盖；
 *   - 估计结果一律标 `ANALYTIC_ESTIMATE` / `ENGINEERING_ESTIMATE`，
 *     不得宣称 field-solver 精度。
 *
 * 公式来源：Hammerstad-Jensen 微带线近似 + IPC-2141 带状线近似，都是工程通用的
 * 解析式，误差量级 ±10%（在 w/h 与 εr 常规范围内）。用它们做"量级正确 + 趋势正确"
 * 的寄生估值是合适的，做阻抗控制验收则不行。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type {
  GeometryLike,
  GeometryNet,
  StackupDielectric,
  StackupLayer,
  TraceSegment,
  ViaGeometry,
} from "./types.ts";
import { SimError, asText } from "./types.ts";

/** 1/c = 3.33564 ps/mm（真空）。 */
export const C_PS_PER_MM = 3.33564;
export const TRACE_FIDELITY = "ANALYTIC_ESTIMATE";
export const VIA_FIDELITY = "ENGINEERING_ESTIMATE";
export const DEFAULT_ANTIPAD_CLEARANCE_MM = 0.25;
/** Ω·m */
export const COPPER_RESISTIVITY = 1.72e-8;
/** 孔壁镀铜 25 µm。 */
export const PLATING_THICKNESS_MM = 0.025;

export class StackupError extends SimError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "StackupError";
  }
}

export class ExtractError extends SimError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ExtractError";
  }
}

function toFloat(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

export interface DielectricQuery {
  h_mm: number;
  er: number;
  loss_tangent: number | null;
  model: "microstrip" | "stripline";
}

interface StackupRawLayer {
  name?: string;
  type?: string;
  copper_um?: number | null;
  [key: string]: unknown;
}

interface StackupRawDielectric {
  between?: string[];
  thickness_mm?: number | null;
  er?: number | null;
  loss_tangent?: number | null;
  material?: string | null;
  from_pcb?: boolean;
  _z?: unknown;
  [key: string]: unknown;
}

/**
 * 叠层：layers 是铜层（name / type: signal|plane / copper_um），
 * dielectrics 是层间介质（between: [a, b] / thickness_mm / er / loss_tangent）。
 */
export class Stackup {
  layers: StackupLayer[] = [];
  dielectrics: StackupDielectric[] = [];
  source: string | null = null;
  meta: Record<string, unknown> = {};
  warnings: string[] = [];
  errors: string[] = [];

  constructor(
    options: {
      layers?: StackupRawLayer[];
      dielectrics?: StackupRawDielectric[];
      source?: string | null;
      meta?: Record<string, unknown>;
    } = {},
  ) {
    this.layers = (options.layers ?? []).map((layer) => ({
      copper_um: (layer.copper_um as number | null) ?? null,
      ...layer,
      name: String(layer.name ?? "layer"),
      type: String(layer.type ?? "signal"),
    })) as StackupLayer[];
    this.dielectrics = (options.dielectrics ?? []).map((dielectric) => ({
      between: [...(dielectric.between ?? [])],
      thickness_mm: (dielectric.thickness_mm as number | null) ?? null,
      er: (dielectric.er as number | null) ?? null,
      ...dielectric,
    })) as StackupDielectric[];
    this.source = options.source ?? null;
    this.meta = options.meta ?? {};
  }

  /**
   * 读取用户 stackup.json；给了 base（从 PCB 抽的）就只补缺、不覆盖已有值。
   * 这就是"允许用户补充"：PCB 缺铜厚时用户只写铜厚即可。
   */
  static fromFile(file: string, base?: Stackup | null): Stackup {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      layers?: StackupRawLayer[];
      dielectrics?: StackupRawDielectric[];
    };
    const stackup = new Stackup({
      layers: raw.layers,
      dielectrics: raw.dielectrics,
      source: path.basename(file),
      meta: { file: path.resolve(file) },
    });
    stackup.normalize();
    if (base) stackup.fillFrom(base);
    return stackup;
  }

  /** 用 base 补齐 self 里缺失的字段（同名列 / 同介质对 / 顺序位置）。 */
  fillFrom(base: Stackup): this {
    for (const layer of this.layers) {
      if (layer.copper_um) continue;
      const source = base.layer(layer.name);
      if (source && source.copper_um) {
        layer.copper_um = source.copper_um;
        layer["_filled_from"] = "pcb";
      }
    }
    // 介质：优先按 between 精确匹配，其次按顺序位置
    for (let index = 0; index < this.dielectrics.length; index += 1) {
      const dielectric = this.dielectrics[index]!;
      if (dielectric.thickness_mm && dielectric.er) continue;
      let source = base.findDielectric(dielectric.between ?? []);
      if (!source && index < base.dielectrics.length) source = base.dielectrics[index];
      if (!source) continue;
      if (!dielectric.thickness_mm && source.thickness_mm) {
        dielectric.thickness_mm = source.thickness_mm;
        dielectric["_filled_from"] = "pcb";
      }
      if (!dielectric.er && source.er) {
        dielectric.er = source.er;
        dielectric["_filled_from"] = "pcb";
      }
    }
    // 用户只写了铜厚 + 一层介质时：把 PCB 的介质映射到相邻层对
    if (this.dielectrics.length === 0 && base.dielectrics.length > 0) {
      const pairs = Math.max(this.layers.length - 1, 1);
      for (let index = 0; index < pairs; index += 1) {
        const source = base.dielectrics[Math.min(index, base.dielectrics.length - 1)]!;
        const dielectric: StackupDielectric = { ...source, between: [...(source.between ?? [])] };
        if (index + 1 < this.layers.length) {
          dielectric.between = [this.layers[index]!.name, this.layers[index + 1]!.name];
        }
        dielectric["_filled_from"] = "pcb";
        this.dielectrics.push(dielectric);
      }
    } else if (this.dielectrics.length < this.layers.length - 1 && base.dielectrics.length > 0) {
      for (let index = 0; index < this.layers.length - 1; index += 1) {
        const a = this.layers[index]!.name;
        const b = this.layers[index + 1]!.name;
        if (this.findDielectric([a, b])) continue;
        const source = base.dielectrics[Math.min(index, base.dielectrics.length - 1)]!;
        const dielectric: StackupDielectric = { ...source, between: [a, b] };
        dielectric["_filled_from"] = "pcb";
        this.dielectrics.push(dielectric);
      }
    }
    return this;
  }

  /** 从 PCB 抽出来的部分叠层信息尽力还原；缺什么就记什么。 */
  static fromPcb(
    geoLayers: { name?: string; type?: string }[] | null | undefined,
    stackupRaw:
      | {
          er?: unknown;
          thickness?: unknown;
          loss_tangent?: unknown;
          material?: unknown;
          z?: unknown;
        }[]
      | null
      | undefined,
    boardThicknessMm?: number | null,
  ): Stackup {
    const copper = (geoLayers ?? []).filter((layer) => {
      const type = String(layer.type ?? "").toUpperCase();
      return (
        ["TOP", "BOTTOM", "INNER", "SIGNAL", "PLANE"].includes(type) || type.startsWith("INNER")
      );
    });
    const layers: StackupRawLayer[] = copper.map((layer) => {
      const type = String(layer.type ?? "").toUpperCase();
      return {
        name: String(layer.name ?? "layer"),
        type: ["TOP", "BOTTOM", "SIGNAL"].includes(type) ? "signal" : "plane",
        copper_um: null,
      };
    });
    const dielectrics: StackupRawDielectric[] = [];
    const physical = stackupRaw ?? [];
    for (let index = 0; index < physical.length; index += 1) {
      const layer = physical[index]!;
      const er = toFloat(layer.er);
      const thickness = toFloat(layer.thickness);
      if (er && thickness && thickness > 0) {
        dielectrics.push({
          between: [`layer${index}`, `layer${index + 1}`],
          thickness_mm: thickness,
          er,
          loss_tangent: toFloat(layer.loss_tangent),
          material: layer.material ? asText(layer.material) : null,
          from_pcb: true,
          _z: layer.z,
        });
      }
    }
    const stackup = new Stackup({
      layers,
      dielectrics,
      source: "pcb",
      meta: { board_thickness_mm: boardThicknessMm ?? null },
    });
    stackup.normalize();
    return stackup;
  }

  /** 把 layers 的铜厚与 dielectrics 的 between 对齐；缺项记 null。 */
  normalize(): this {
    for (const layer of this.layers) {
      layer.copper_um = toFloat(layer.copper_um);
      layer.type = String(layer.type ?? "signal").toLowerCase();
      layer.name = layer.name ?? "layer";
    }
    for (const dielectric of this.dielectrics) {
      dielectric.thickness_mm = toFloat(dielectric.thickness_mm);
      dielectric.er = toFloat(dielectric.er);
      dielectric.between = dielectric.between ?? [];
    }
    return this;
  }

  /** 返回缺失项列表；空列表表示可用于 auto-Z0。 */
  validate(needLayers?: readonly string[] | null): string[] {
    const missing: string[] = [];
    if (this.layers.length === 0) missing.push("no copper layers");
    if (this.layers.length < 2) missing.push("need >= 2 copper layers to know layer count");
    if (this.dielectrics.length === 0) missing.push("no dielectric entry (thickness/er)");
    for (const layer of this.layers) {
      if (!layer.copper_um) missing.push(`copper thickness missing on ${layer.name}`);
    }
    for (const dielectric of this.dielectrics) {
      if (!dielectric.thickness_mm) {
        missing.push(
          `dielectric thickness missing between ${(dielectric.between ?? []).join(",")}`,
        );
      }
      if (!dielectric.er) {
        missing.push(`dielectric er missing between ${(dielectric.between ?? []).join(",")}`);
      }
    }
    for (const name of needLayers ?? []) {
      if (!this.layers.some((layer) => layer.name === name)) {
        missing.push(`layer '${name}' not in stackup`);
      }
    }
    return missing;
  }

  requireComplete(needLayers?: readonly string[] | null): true {
    const missing = this.validate(needLayers);
    if (missing.length > 0) {
      throw new StackupError(
        "STACKUP_INCOMPLETE",
        "叠层信息不完整，无法做 auto-Z0；请提供 stackup.json 补齐（不会默认 FR4）：" +
          missing.slice(0, 6).join("; "),
      );
    }
    return true;
  }

  layer(name: string): StackupLayer | null {
    return this.layers.find((layer) => layer.name === name) ?? null;
  }

  layerIndex(name: string): number | null {
    const index = this.layers.findIndex((layer) => layer.name === name);
    return index >= 0 ? index : null;
  }

  /** 该层走线到最近参考平面的距离、εr 与线型。 */
  dielectricFor(layerName: string): DielectricQuery {
    const index = this.layerIndex(layerName);
    if (index === null) {
      throw new StackupError(
        "STACKUP_LAYER_NOT_FOUND",
        `叠层里没有层 ${JSON.stringify(layerName)}`,
      );
    }
    const layer = this.layers[index]!;
    const count = this.layers.length;
    const outer = index === 0 || index === count - 1;
    if (outer) {
      // 微带：单侧参考平面。顶层 → 下方介质；底层 → 上方介质
      const pair =
        index === 0
          ? [layer.name, this.layers[index + 1]!.name]
          : [this.layers[index - 1]!.name, layer.name];
      const dielectric = this.findDielectric(pair);
      if (!dielectric) {
        throw new StackupError(
          "STACKUP_INCOMPLETE",
          `${layerName} 的介质信息缺失（${pair.join(", ")}）`,
        );
      }
      return {
        h_mm: dielectric.thickness_mm ?? 0,
        er: dielectric.er ?? 0,
        loss_tangent: dielectric.loss_tangent ?? null,
        model: "microstrip",
      };
    }
    // 内层：带状线，两侧都是介质 → 总厚度 = 上下介质之和
    const up = this.findDielectric([this.layers[index - 1]!.name, layer.name]);
    const down = this.findDielectric([layer.name, this.layers[index + 1]!.name]);
    if (!up || !down) {
      throw new StackupError(
        "STACKUP_INCOMPLETE",
        `${layerName} 上下介质信息不全，无法按带状线建模`,
      );
    }
    if (Math.abs((up.er ?? 0) - (down.er ?? 0)) > 0.2) {
      this.warnings.push(
        `${layerName} 上下介质 εr 不同（${String(up.er)} vs ${String(down.er)}），带状线取平均`,
      );
    }
    return {
      h_mm: (up.thickness_mm ?? 0) + (down.thickness_mm ?? 0),
      er: ((up.er ?? 0) + (down.er ?? 0)) / 2,
      loss_tangent: up.loss_tangent ?? null,
      model: "stripline",
    };
  }

  findDielectric(pair: readonly string[]): StackupDielectric | null {
    const [a, b] = [pair[0] ?? "", pair[1] ?? ""];
    const wanted = new Set([a, b]);
    for (const dielectric of this.dielectrics) {
      const between = dielectric.between ?? [];
      if (between.length !== 2) continue;
      const actual = new Set([between[0], between[1]]);
      if (actual.size === wanted.size && [...actual].every((name) => wanted.has(name))) {
        return dielectric;
      }
    }
    // from_pcb 的 between 是占位名，按 z 顺序兜底
    if (this.dielectrics.length > 0 && this.source === "pcb") {
      const index = this.layerIndex(a);
      const candidates = this.dielectrics.filter((dielectric) => dielectric._z);
      if (candidates.length > 0 && index !== null) {
        return candidates[Math.min(index, candidates.length - 1)]!;
      }
    }
    return null;
  }

  toDict(): Record<string, unknown> {
    return {
      layers: this.layers,
      dielectrics: this.dielectrics.map((dielectric) =>
        Object.fromEntries(Object.entries(dielectric).filter(([key]) => !key.startsWith("_"))),
      ),
      source: this.source,
      meta: this.meta,
    };
  }
}

// ---------------------------------------------------------------------------
// 传输线参数（解析估计）
// ---------------------------------------------------------------------------

/** Hammerstad-Jensen 微带线：返回 [z0, eps_eff]。 */
export function microstripZ0(wMm: number, hMm: number, tMm: number, er: number): [number, number] {
  if (wMm <= 0 || hMm <= 0) {
    throw new StackupError("TRACE_GEOMETRY_INVALID", `线宽/介质厚度必须 > 0（w=${wMm}, h=${hMm}）`);
  }
  if (er < 1) throw new StackupError("STACKUP_INCOMPLETE", `εr=${er} 不合理`);
  // 有限铜厚修正
  let wEff = wMm;
  if (tMm && tMm > 0) {
    const du = tMm / hMm;
    wEff =
      wMm +
      (tMm / Math.PI) *
        (1 + Math.log((4 * Math.E) / (du ** 2 + (1 / Math.PI) ** 2 * (1 / (du + 1.1)) ** 2)));
  }
  const u = wEff / hMm;
  const epsEff = (er + 1) / 2 + ((er - 1) / 2) * (1 + 12 / u) ** -0.5;
  let z0: number;
  if (u <= 1) {
    z0 = (60 / Math.sqrt(epsEff)) * Math.log(8 / u + u / 4);
  } else {
    z0 = (120 * Math.PI) / (Math.sqrt(epsEff) * (u + 1.393 + 0.667 * Math.log(u + 1.444)));
  }
  return [z0, epsEff];
}

/** IPC-2141 带状线（b = 两参考平面间距）：返回 [z0, eps_eff = er]。 */
export function striplineZ0(wMm: number, bMm: number, tMm: number, er: number): [number, number] {
  if (wMm <= 0 || bMm <= 0) {
    throw new StackupError("TRACE_GEOMETRY_INVALID", `线宽/板厚必须 > 0（w=${wMm}, b=${bMm}）`);
  }
  const t = tMm || 0;
  let z0: number;
  if (t <= 0) {
    z0 = (60 / Math.sqrt(er)) * Math.log((4 * bMm) / (0.67 * Math.PI * wMm));
  } else {
    z0 = (60 / Math.sqrt(er)) * Math.log((4 * bMm) / (0.67 * Math.PI * wMm * (0.8 + t / wMm)));
  }
  return [z0, er];
}

export interface TraceParams {
  layer: string;
  width_mm: number;
  h_mm: number;
  er: number;
  copper_um: number | null;
  model: "microstrip" | "stripline";
  z0_ohm: number;
  eps_eff: number;
  td_ps_per_mm: number;
  model_fidelity: string;
  loss_tangent?: number | null;
  length_mm?: number;
  td_ps?: number;
}

/** 给出 (z0, td_ps_per_mm, eps_eff, model)；length 给了就顺带算 td_ps。 */
export function traceParams(
  stackup: Stackup,
  layerName: string,
  widthMm: number,
  lengthMm?: number | null,
): TraceParams {
  const dielectric = stackup.dielectricFor(layerName);
  const layer = stackup.layer(layerName);
  const copperUm = (layer?.copper_um as number | null) ?? 0;
  const tMm = copperUm / 1000;
  const [z0, epsEff] =
    dielectric.model === "microstrip"
      ? microstripZ0(widthMm, dielectric.h_mm, tMm, dielectric.er)
      : striplineZ0(widthMm, dielectric.h_mm, tMm, dielectric.er);
  const tdPsPerMm = C_PS_PER_MM * Math.sqrt(epsEff);
  const out: TraceParams = {
    layer: layerName,
    width_mm: round(widthMm, 4),
    h_mm: round(dielectric.h_mm, 4),
    er: dielectric.er,
    copper_um: copperUm || null,
    model: dielectric.model,
    z0_ohm: round(z0, 2),
    eps_eff: round(epsEff, 4),
    td_ps_per_mm: round(tdPsPerMm, 4),
    model_fidelity: TRACE_FIDELITY,
  };
  if (dielectric.loss_tangent) out.loss_tangent = dielectric.loss_tangent;
  if (lengthMm) {
    out.length_mm = round(lengthMm, 4);
    out.td_ps = round(lengthMm * tdPsPerMm, 3);
  }
  return out;
}

export function stackupSummaryLines(trace: TraceParams): string[] {
  return [
    `${trace.layer}  w=${trace.width_mm} mm  h=${trace.h_mm} mm  εr=${trace.er}  (${trace.model})`,
    `Z0 = ${trace.z0_ohm} Ω   εeff = ${trace.eps_eff}   td = ${trace.td_ps_per_mm} ps/mm  [${TRACE_FIDELITY}]`,
  ];
}

// ---------------------------------------------------------------------------
// 走线 → 传输线参数（trace_extract.py）
// ---------------------------------------------------------------------------

export interface TraceOverrides {
  [layerName: string]: { z0?: number; td_ps_per_mm?: number };
}

export interface EstimatedTrace extends Record<string, unknown> {
  z0_ohm: number;
  td_ps_per_mm: number;
  td_ps: number;
  eps_eff: number;
  h_mm: number;
  trace_model: string;
  model_fidelity: string;
}

function widthsOf(width: TraceSegment["width_mm"]): (number | null | undefined)[] {
  return Array.isArray(width) ? width : [width];
}

/** 给一个网络的所有 segment 补上 z0/td。 */
export function estimateNetTrace(
  netName: string,
  geoNet: GeometryNet,
  stackup: Stackup,
  options: { defaultWidthMm?: number | null; overrides?: TraceOverrides } = {},
): [EstimatedTrace[], string[]] {
  const overrides = options.overrides ?? {};
  const out: EstimatedTrace[] = [];
  const warnings: string[] = [];
  const segments = geoNet.segments ?? [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const label = `${netName} seg${index + 1}`;
    let widths = widthsOf(segment.width_mm);
    if (widths.length === 0 || widths[0] === null || widths[0] === undefined || widths[0] === 0) {
      if (options.defaultWidthMm) {
        widths = [options.defaultWidthMm];
        warnings.push(`${label}: 走线宽度缺失，按 ${options.defaultWidthMm} mm 兜底`);
      } else {
        throw new ExtractError("TRACE_WIDTH_MISSING", `${label}: 走线宽度为 0/缺失，无法估 Z0`);
      }
    }
    if (widths.length > 1) {
      warnings.push(
        `${label}: 段内混有多种线宽 [${widths.join(", ")}]，按最宽估计（如需精度请拆分该段）`,
      );
    }
    const width = Math.max(...widths.map((value) => Number(value)));
    const record: Record<string, unknown> = { ...segment, segment_index: index + 1 };
    let trace: TraceParams;
    try {
      trace = traceParams(stackup, segment.layer, width, segment.length_mm ?? null);
    } catch (error) {
      if (error instanceof StackupError) {
        throw new ExtractError(error.code, `${label}: ${error.message}`);
      }
      throw error;
    }
    const length = segment.length_mm ?? 0;
    record["z0_ohm"] = trace.z0_ohm;
    record["td_ps_per_mm"] = trace.td_ps_per_mm;
    record["td_ps"] = trace.td_ps ?? round(length * trace.td_ps_per_mm, 3);
    record["eps_eff"] = trace.eps_eff;
    record["h_mm"] = trace.h_mm;
    record["trace_model"] = trace.model;
    record["model_fidelity"] = TRACE_FIDELITY;
    const override = overrides[segment.layer] ?? {};
    if (override.z0 !== undefined) {
      warnings.push(`${label}: Z0 被用户覆盖 ${trace.z0_ohm} → ${override.z0}`);
      record["z0_ohm"] = override.z0;
      record["model_fidelity"] = "USER_OVERRIDE";
    }
    if (override.td_ps_per_mm !== undefined) {
      record["td_ps_per_mm"] = override.td_ps_per_mm;
      record["td_ps"] = round(length * override.td_ps_per_mm, 3);
      record["model_fidelity"] = "USER_OVERRIDE";
    }
    out.push(record as EstimatedTrace);
  }
  return [out, warnings];
}

/** 整个 PCB_GEOMETRY → 带 Z0/TD 的副本（不改原对象）。 */
export function estimateGeometryTrace(
  geo: GeometryLike,
  stackup: Stackup,
  options: { nets?: string[]; defaultWidthMm?: number | null; overrides?: TraceOverrides } = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(geo)) {
    if (key !== "nets") result[key] = value;
  }
  const nets: Record<string, unknown> = {};
  result["nets"] = nets;
  const warnings = [...(geo.warnings ?? [])];
  result["warnings"] = warnings;
  const targets = options.nets ?? Object.keys(geo.nets ?? {});
  for (const name of targets) {
    const net = geo.nets?.[name];
    if (!net) continue;
    const [segments, warns] = estimateNetTrace(name, net, stackup, {
      defaultWidthMm: options.defaultWidthMm,
      overrides: options.overrides,
    });
    nets[name] = { ...net, segments };
    warnings.push(...warns);
  }
  result["stackup"] = stackup.toDict();
  return result;
}

export function traceSummaryLine(segment: Record<string, unknown>): string {
  const number = (value: unknown): string => asText(value, "0");
  return (
    `${number(segment["from"])} → ${number(segment["to"])} (${number(segment["layer"])}) ` +
    `${number(segment["length_mm"])} mm  Z0=${number(segment["z0_ohm"])} Ω  ` +
    `TD=${number(segment["td_ps"])} ps  w=${number(segment["width_mm"])} mm ` +
    `[${number(segment["model_fidelity"])}]`
  );
}

// ---------------------------------------------------------------------------
// 过孔寄生 R/L/C 估计（via_extract.py）
// ---------------------------------------------------------------------------
//
// L(nH) = 0.2·h·[ln(4h/d)+1]         h = 过孔长度(mm)，d = 钻孔直径(mm)
// C(pF) = 0.0555·εr·T·D1/(D2−D1)     T = 板厚(mm)，D1 = 焊盘，D2 = 反焊盘
// R(Ω)  = ρ·h/(π·d·t_plating)        孔壁镀铜直流电阻

function erBetween(stackup: Stackup | null | undefined): number {
  if (stackup && stackup.dielectrics.length > 0) {
    const values = stackup.dielectrics
      .map((dielectric) => dielectric.er)
      .filter((value): value is number => Boolean(value));
    if (values.length > 0) return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  throw new ExtractError("STACKUP_INCOMPLETE", "过孔电容需要 εr：叠层里没有介电常数，请补 stackup");
}

function viaLength(
  via: ViaGeometry,
  stackup: Stackup | null | undefined,
  boardThicknessMm?: number | null,
): number {
  if (via.length_mm) return Number(via.length_mm);
  if (boardThicknessMm) return Number(boardThicknessMm);
  if (stackup) {
    let total = stackup.dielectrics.reduce(
      (sum, dielectric) => sum + (dielectric.thickness_mm ?? 0),
      0,
    );
    total += stackup.layers.reduce((sum, layer) => sum + (layer.copper_um ?? 0) / 1000, 0);
    if (total > 0) return total;
  }
  throw new ExtractError(
    "VIA_LENGTH_UNKNOWN",
    "过孔长度未知：请给 board_thickness_mm，或提供完整 stackup（按介质+铜厚求和）",
  );
}

export interface ViaParasitics extends Record<string, unknown> {
  id: string | undefined;
  length_mm: number;
  drill_mm: number;
  pad_mm: number;
  antipad_mm: number;
  er: number;
  r_ohm: number;
  l_nh: number;
  c_pf: number;
  model_fidelity: string;
}

export function viaParasitics(
  via: ViaGeometry,
  stackup?: Stackup | null,
  options: {
    boardThicknessMm?: number | null;
    antipadClearanceMm?: number | null;
    platingMm?: number;
  } = {},
): ViaParasitics {
  const h = viaLength(via, stackup, options.boardThicknessMm);
  const d = Number(via.drill_mm ?? 0) || 0.3;
  const d1 = Number(via.pad_mm ?? 0) || d + 0.25;
  const clearance =
    options.antipadClearanceMm === undefined || options.antipadClearanceMm === null
      ? DEFAULT_ANTIPAD_CLEARANCE_MM
      : Number(options.antipadClearanceMm);
  const d2 = d1 + 2 * clearance;
  const er = erBetween(stackup);
  const plating = options.platingMm ?? PLATING_THICKNESS_MM;
  if (d <= 0 || h <= 0) {
    throw new ExtractError(
      "VIA_GEOMETRY_INVALID",
      `过孔 ${via.id ?? ""}: 孔径/长度非法（h=${h}, d=${d}）`,
    );
  }
  const lNh = 0.2 * h * (Math.log((4 * h) / d) + 1.0);
  const cPf = (0.0555 * er * h * d1) / Math.max(d2 - d1, 1e-6);
  const rOhm = (COPPER_RESISTIVITY * (h * 1e-3)) / (Math.PI * (d * 1e-3) * (plating * 1e-3));
  return {
    id: via.id,
    length_mm: round(h, 4),
    drill_mm: round(d, 4),
    pad_mm: round(d1, 4),
    antipad_mm: round(d2, 4),
    er: round(er, 3),
    r_ohm: round(rOhm, 6),
    l_nh: round(lNh, 4),
    c_pf: round(cPf, 4),
    model_fidelity: VIA_FIDELITY,
    assumptions: {
      antipad_clearance_mm: clearance,
      plating_mm: plating,
      note: "反焊盘尺寸 PCB 文件里没有，按焊盘+间隙估计；如需精度请 override",
    },
  };
}

export function estimateVias(
  geoNet: GeometryNet,
  stackup?: Stackup | null,
  boardThicknessMm?: number | null,
): [ViaParasitics[], string[]] {
  const out: ViaParasitics[] = [];
  const warnings: string[] = [];
  for (const via of geoNet.vias ?? []) {
    let parasitics: ViaParasitics;
    try {
      parasitics = viaParasitics(via, stackup, { boardThicknessMm });
    } catch (error) {
      if (!(error instanceof ExtractError)) throw error;
      warnings.push(`${error.code}: ${error.message}`);
      continue;
    }
    parasitics["nodes"] = via.nodes ?? [];
    out.push(parasitics);
  }
  return [out, warnings];
}

export function viaSummaryLine(via: ViaParasitics): string {
  return (
    `${via.id ?? ""}: L=${via.l_nh} nH C=${via.c_pf} pF ` +
    `R=${via.r_ohm * 1e3} mΩ [${via.model_fidelity}]`
  );
}

/** 判断叠层文件是否存在（CLI/工具里给出更友好的错误）。 */
export function stackupFileExists(file: string): boolean {
  return existsSync(file);
}
