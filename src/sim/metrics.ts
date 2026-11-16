/**
 * 从 raw 波形自动提取可量化指标（源仓库 scripts/metrics.py）。
 *
 * 只做纯计算：过冲/下冲/上升/下降、阈值穿越次数（振铃）、skew、PDN 阻抗 |Z(f)|
 * 与谐振峰、PWM 谐波。指标 spec 形态与 SKILL.md「Metrics」一节一致：
 *
 *   {"metric": "tran_stats", "node": "CLK_ADC"}
 *   {"metric": "threshold_crossings", "node": "CLK_ADC", "threshold": 1.65}
 *   {"metric": "time_delta", "a": "CLK_ADC@1.65", "b": "CLK_FPGA@1.65"}
 *   {"metric": "impedance", "node": "AVDD", "amplitude": 1}
 *   {"metric": "fft_harmonics", "node": "MAIN_RAIL", "f0": 1000, "n": 5}
 */
import { spiceNode } from "./config.ts";
import { formatSignificant } from "./parasitics.ts";
import type { MetricErrorEntry, MetricResult, MetricSpec, RawPlot, RawValue } from "./types.ts";
import { SimError, asText } from "./types.ts";

export class MetricError extends SimError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "MetricError";
  }
}

type Series = { xs: number[]; ys: number[] };

/** 节点名宽松归一化：去 `$`、去前导 `_`、统一小写。 */
function norm(name: unknown): string {
  return asText(name).trim().toLowerCase().replace(/\$/g, "").replace(/^_+/, "");
}

function stripChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start] ?? "")) start += 1;
  while (end > start && chars.includes(text[end - 1] ?? "")) end -= 1;
  return text.slice(start, end);
}

/** 在 plot 里定位变量：支持 'AVDD' / '$AVDD' / 'v(avdd)' / 'I(V1)'。 */
export function findVar(plot: RawPlot, name: unknown): number {
  const want = asText(name).trim();
  const low = want.toLowerCase();
  const vars = plot.vars.map((item) => item.toLowerCase());
  const direct = vars.indexOf(low);
  if (direct >= 0) return direct;

  const candidates: string[] = [];
  if (/^(v\(|i\(|v\$|i\$)/.test(low)) candidates.push(low);
  const base = norm(want);
  candidates.push(`v(${base})`, base, `i(${base})`, `v(${low})`, `i(${low})`);
  // 3V3 → n_3v3（spice_node 会给数字开头补 N_）
  const safe = spiceNode(want);
  if (safe) {
    const sn = safe.toLowerCase();
    candidates.push(`v(${sn})`, `i(${sn})`, sn);
  }
  for (const candidate of candidates) {
    const index = vars.indexOf(candidate);
    if (index >= 0) return index;
  }
  // 宽松兜底：忽略大小写与括号里的 $/__
  for (let index = 0; index < vars.length; index += 1) {
    if (norm(stripChars(vars[index] ?? "", "vi()")) === base) return index;
  }
  throw new MetricError(
    "METRIC_NODE_NOT_FOUND",
    `raw 中没有变量 ${JSON.stringify(name)}（现有: [${plot.vars.join(", ")}]）`,
  );
}

/** raw 的 X 轴：complex plot 里连频率也成对存储（[f, 0]），要拆开。 */
function xval(row: readonly RawValue[]): number {
  const x = row[0];
  if (Array.isArray(x)) return Number(x[0]);
  return Number(x ?? Number.NaN);
}

function yval(value: RawValue | undefined): number {
  if (Array.isArray(value)) return Math.hypot(Number(value[0]), Number(value[1])); // AC 取模
  return Number(value ?? Number.NaN);
}

function xy(plot: RawPlot, name: unknown): Series {
  const index = findVar(plot, name);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const row of plot.points) {
    xs.push(xval(row));
    ys.push(yval(row[index]));
  }
  return { xs, ys };
}

function windowSeries(series: Series, spec: MetricSpec): Series {
  const t0 = spec.t0;
  const t1 = spec.t1;
  if (t0 === undefined && t1 === undefined) return series;
  const lo = t0 === undefined ? null : Number(t0);
  const hi = t1 === undefined ? null : Number(t1);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index < series.xs.length; index += 1) {
    const x = series.xs[index]!;
    if (lo !== null && x < lo) continue;
    if (hi !== null && x > hi) continue;
    xs.push(x);
    ys.push(series.ys[index]!);
  }
  if (xs.length < 2) {
    throw new MetricError("METRIC_WINDOW_EMPTY", `时间窗口 (${t0}, ${t1}) 内没有采样点`);
  }
  return { xs, ys };
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const k = ((sorted.length - 1) * p) / 100;
  const floor = Math.floor(k);
  const ceil = Math.min(floor + 1, sorted.length - 1);
  return sorted[floor]! + (sorted[ceil]! - sorted[floor]!) * (k - floor);
}

interface Crossing {
  t: number;
  dir: "rise" | "fall";
}

function crossings(
  xs: readonly number[],
  ys: readonly number[],
  threshold: number,
  risingOnly?: boolean,
): Crossing[] {
  const out: Crossing[] = [];
  for (let index = 1; index < xs.length; index += 1) {
    const a = ys[index - 1]!;
    const b = ys[index]!;
    if (a === b) continue;
    if ((a - threshold) * (b - threshold) > 0) continue;
    const rising = b > a;
    if (risingOnly === true && !rising) continue;
    if (risingOnly === false && rising) continue;
    // 线性插值到穿越时刻
    const t = xs[index - 1]! + ((threshold - a) * (xs[index]! - xs[index - 1]!)) / (b - a);
    out.push({ t, dir: rising ? "rise" : "fall" });
  }
  return out;
}

function tranStats(series: Series, spec: MetricSpec): Record<string, unknown> {
  const { xs, ys } = series;
  const n = ys.length;
  const tail = ys.slice(Math.floor(n * 0.8));
  const tailValues = tail.length > 0 ? tail : ys;
  const refHigh = spec.v_high !== undefined ? Number(spec.v_high) : percentile(tailValues, 90);
  const refLow = spec.v_low !== undefined ? Number(spec.v_low) : percentile(tailValues, 10);
  let amax = Number.NEGATIVE_INFINITY;
  let amin = Number.POSITIVE_INFINITY;
  let sum = 0;
  let sumSquares = 0;
  for (const value of ys) {
    if (value > amax) amax = value;
    if (value < amin) amin = value;
    sum += value;
    sumSquares += value * value;
  }
  const pp = amax - amin;
  const mean = sum / n;
  const rms = Math.sqrt(sumSquares / n);
  const span = refHigh - refLow;
  const out: Record<string, unknown> = {
    n_points: n,
    max: amax,
    min: amin,
    peak_to_peak: pp,
    mean,
    rms,
    final: ys[n - 1],
    ref_low: refLow,
    ref_high: refHigh,
    ref_source: spec.v_low !== undefined || spec.v_high !== undefined ? "explicit" : "p10/p90",
  };
  if (span > 1e-12) {
    // 过冲/下冲只对"摆幅可观"的信号有意义；DC 电源轨的 pp 只有几 mV，
    // 拿它当 100% 会造成 120% 这种荒谬数字，所以改成纹波百分比。
    const level = Math.max(Math.abs(amax), Math.abs(amin), Math.abs(mean), 1e-12);
    const edgeLike = (spec.v_high !== undefined && spec.v_low !== undefined) || span > 0.1 * level;
    out["signal_kind"] = edgeLike ? "edge" : "rail";
    if (edgeLike) {
      out["overshoot_pct"] = Math.max(0, ((amax - refHigh) / span) * 100);
      out["undershoot_pct"] = Math.max(0, ((refLow - amin) / span) * 100);
      out["rise_time"] = edgeTime(xs, ys, refLow + 0.1 * span, refLow + 0.9 * span, true);
      out["fall_time"] = edgeTime(xs, ys, refHigh - 0.1 * span, refHigh - 0.9 * span, false);
    } else {
      out["ripple_pct"] = Math.abs(mean) > 1e-15 ? (pp / Math.abs(mean)) * 100 : null;
      out["deviation_pct"] = Math.abs(mean) > 1e-15 ? ((amax - mean) / Math.abs(mean)) * 100 : null;
    }
  }
  return out;
}

function edgeTime(
  xs: readonly number[],
  ys: readonly number[],
  lo: number,
  hi: number,
  rising: boolean,
): number | null {
  const i0 = rising
    ? ys.findIndex((value, index) => index > 0 && ys[index - 1]! < lo && lo <= value)
    : ys.findIndex((value, index) => index > 0 && ys[index - 1]! > lo && lo >= value);
  if (i0 < 0) return null;
  let i1 = -1;
  for (let index = i0; index < ys.length; index += 1) {
    if (rising) {
      if (ys[index]! >= hi) {
        i1 = index;
        break;
      }
    } else if (ys[index]! <= hi) {
      i1 = index;
      break;
    }
  }
  if (i1 < 0) return null;
  return xs[i1]! - xs[i0]!;
}

function thresholdCrossings(series: Series, spec: MetricSpec): Record<string, unknown> {
  const threshold = spec.threshold;
  if (threshold === undefined) {
    throw new MetricError("METRIC_PARAM_INVALID", "threshold_crossings 需要 threshold");
  }
  const list = crossings(series.xs, series.ys, Number(threshold));
  const rises = list.filter((item) => item.dir === "rise");
  const falls = list.filter((item) => item.dir === "fall");

  // 把穿越按"同一条边沿"聚类：同一次跳变里的多次穿越（振铃）间隔远小于
  // 相邻两次跳变的间隔，所以用最大间隔（≈一个时钟周期）的 1/4 作为聚类门限。
  const gaps: number[] = [];
  for (let index = 0; index < list.length - 1; index += 1) {
    gaps.push((list[index + 1]?.t ?? 0) - (list[index]?.t ?? 0));
  }
  let gap = spec.cluster_gap;
  if (gap === undefined) {
    gap = gaps.length > 0 ? 0.25 * Math.max(...gaps) : 0;
  }
  const clusters: Crossing[][] = [];
  for (const item of list) {
    const last = clusters[clusters.length - 1];
    const previous = last?.[last.length - 1];
    if (last && previous && item.t - previous.t <= gap) {
      last.push(item);
    } else {
      clusters.push([item]);
    }
  }
  const multi = clusters.filter((cluster) => cluster.length > 1);
  return {
    threshold: Number(threshold),
    total: list.length,
    rises: rises.length,
    falls: falls.length,
    edges: clusters.length,
    crossings_per_edge: clusters.length > 0 ? list.length / clusters.length : 0,
    ringing: multi.length > 0,
    ringing_edges: multi.length,
    max_crossings_in_edge: clusters.reduce((max, cluster) => Math.max(max, cluster.length), 0),
    cluster_gap: gap,
    first_crossings: list.slice(0, 8).map((item) => ({ t: item.t, dir: item.dir })),
    first_rise: rises[0]?.t ?? null,
    first_fall: falls[0]?.t ?? null,
  };
}

function parseNodeAt(text: unknown): [string, number] {
  const value = asText(text);
  if (value.includes("@")) {
    const at = value.lastIndexOf("@");
    return [value.slice(0, at).trim(), Number(value.slice(at + 1))];
  }
  throw new MetricError(
    "METRIC_PARAM_INVALID",
    `time_delta 端点需要写成 NODE@阈值，收到 ${JSON.stringify(text)}`,
  );
}

function timeDelta(plot: RawPlot, spec: MetricSpec): Record<string, unknown> {
  const a = spec.a;
  const b = spec.b;
  if (!a || !b) throw new MetricError("METRIC_PARAM_INVALID", "time_delta 需要 a 与 b");
  const [na, ta] = parseNodeAt(a);
  const [nb, tb] = parseNodeAt(b);
  const seriesA = xy(plot, na);
  const seriesB = xy(plot, nb);
  let crossA = crossings(seriesA.xs, seriesA.ys, ta, true);
  let crossB = crossings(seriesB.xs, seriesB.ys, tb, true);
  if (spec.t0 !== undefined) {
    crossA = crossA.filter((item) => item.t >= Number(spec.t0));
    crossB = crossB.filter((item) => item.t >= Number(spec.t0));
  }
  if (spec.t1 !== undefined) {
    crossA = crossA.filter((item) => item.t <= Number(spec.t1));
    crossB = crossB.filter((item) => item.t <= Number(spec.t1));
  }
  if (crossA.length === 0 || crossB.length === 0) {
    throw new MetricError("METRIC_NO_CROSSING", `${a} 或 ${b} 在仿真窗口内没有上升沿穿越`);
  }
  const tA = crossA[0]!.t;
  const tB = crossB[0]!.t;
  return { a, b, t_a: tA, t_b: tB, skew: tB - tA, skew_abs: Math.abs(tB - tA) };
}

function impedance(plot: RawPlot, spec: MetricSpec): Record<string, unknown> {
  const node = spec.node;
  const amplitude = Number(spec.amplitude ?? 1) || 1;
  const index = findVar(plot, node);
  const xs: number[] = [];
  const zs: number[] = [];
  for (const row of plot.points) {
    xs.push(xval(row));
    const value = row[index];
    let re: number;
    let im: number;
    if (Array.isArray(value)) {
      [re, im] = [Number(value[0]), Number(value[1])];
    } else {
      [re, im] = [Number(value ?? 0), 0];
    }
    zs.push(Math.hypot(re, im) / Math.abs(amplitude));
  }
  if (zs.length === 0) throw new MetricError("METRIC_EMPTY", `${String(node)} 没有 AC 数据`);
  let imax = 0;
  for (let i = 1; i < zs.length; i += 1) if (zs[i]! > zs[imax]!) imax = i;
  const out: Record<string, unknown> = {
    node,
    amplitude,
    max_impedance: zs[imax],
    peak_frequency: xs[imax],
    min_impedance: Math.min(...zs),
    z_at: zs.map((z, i) => ({ f: xs[i], z })),
    n_points: zs.length,
  };
  for (const f of spec.at ?? []) {
    const z = interpLog(xs, zs, Number(f));
    if (z !== null) out[`z_at_${formatSignificant(Number(f))}`] = z;
  }
  return out;
}

/** 在 log-log 上线性插值取某个频点的 |Z|（明显超出范围返回 null）。 */
function interpLog(xs: readonly number[], zs: readonly number[], f: number): number | null {
  if (xs.length === 0) return null;
  if (f < xs[0]! * 0.999 || f > xs[xs.length - 1]! * 1.001) return null;
  for (let index = 1; index < xs.length; index += 1) {
    if (xs[index]! >= f) {
      const x0 = xs[index - 1]!;
      const x1 = xs[index]!;
      const y0 = zs[index - 1]!;
      const y1 = zs[index]!;
      if (x0 <= 0 || f <= 0 || y0 <= 0 || y1 <= 0) {
        return x1 !== x0 ? y0 + ((y1 - y0) * (f - x0)) / (x1 - x0) : y0;
      }
      const t = (Math.log10(f) - Math.log10(x0)) / (Math.log10(x1) - Math.log10(x0));
      return 10 ** (Math.log10(y0) + t * (Math.log10(y1) - Math.log10(y0)));
    }
  }
  return zs[zs.length - 1]!;
}

function uniform(
  xs: readonly number[],
  ys: readonly number[],
  n: number,
): { dt: number; ys: number[] } {
  const t0 = xs[0]!;
  const t1 = xs[xs.length - 1]!;
  if (t1 <= t0) throw new MetricError("METRIC_EMPTY", "时间窗口无效");
  const dt = (t1 - t0) / (n - 1);
  const out: number[] = [];
  let j = 0;
  for (let index = 0; index < n; index += 1) {
    const t = t0 + index * dt;
    while (j < xs.length - 2 && xs[j + 1]! < t) j += 1;
    const x0 = xs[j]!;
    const x1 = xs[Math.min(j + 1, xs.length - 1)]!;
    const y0 = ys[j]!;
    const y1 = ys[Math.min(j + 1, ys.length - 1)]!;
    out.push(x1 === x0 ? y0 : y0 + ((y1 - y0) * (t - x0)) / (x1 - x0));
  }
  return { dt, ys: out };
}

function fftHarmonics(plot: RawPlot, spec: MetricSpec): Record<string, unknown> {
  const node = spec.node;
  const f0 = Number(spec.f0 ?? 0);
  if (!(f0 > 0)) throw new MetricError("METRIC_PARAM_INVALID", "fft_harmonics 需要 f0 > 0");
  const harmonics = Number.parseInt(String(spec.n ?? 5), 10);
  const series = windowSeries(xy(plot, node), spec);
  const n = 1024;
  const { dt, ys } = uniform(series.xs, series.ys, n);
  const mean = ys.reduce((sum, value) => sum + value, 0) / n;
  const centered = ys.map((value) => value - mean);
  const results: Record<string, unknown>[] = [];
  for (let h = 1; h <= harmonics; h += 1) {
    const f = f0 * h;
    let accRe = 0;
    let accIm = 0;
    for (let index = 0; index < centered.length; index += 1) {
      const angle = -2 * Math.PI * f * index * dt;
      accRe += centered[index]! * Math.cos(angle);
      accIm += centered[index]! * Math.sin(angle);
    }
    results.push({
      harmonic: h,
      freq: f,
      magnitude: (Math.hypot(accRe, accIm) * 2.0) / n,
    });
  }
  const base = Number(results[0]?.["magnitude"] ?? 0) || 1e-30;
  for (const row of results) {
    row["relative_db"] = 20 * Math.log10(Math.max(Number(row["magnitude"]), 1e-30) / base);
  }
  return { node, f0, harmonics: results, dc: mean };
}

function pickPlot(plots: readonly RawPlot[], mode?: string | null, complexOk = false): RawPlot {
  if (plots.length === 0) throw new MetricError("METRIC_NO_PLOT", "没有可用的 raw plot");
  const wantsAc = complexOk || String(mode ?? "").toLowerCase() === "ac";
  for (const plot of plots) {
    const isComplex = String(plot.flags ?? "").includes("complex");
    if (wantsAc === isComplex) return plot;
  }
  return plots[0]!;
}

function xyPick(
  plots: readonly RawPlot[],
  spec: MetricSpec,
  mode: string | null | undefined,
  complexOk = false,
): Series {
  const plot = pickPlot(plots, mode, complexOk);
  return xy(plot, spec.node ?? spec.var);
}

/** 按 specs 计算指标。返回 {指标名: 值} 与失败清单（单条失败不影响其它指标）。 */
export function computeMetrics(
  plots: readonly RawPlot[],
  specs: readonly MetricSpec[] | undefined,
  mode?: string | null,
): MetricResult {
  const metrics: Record<string, Record<string, unknown>> = {};
  const errors: MetricErrorEntry[] = [];
  if (!specs || specs.length === 0) return { metrics, errors };
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index] ?? {};
    const kind = String(spec.metric ?? "").toLowerCase();
    const label = spec.name || `${kind}#${index + 1}`;
    try {
      if (kind === "tran_stats" || kind === "stats" || kind === "transient") {
        const series = windowSeries(xyPick(plots, spec, mode, false), spec);
        metrics[label] = tranStats(series, spec);
      } else if (kind === "threshold_crossings") {
        const series = windowSeries(xyPick(plots, spec, mode, false), spec);
        metrics[label] = thresholdCrossings(series, spec);
      } else if (kind === "time_delta") {
        metrics[label] = timeDelta(pickPlot(plots, mode, false), spec);
      } else if (kind === "impedance" || kind === "z") {
        metrics[label] = impedance(pickPlot(plots, mode, true), spec);
      } else if (kind === "fft_harmonics" || kind === "fft") {
        metrics[label] = fftHarmonics(pickPlot(plots, mode, false), spec);
      } else {
        throw new MetricError("METRIC_UNKNOWN", `未知指标类型 ${JSON.stringify(kind)}`);
      }
      metrics[label]!["metric"] = kind;
    } catch (error) {
      if (!(error instanceof MetricError)) throw error;
      metrics[label] = { metric: kind, error: error.code, message: error.message };
      errors.push({ metric: label, code: error.code, message: error.message });
    }
  }
  return { metrics, errors };
}

/** 人读的一行摘要（stdout / 汇总表用）。 */
export function metricSummaryLine(
  name: string,
  metric: Record<string, unknown> | undefined,
): string {
  if (!metric) return "";
  if (metric["error"]) {
    return `${name}: ERROR ${asText(metric["error"])} (${asText(metric["message"])})`;
  }
  const kind = asText(metric["metric"]);
  /** 对应 Python 的 `:.{n}g`。 */
  const g = (key: string, digits: number): string =>
    formatSignificant(Number(metric[key] ?? 0), digits);
  /** 对应 Python 的 `:.{n}f`。 */
  const fixed = (key: string, digits: number): string => Number(metric[key] ?? 0).toFixed(digits);
  if (kind === "tran_stats" || kind === "stats" || kind === "transient") {
    if (metric["signal_kind"] === "rail") {
      return (
        `${name}: ripple=${g("peak_to_peak", 4)} (${fixed("ripple_pct", 3)}%) ` +
        `max=${g("max", 6)} min=${g("min", 6)}`
      );
    }
    return (
      `${name}: pp=${g("peak_to_peak", 4)} max=${g("max", 4)} min=${g("min", 4)} ` +
      `overshoot=${fixed("overshoot_pct", 1)}% undershoot=${fixed("undershoot_pct", 1)}%`
    );
  }
  if (kind === "threshold_crossings") {
    const ringing = metric["ringing"] ? "yes" : "no";
    return (
      `${name}: crossings=${String(metric["total"])} on ${String(metric["edges"])} edges ` +
      `(rise ${String(metric["rises"])} / fall ${String(metric["falls"])}) ringing=${ringing}` +
      (metric["ringing"] ? ` max ${String(metric["max_crossings_in_edge"])}/edge` : "")
    );
  }
  if (kind === "time_delta") {
    const skew = (Number(metric["skew"] ?? 0) * 1e12).toFixed(1);
    return `${name}: skew=${skew} ps (${String(metric["a"])} vs ${String(metric["b"])})`;
  }
  if (kind === "impedance" || kind === "z") {
    return `${name}: |Z|max=${g("max_impedance", 4)} Ω @ ${g("peak_frequency", 4)} Hz`;
  }
  if (kind === "fft_harmonics" || kind === "fft") {
    const first = (metric["harmonics"] as Record<string, unknown>[] | undefined)?.[0];
    return (
      `${name}: fundamental=${formatSignificant(Number(first?.["magnitude"] ?? 0), 4)} ` +
      `@ ${g("f0", 4)} Hz`
    );
  }
  return `${name}: ${JSON.stringify(metric)}`;
}
