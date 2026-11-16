/**
 * Touchstone 解析（.s1p / .s2p / .sNp）
 * （源仓库 scripts/touchstone.py + sparam_metrics.py 的插损/回损部分）。
 *
 * 支持：频率单位 Hz/kHz/MHz/GHz、数据格式 RI/MA/DB、归一化阻抗 R <z0>（默认 50）、
 * `!` 注释、选项行 `# ...`、多行续写（2 端口每点 9 个数，允许折行）。
 * 不支持（会明确报错而不是猜）：Y/Z/H/G 参数格式、噪声参数块、混合模式端口。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { SimError, asText } from "./types.ts";

const FREQ_SCALE: Record<string, number> = { hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9 };
const FORMATS = ["ri", "ma", "db"];

export class TouchstoneError extends SimError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "TouchstoneError";
  }
}

export interface Complex {
  re: number;
  im: number;
}

function toComplex(a: number, b: number, format: string): Complex {
  const kind = format.toLowerCase();
  if (kind === "ri") return { re: a, im: b };
  if (kind === "ma") {
    const radians = (b * Math.PI) / 180;
    return { re: a * Math.cos(radians), im: a * Math.sin(radians) };
  }
  if (kind === "db") {
    const magnitude = 10 ** (a / 20);
    const radians = (b * Math.PI) / 180;
    return { re: magnitude * Math.cos(radians), im: magnitude * Math.sin(radians) };
  }
  throw new TouchstoneError("TOUCHSTONE_FORMAT_UNSUPPORTED", `不支持的数据格式 ${kind}`);
}

function abs(value: Complex): number {
  return Math.hypot(value.re, value.im);
}

function phaseDeg(value: Complex): number {
  return (Math.atan2(value.im, value.re) * 180) / Math.PI;
}

export class Touchstone {
  file: string | null;
  readonly path: string | null;
  num_ports: number | null = null;
  z0 = 50;
  freq_unit = "hz";
  data_format = "ma";
  /** Hz。 */
  frequencies: number[] = [];
  /** s[k][i][j]（k = 频点）。 */
  s: Complex[][][] = [];
  comments: string[] = [];
  warnings: string[] = [];

  constructor(filePath?: string | null) {
    this.path = filePath ?? null;
    this.file = filePath ? path.basename(filePath) : null;
  }

  at(i: number, j: number, k: number): Complex {
    return this.s[k]![i]![j]!;
  }

  freqs(): number[] {
    return [...this.frequencies];
  }

  magnitude(i: number, j: number): number[] {
    return this.s.map((point) => abs(point[i]![j]!));
  }

  db(i: number, j: number): number[] {
    return this.s.map((point) => 20 * Math.log10(Math.max(abs(point[i]![j]!), 1e-30)));
  }

  phase(i: number, j: number): number[] {
    return this.s.map((point) => phaseDeg(point[i]![j]!));
  }

  toDict(): Record<string, unknown> {
    return {
      file: this.file,
      path: this.path,
      num_ports: this.num_ports,
      z0: this.z0,
      freq_unit: this.freq_unit,
      data_format: this.data_format,
      n_points: this.frequencies.length,
      f_start_hz: this.frequencies[0] ?? null,
      f_stop_hz: this.frequencies[this.frequencies.length - 1] ?? null,
      warnings: this.warnings,
    };
  }
}

function parseOption(line: string, ts: Touchstone): void {
  const tokens = line.slice(1).split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length) {
    const token = (tokens[index] ?? "").toLowerCase();
    if (token in FREQ_SCALE) {
      ts.freq_unit = token;
    } else if (FORMATS.includes(token)) {
      ts.data_format = token;
    } else if (token === "r" && index + 1 < tokens.length) {
      const value = Number.parseFloat(tokens[index + 1] ?? "");
      if (Number.isFinite(value)) ts.z0 = value;
      index += 1;
    } else if (["y", "z", "h", "g"].includes(token)) {
      throw new TouchstoneError(
        "TOUCHSTONE_FORMAT_UNSUPPORTED",
        `只支持 S 参数，文件里写的是 ${token.toUpperCase()} 参数（${line.trim()}）`,
      );
    }
    index += 1;
  }
}

function checkMonotonic(ts: Touchstone): void {
  let bad = 0;
  for (let index = 1; index < ts.frequencies.length; index += 1) {
    if (ts.frequencies[index]! <= ts.frequencies[index - 1]!) bad += 1;
  }
  if (bad > 0) ts.warnings.push(`频率不是单调递增（${bad} 处），已按文件顺序保留`);
}

/** 解析 .sNp 文件。 */
export function parseTouchstone(file: string): Touchstone {
  const name = path.basename(file);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new TouchstoneError("TOUCHSTONE_FILE_MISSING", `文件不存在: ${file}`);
  }
  const match = /\.s(\d+)p$/i.exec(file);
  if (!match) {
    throw new TouchstoneError("TOUCHSTONE_NOT_SPARAM", `${name} 不是 .sNp 文件`);
  }
  const ports = Number.parseInt(match[1] ?? "0", 10);
  if (ports < 1) {
    throw new TouchstoneError("TOUCHSTONE_NOT_SPARAM", "端口数必须 >= 1");
  }
  const ts = new Touchstone(file);
  ts.num_ports = ports;
  const perPoint = 1 + 2 * ports * ports;

  const numbers: number[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("!")) {
      ts.comments.push(line.slice(1).trim());
      continue;
    }
    if (line.startsWith("#")) {
      parseOption(line, ts);
      continue;
    }
    for (const token of line.split(/\s+/).filter(Boolean)) {
      const value = Number.parseFloat(token);
      if (!Number.isFinite(value)) {
        throw new TouchstoneError(
          "TOUCHSTONE_PARSE_ERROR",
          `${name}: 无法解析的数值 ${JSON.stringify(token)}（行: ${line.slice(0, 60)}）`,
        );
      }
      numbers.push(value);
    }
  }
  if (numbers.length === 0) {
    throw new TouchstoneError("TOUCHSTONE_PARSE_ERROR", `${name} 里没有数据点`);
  }
  if (numbers.length % perPoint !== 0) {
    throw new TouchstoneError(
      "TOUCHSTONE_PARSE_ERROR",
      `${name}: 数据个数 ${numbers.length} 不是每点 ${perPoint} 个数的整数倍` +
        `（${ports} 端口应有 1+2*n^2 = ${perPoint} 列）`,
    );
  }
  const scale = FREQ_SCALE[ts.freq_unit] ?? 1;
  for (let base = 0; base < numbers.length; base += perPoint) {
    const chunk = numbers.slice(base, base + perPoint);
    const frequency = (chunk[0] ?? 0) * scale;
    const pairs = chunk.slice(1);
    const matrix: Complex[][] = [];
    let index = 0;
    for (let i = 0; i < ports; i += 1) {
      const row: Complex[] = [];
      for (let j = 0; j < ports; j += 1) {
        const a = pairs[index] ?? 0;
        const b = pairs[index + 1] ?? 0;
        index += 2;
        row.push(toComplex(a, b, ts.data_format));
      }
      matrix.push(row);
    }
    ts.frequencies.push(frequency);
    ts.s.push(matrix);
  }
  if (ts.frequencies.length < 2) {
    ts.warnings.push("只有 1 个频点，拟合/插值没有意义");
  }
  checkMonotonic(ts);
  return ts;
}

/** 读不到就返回 null（对应 load_or_none）。 */
export function loadTouchstoneOrNone(file: string): Touchstone | null {
  try {
    return parseTouchstone(file);
  } catch {
    return null;
  }
}

function dbOf(value: Complex): number {
  return 20 * Math.log10(Math.max(abs(value), 1e-30));
}

function localPeaks(
  values: number[],
  frequencies: number[],
  minDb?: number,
): { f: number; value: number }[] {
  const out: { f: number; value: number }[] = [];
  for (let index = 1; index < values.length - 1; index += 1) {
    if (values[index]! > values[index - 1]! && values[index]! >= values[index + 1]!) {
      if (minDb === undefined || values[index]! >= minDb) {
        out.push({ f: frequencies[index]!, value: values[index]! });
      }
    }
  }
  return out;
}

/** S11 → Z（1 端口）。 */
export function impedance1Port(ts: Touchstone): { f: number; z: Complex; mag: number }[] {
  return ts.frequencies.map((frequency, index) => {
    const s11 = ts.s[index]![0]![0]!;
    const denominator = { re: 1 - s11.re, im: -s11.im };
    const magnitude = Math.hypot(denominator.re, denominator.im);
    let z: Complex;
    if (magnitude > 1e-12) {
      const numerator = { re: 1 + s11.re, im: s11.im };
      const re =
        (numerator.re * denominator.re + numerator.im * denominator.im) / (magnitude * magnitude);
      const im =
        (numerator.im * denominator.re - numerator.re * denominator.im) / (magnitude * magnitude);
      z = { re: ts.z0 * re, im: ts.z0 * im };
    } else {
      z = { re: 1e12, im: 0 };
    }
    return { f: frequency, z, mag: Math.hypot(z.re, z.im) };
  });
}

/**
 * 结构化指标（2 端口给插损/回损/带宽/谐振，1 端口给 |Z|）。
 * 定义与源仓库 sparam_metrics.metrics 一致：插损 = -max(S21 dB)，回损 = -min(S11 dB)。
 */
export function touchstoneMetrics(ts: Touchstone): Record<string, unknown> {
  const out: Record<string, unknown> = {
    file: ts.file,
    num_ports: ts.num_ports,
    n_points: ts.frequencies.length,
    z0: ts.z0,
  };
  const frequencies = ts.frequencies;
  if (frequencies.length === 0) return out;
  out["f_start_hz"] = frequencies[0];
  out["f_stop_hz"] = frequencies[frequencies.length - 1];

  if (ts.num_ports === 1) {
    const impedances = impedance1Port(ts);
    const mags = impedances.map((item) => item.mag);
    let imax = 0;
    for (let index = 1; index < mags.length; index += 1) {
      if (mags[index]! > mags[imax]!) imax = index;
    }
    const s11 = ts.db(0, 0);
    out["s11_db"] = s11;
    out["return_loss_db"] = -Math.min(...s11);
    out["worst_return_loss_db"] = -Math.max(...s11);
    out["|z|_ohm"] = mags;
    out["z_max_ohm"] = mags[imax];
    out["z_max_f"] = frequencies[imax];
    out["z_min_ohm"] = Math.min(...mags);
    out["z_min_f"] = frequencies[mags.indexOf(Math.min(...mags))];
    out["resonances"] = localPeaks(mags, frequencies);
    return out;
  }

  const s21 = ts.db(1, 0);
  const s11 = ts.db(0, 0);
  const s12 = ts.db(0, 1);
  const s22 = ts.db(1, 1);
  const ports = ts.num_ports ?? 0;
  const sParameters: Record<string, number[]> = {};
  for (let i = 0; i < ports; i += 1) {
    for (let j = 0; j < ports; j += 1) sParameters[`S${i + 1}${j + 1}`] = ts.db(i, j);
  }
  out["s11_db"] = s11;
  out["s21_db"] = s21;
  out["s12_db"] = s12;
  out["s22_db"] = s22;
  out["s_parameters"] = sParameters;
  const peak = Math.max(...s21);
  const peakIndex = s21.indexOf(peak);
  out["insertion_loss_db"] = -peak;
  out["peak_s21_db"] = peak;
  out["peak_s21_f"] = frequencies[peakIndex];
  out["peak_attenuation_db"] = -Math.min(...s21);
  out["stopband_f"] = frequencies[s21.indexOf(Math.min(...s21))];
  out["return_loss_db"] = -Math.min(...s11);
  out["worst_return_loss_db"] = -Math.max(...s11);
  out["is_reciprocal"] = ts.s.every(
    (point) => Math.abs(abs(point[1]![0]!) - abs(point[0]![1]!)) < 1e-3,
  );
  // -3 dB 带宽（相对峰值）
  const threshold = peak - 3;
  const above = s21
    .map((value, index) => (value >= threshold ? index : -1))
    .filter((index) => index >= 0);
  if (above.length > 0) {
    const lo = above[0]!;
    const hi = above[above.length - 1]!;
    const bandwidth: Record<string, unknown> = {
      f_low: frequencies[lo],
      f_high: frequencies[hi],
      bandwidth: frequencies[hi]! - frequencies[lo]!,
      definition: "peak - 3 dB",
    };
    if (lo === 0) bandwidth["note"] = "低端未回落到 -3 dB，可能是低通/高通而非带通";
    if (hi === frequencies.length - 1) {
      bandwidth["note"] = `${asText(bandwidth["note"])}；高端未回落到 -3 dB`;
    }
    out["bandwidth_3db"] = bandwidth;
  }
  out["resonances"] = localPeaks(s21, frequencies);
  out["notches"] = s21
    .map((value, index) =>
      index > 0 && index < s21.length - 1 && value < s21[index - 1]! && value <= s21[index + 1]!
        ? { f: frequencies[index], value }
        : null,
    )
    .filter((item) => item !== null);
  return out;
}

/** 插损（dB，正数表示损耗）与回损（dB，正数表示匹配好）。 */
export function touchstoneLoss(ts: Touchstone): {
  insertion_loss_db: number | null;
  return_loss_db: number | null;
} {
  const metrics = touchstoneMetrics(ts);
  return {
    insertion_loss_db: (metrics["insertion_loss_db"] as number | undefined) ?? null,
    return_loss_db: (metrics["return_loss_db"] as number | undefined) ?? null,
  };
}

/** dbOf 保留给外部工具（S 参数曲线打印）。 */
export { dbOf };
