/**
 * 寄生元件构造器：RLC / 无损传输线 / ferrite / 连接器 / 过孔 / 波形文本
 * （源仓库 scripts/parasitics.py）。
 *
 * 所有构造器只做两件事：校验参数、吐出 SPICE 行。节点命名与去重由调用方
 * 通过 NetCtx 提供。
 *
 * 关键实测约束：
 *   - ngspice-47 的无损传输线语法是 `Txxx n1 ref1 n2 ref2 Z0=xx TD=yy`
 *     （`T` 行必须有 4 个节点，参考节点通常是 0）；
 *   - 参数单位走 SPICE 风格后缀（p/n/u/m/k/meg/g/t），但**必须**校验，
 *     否则 45 mm × 6 ps/mm 这种长度推导一旦单位写错就会差三个数量级。
 */
import { Namer } from "./config.ts";
import { SimError, asText } from "./types.ts";

const UNITS: [string, number][] = [
  ["meg", 1e6],
  ["t", 1e12],
  ["g", 1e9],
  ["k", 1e3],
  ["m", 1e-3],
  ["u", 1e-6],
  ["n", 1e-9],
  ["p", 1e-12],
  ["f", 1e-15],
];

/** 允许但忽略的尾缀（单位名，非倍率）。 */
const UNIT_WORDS = ["ohms", "ohm", "f", "h", "s", "v", "a", "r", "w", "hz"];

export class ParasiticError extends SimError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ParasiticError";
  }
}

/**
 * SPICE 风格数值解析："180p"→1.8e-10，"2.2meg"→2.2e6。
 * 与 Python 版一致：`4k7` 这种中间带字母的写法不支持。
 */
export function parseEng(value: unknown, field = "value"): number {
  if (value === null || value === undefined) {
    throw new ParasiticError("PARAM_INVALID", `${field} 缺失`);
  }
  if (typeof value === "boolean") {
    throw new ParasiticError("PARAM_INVALID", `${field} 不是数值: ${asText(value)}`);
  }
  if (typeof value === "number") return value;
  const text = asText(value)
    .trim()
    .replace(/\s+/g, "")
    .replace(/µ|μ/g, "u")
    .replace(/Ω|ω|欧/g, "");
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([A-Za-z]*)$/.exec(text);
  if (!match) {
    throw new ParasiticError("PARAM_INVALID", `${field} 无法解析为数值: ${asText(value)}`);
  }
  const number = Number.parseFloat(match[1] ?? "0");
  let suffix = (match[2] ?? "").toLowerCase();
  let multiplier = 1;
  if (suffix) {
    for (const [name, factor] of UNITS) {
      if (suffix.startsWith(name)) {
        multiplier = factor;
        suffix = suffix.slice(name.length);
        break;
      }
    }
    if (suffix && !UNIT_WORDS.some((word) => suffix.startsWith(word))) {
      throw new ParasiticError("PARAM_INVALID", `${field} 尾缀无法识别: ${asText(value)}`);
    }
  }
  return number * multiplier;
}

/** 浮点 → SPICE 数值文本（避免 1e-10 变成 1.0000000000000001e-10）。 */
export function fmt(x: number, digits = 6): string {
  if (x === 0) return "0";
  if (!Number.isFinite(x)) return String(x);
  return formatSignificant(x, digits);
}

/** Python `f"{x:.{n}g}"` 的等价实现（n 位有效数字、去掉多余的 0）。 */
export function formatSignificant(x: number, digits = 6): string {
  if (x === 0) return "0";
  if (!Number.isFinite(x)) return String(x);
  const text = x.toExponential(digits - 1);
  const [mantissaRaw, exponentRaw] = text.split("e");
  const mantissa = (mantissaRaw ?? "0").replace(/\.?0+$/, "");
  const exponent = Number.parseInt(exponentRaw ?? "0", 10);
  if (exponent >= -4 && exponent < digits) {
    return String(Number.parseFloat(x.toPrecision(digits)));
  }
  const sign = exponent < 0 ? "-" : "+";
  const absExponent = Math.abs(exponent);
  return `${mantissa}e${sign}${absExponent < 10 ? "0" : ""}${absExponent}`;
}

export function fmtTime(sec: number): string {
  return fmt(sec);
}

/**
 * 长度 × 皮秒/毫米 → 秒，同时返回推导文本（报告必须同时显示）。
 * TD = l × t_pd  [mm] × [ps/mm] = [ps]
 */
export function tdFromLength(lengthMm: unknown, velocityPsPerMm: unknown): [number, string[]] {
  const length = parseEng(lengthMm, "length_mm");
  const velocity = parseEng(velocityPsPerMm, "velocity_ps_per_mm");
  if (length <= 0) {
    throw new ParasiticError("TL_PARAM_INVALID", `length_mm 必须 > 0，收到 ${asText(lengthMm)}`);
  }
  if (velocity <= 0) {
    throw new ParasiticError(
      "TL_PARAM_INVALID",
      `velocity_ps_per_mm 必须 > 0，收到 ${asText(velocityPsPerMm)}` +
        "（注意单位是 ps/mm，不是 mm/ps 或 m/s）",
    );
  }
  const tdPs = length * velocity;
  // 物理合理性护栏：1 mm 线路不可能达到 1 ns 以上（≈0.3c 也只是 3.3 ps/mm）。
  if (velocity > 20) {
    throw new ParasiticError(
      "TL_PARAM_INVALID",
      `velocity_ps_per_mm=${fmt(velocity)} 不合理（PCB 上典型 5~7 ps/mm，上限 ~10）；` +
        "如写的是 m/s 或 in/ps 请换算",
    );
  }
  if (tdPs > 1e6) {
    throw new ParasiticError(
      "TL_PARAM_INVALID",
      `推导出的 TD=${tdPs.toFixed(1)} ps 明显越界，请检查 length/velocity 单位`,
    );
  }
  return [
    tdPs * 1e-12,
    [
      `length = ${fmt(length)} mm`,
      `velocity = ${fmt(velocity)} ps/mm`,
      `TD = ${tdPs.toFixed(1)} ps`,
    ],
  ];
}

/** 节点 / 元件名分配上下文。 */
export class NetCtx {
  readonly namer: Namer;
  readonly usedNodes: Set<string>;

  constructor(namer: Namer, usedNodes?: Set<string>) {
    this.namer = namer;
    this.usedNodes = usedNodes ?? new Set<string>();
  }

  name(prefix: string, hint: string): string {
    return this.namer.call(prefix, hint);
  }

  node(hint: string | null | undefined): string {
    const base = "__" + String(hint ?? "MID").replace(/[^0-9A-Za-z_]/g, "_");
    let candidate = base;
    let index = 2;
    while (this.usedNodes.has(candidate.toUpperCase())) {
      candidate = `${base}_${index}`;
      index += 1;
    }
    this.usedNodes.add(candidate.toUpperCase());
    return candidate;
  }
}

function requireValue(value: unknown, field: string, minimum?: number): number {
  const number = parseEng(value, field);
  if (minimum !== undefined && number <= minimum) {
    throw new ParasiticError("PARAM_INVALID", `${field} 必须 > ${minimum}，收到 ${asText(value)}`);
  }
  return number;
}

// ---------------------------------------------------------------------------
// 基本元件
// ---------------------------------------------------------------------------

export function resistor(
  ctx: NetCtx,
  nameHint: string,
  n1: string,
  n2: string,
  r: unknown,
  note?: string | null,
): [string[], string] {
  let value = requireValue(r, "r");
  if (value < 0) throw new ParasiticError("PARAM_INVALID", `电阻不能为负: ${asText(r)}`);
  let comment = note ?? null;
  if (value === 0) {
    // ngspice 对 0Ω 只会 clamp 到 1e-12 并警告，且 1µΩ 量级会让 tran 收敛失败
    // （实测 timestep too small 挂死）；1 mΩ 在 52Ω 系统里已是可忽略的短接。
    value = 1e-3;
    comment = (comment ?? "") + " [0Ω → 1mΩ 等效短接：ngspice 不接受零阻值，1µΩ 会不收敛]";
  }
  const name = ctx.name("R", nameHint);
  return [[`${name} ${n1} ${n2} ${fmt(value)}` + (comment ? `  $ ${comment}` : "")], name];
}

export function inductor(
  ctx: NetCtx,
  nameHint: string,
  n1: string,
  n2: string,
  l: unknown,
  note?: string | null,
): [string[], string] {
  const value = requireValue(l, "l", 0);
  const name = ctx.name("L", nameHint);
  return [[`${name} ${n1} ${n2} ${fmt(value)}` + (note ? `  $ ${note}` : "")], name];
}

export function capacitor(
  ctx: NetCtx,
  nameHint: string,
  n1: string,
  n2: string,
  c: unknown,
  note?: string | null,
): [string[], string] {
  const value = requireValue(c, "c", 0);
  const name = ctx.name("C", nameHint);
  return [[`${name} ${n1} ${n2} ${fmt(value)}` + (note ? `  $ ${note}` : "")], name];
}

export interface TransmissionLineSpec {
  z0?: unknown;
  td?: unknown;
  length_mm?: unknown;
  velocity_ps_per_mm?: unknown;
  [key: string]: unknown;
}

/**
 * 无损传输线：`T n1 ref n2 ref2 Z0=.. TD=..`。
 * 接受 z0 + td，或 z0 + length_mm + velocity_ps_per_mm 推导。
 */
export function transmissionLine(
  ctx: NetCtx,
  nameHint: string,
  n1: string,
  n2: string,
  spec: TransmissionLineSpec,
  ref = "0",
  ref2?: string | null,
): [string[], { element: string; z0: number; td: number; derivation: string[] }] {
  const refA = String(ref || "0");
  const refB = String(ref2 ?? refA);
  const z0 = requireValue(spec.z0, "z0", 0);
  let td: number;
  let derivation: string[];
  if (spec.td !== null && spec.td !== undefined && spec.td !== "") {
    td = requireValue(spec.td, "td", 0);
    derivation = [`TD = ${(td * 1e12).toFixed(1)} ps  (explicit)`];
  } else if (
    spec.length_mm !== null &&
    spec.length_mm !== undefined &&
    spec.length_mm !== "" &&
    spec.velocity_ps_per_mm !== null &&
    spec.velocity_ps_per_mm !== undefined &&
    spec.velocity_ps_per_mm !== ""
  ) {
    [td, derivation] = tdFromLength(spec.length_mm, spec.velocity_ps_per_mm);
  } else {
    throw new ParasiticError(
      "TL_PARAM_INVALID",
      "传输线需要 z0 + (td) 或 (length_mm + velocity_ps_per_mm)；" +
        "缺少参数时无法保证传播延迟量级正确",
    );
  }
  const name = ctx.name("T", nameHint);
  const line = `${name} ${n1} ${refA} ${n2} ${refB} Z0=${fmt(z0)} TD=${fmtTime(td)}`;
  return [[line], { element: name, z0, td, derivation }];
}

// ---------------------------------------------------------------------------
// 组合模型
// ---------------------------------------------------------------------------

/** 把多个两端元件串起来插在 n1..n2 之间，parts 形如 [["L","0.7n"],["R","20m"],["C","100n"]]。 */
export function seriesChain(
  ctx: NetCtx,
  nameHint: string,
  n1: string,
  n2: string,
  parts: [string, unknown][],
  note?: string | null,
): string[] {
  const lines: string[] = [];
  const nodes: string[] = [n1];
  for (let i = 0; i < parts.length - 1; i += 1) {
    nodes.push(ctx.node(`${nameHint}_${i + 1}`));
  }
  nodes.push(n2);
  for (let index = 0; index < parts.length; index += 1) {
    const [kind, value] = parts[index]!;
    // Python 版 `'LRC'[('L','R','C').index(kind)]` 的结果就是 kind 本身。
    const hint = `${nameHint}_${kind}`;
    const first = index === 0 ? note : null;
    if (kind === "L") {
      lines.push(...inductor(ctx, hint, nodes[index]!, nodes[index + 1]!, value, first)[0]);
    } else if (kind === "R") {
      lines.push(...resistor(ctx, hint, nodes[index]!, nodes[index + 1]!, value, first)[0]);
    } else if (kind === "C") {
      lines.push(...capacitor(ctx, hint, nodes[index]!, nodes[index + 1]!, value, first)[0]);
    } else {
      throw new ParasiticError("PARAM_INVALID", `未知串联元件类型 ${kind}`);
    }
  }
  return lines;
}

/** 带 ESR/ESL 的电容：n1 - L_ESL - R_ESR - C - n2。 */
export function capacitorModel(
  ctx: NetCtx,
  nameHint: string,
  n1: string,
  n2: string,
  c: unknown,
  esr?: unknown,
  esl?: unknown,
  source?: string | null,
  note?: string | null,
): [string[], string | null] {
  const parts: [string, unknown][] = [];
  if (esl !== null && esl !== undefined) parts.push(["L", esl]);
  if (esr !== null && esr !== undefined) parts.push(["R", esr]);
  parts.push(["C", c]);
  if (parts.length === 1) {
    const name = ctx.name("C", nameHint);
    return [
      [`${name} ${n1} ${n2} ${fmt(requireValue(c, "c", 0))}` + (note ? `  $ ${note}` : "")],
      name,
    ];
  }
  const tag = nameHint + (source ? `_${source}` : "");
  return [seriesChain(ctx, tag, n1, n2, parts, note), null];
}

/** Ferrite bead 简化模型：R_dc 串联 + (L ∥ R_p) 并联块。 */
export function ferriteModel(
  ctx: NetCtx,
  nameHint: string,
  n1: string,
  n2: string,
  rdc?: unknown,
  l?: unknown,
  rp?: unknown,
): string[] {
  const lines: string[] = [];
  let current = n1;
  if (rdc !== null && rdc !== undefined) {
    const mid = ctx.node(`${nameHint}_A`);
    lines.push(...resistor(ctx, `${nameHint}_RDC`, current, mid, rdc)[0]);
    current = mid;
  }
  if ((l === null || l === undefined) && (rp === null || rp === undefined)) {
    if (current === n1) {
      lines.push(...resistor(ctx, `${nameHint}_R`, n1, n2, "10m")[0]);
    } else {
      lines.push(`R${ctx.name("Z", nameHint)} ${current} ${n2} 1e-3`);
    }
    return lines;
  }
  const b = n2;
  if (rp !== null && rp !== undefined) {
    lines.push(...resistor(ctx, `${nameHint}_RP`, current, b, rp)[0]);
  }
  if (l !== null && l !== undefined) {
    lines.push(...inductor(ctx, `${nameHint}_L`, current, b, l)[0]);
  }
  return lines;
}

export function connectorModel(
  ctx: NetCtx,
  nameHint: string,
  n1: string,
  n2: string,
  r?: unknown,
  l?: unknown,
): string[] {
  if ((r === null || r === undefined) && (l === null || l === undefined)) return [];
  const parts: [string, unknown][] = [];
  if (l !== null && l !== undefined) parts.push(["L", l]);
  if (r !== null && r !== undefined) parts.push(["R", r]);
  return seriesChain(ctx, `${nameHint}_CONN`, n1, n2, parts);
}

export function viaModel(
  ctx: NetCtx,
  nameHint: string,
  n1: string,
  n2: string,
  r?: unknown,
  l?: unknown,
): string[] {
  return connectorModel(ctx, `${nameHint}_VIA`, n1, n2, r, l);
}

// ---------------------------------------------------------------------------
// 波形（current / voltage source）
// ---------------------------------------------------------------------------

function numOrStr(value: unknown): string {
  if (typeof value === "number") return fmt(value);
  const text = asText(value).trim();
  parseEng(text, "waveform");
  return text;
}

function pick(source: Record<string, unknown>, keys: string[], fallback?: unknown): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== null && value !== undefined) return value;
  }
  return fallback;
}

/**
 * waveform 描述 → SPICE 波形表达式。
 *
 * 支持 pulse / pwl / sin / dc，或直接给字符串 "PULSE(0 3.3 0 1n 1n 5n 10n)"。
 */
export function waveformText(wf: unknown): string | null {
  if (wf === null || wf === undefined) return null;
  if (typeof wf === "string") return wf;
  const spec = wf as Record<string, unknown>;
  const type = asText(spec["type"], "pulse").toLowerCase();
  if (type === "pulse") {
    const i1 = pick(spec, ["i_idle", "v_low", "v1"], "0");
    const i2 = pick(spec, ["i_active", "v_high", "v2"], "1");
    const td = pick(spec, ["delay"], "0");
    const tr = pick(spec, ["rise"], "1n");
    const tf = pick(spec, ["fall"], spec["rise"] ?? "1n");
    const pw = pick(spec, ["on", "width", "pw"]);
    const period = pick(spec, ["period", "pw"]);
    if (pw === null || pw === undefined || period === null || period === undefined) {
      throw new ParasiticError("PARAM_INVALID", "pulse 波形需要 on/period（或 width/period）");
    }
    return (
      `PULSE(${numOrStr(i1)} ${numOrStr(i2)} ${numOrStr(td)} ` +
      `${numOrStr(tr)} ${numOrStr(tf)} ${numOrStr(pw)} ${numOrStr(period)})`
    );
  }
  if (type === "pwl") {
    const points = (spec["points"] as unknown[] | undefined) ?? [];
    if (points.length === 0) {
      throw new ParasiticError("PARAM_INVALID", "pwl 波形需要 points");
    }
    const flat = points
      .map((point) => {
        const pair = point as [unknown, unknown];
        return `${numOrStr(pair[0])} ${numOrStr(pair[1])}`;
      })
      .join(" ");
    return `PWL(${flat})`;
  }
  if (type === "sin" || type === "sine") {
    const args = [
      ["offset", "0"],
      ["ampl", "1"],
      ["freq", "1k"],
      ["delay", "0"],
      ["theta", "0"],
      ["phase", "0"],
    ].map(([key, fallback]) => pick(spec, [key ?? ""], fallback));
    return "SIN(" + args.map((value) => numOrStr(value)).join(" ") + ")";
  }
  if (type === "dc" || type === "const") {
    return `DC ${numOrStr(pick(spec, ["value", "v", "i"], "0"))}`;
  }
  throw new ParasiticError("PARAM_INVALID", `未知波形类型 ${type}`);
}
