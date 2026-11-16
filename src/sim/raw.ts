/**
 * 解析 ngspice rawfile（`write` 命令产出的 ASCII / 二进制 raw）
 * （源仓库 scripts/parse_raw.py）。
 *
 * 结构要点：
 *   - 一个 raw 文件里可以顺序放多个 plot（sweep / 多次 write）；
 *   - ASCII 的 Values 块每个数据点占多行：首行 "点序号 第一个数值"，续行各一个数值；
 *   - complex 类型（AC 分析）成对存储，"re,im" 用逗号分隔；**X 轴（frequency）也是复数对**。
 */
import { readFileSync, writeFileSync } from "node:fs";

import type { RawPlot, RawValue } from "./types.ts";
import { fmt } from "./parasitics.ts";

export class RawParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RawParseError";
    this.code = code;
  }
}

function isIndexToken(token: string): boolean {
  return /^[+-]?\d+$/.test(token);
}

function parseFloatLoose(token: string): number | undefined {
  const value = Number.parseFloat(token);
  if (!Number.isNaN(value)) return value;
  const lower = token.toLowerCase();
  if (lower === "inf" || lower === "+inf" || lower === "infinity") return Number.POSITIVE_INFINITY;
  if (lower === "-inf" || lower === "-infinity") return Number.NEGATIVE_INFINITY;
  if (lower === "nan" || lower === "-nan") return Number.NaN;
  return undefined;
}

/** 解析 ASCII rawfile。 */
export function parseRawAscii(text: string): RawPlot[] {
  const plots: RawPlot[] = [];
  const starts: number[] = [];
  let cursor = text.indexOf("Plotname:");
  while (cursor >= 0) {
    starts.push(cursor);
    cursor = text.indexOf("Plotname:", cursor + 1);
  }
  if (starts.length === 0) starts.push(0);
  starts.push(text.length);

  for (let blockIndex = 0; blockIndex < starts.length - 1; blockIndex += 1) {
    const block = text.slice(starts[blockIndex], starts[blockIndex + 1]);
    if (!block.includes("Values:")) continue;
    const plot: RawPlot = {
      title: "",
      plotname: "",
      flags: "real",
      n_vars: 0,
      n_points: 0,
      vars: [],
      points: [],
    };
    let section: "vars" | "values" | null = null;
    let need = 0;
    const rows: number[][] = [];
    let current: number[] = [];

    const consume = (tokens: string[]): void => {
      for (const token of tokens) {
        const value = parseFloatLoose(token);
        if (value !== undefined) current.push(value);
      }
    };

    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("Title:")) {
        plot.title = line.slice(6).trim();
        section = null;
      } else if (line.startsWith("Plotname:")) {
        plot.plotname = line.slice(9).trim();
        section = null;
      } else if (line.startsWith("Flags:")) {
        plot.flags = line.slice(6).trim();
        section = null;
      } else if (line.startsWith("No. Variables:")) {
        plot.n_vars = Number.parseInt(line.split(":")[1] ?? "0", 10) || 0;
        section = null;
      } else if (line.startsWith("No. Points:")) {
        plot.n_points = Number.parseInt(line.split(":")[1] ?? "0", 10) || 0;
        section = null;
      } else if (line === "Variables:") {
        section = "vars";
      } else if (line === "Values:") {
        section = "values";
        need = plot.n_vars * (plot.flags.includes("complex") ? 2 : 1);
      } else if (section === "vars") {
        const parts = line.split(/\s+/);
        if (parts.length >= 2 && isIndexToken(parts[0] ?? "")) plot.vars.push(parts[1] ?? "");
      } else if (section === "values") {
        const tokens = line.replace(/,/g, " ").split(/\s+/).filter(Boolean);
        if (tokens.length > 0 && isIndexToken(tokens[0] ?? "")) {
          if (current.length === need) rows.push(current);
          current = [];
          consume(tokens.slice(1));
        } else {
          consume(tokens);
        }
      }
    }
    if (current.length === need) rows.push(current);
    if (plot.vars.length === 0 || rows.length === 0) continue;

    if (plot.flags.includes("complex")) {
      plot.points = rows.map((row) => {
        const point: RawValue[] = [];
        for (let i = 0; i < row.length; i += 2) {
          point.push([row[i] ?? 0, row[i + 1] ?? 0]);
        }
        return point;
      });
    } else {
      plot.points = rows.map((row) => row.map((value) => value as RawValue));
    }
    plot.n_points = plot.points.length;
    plots.push(plot);
  }
  return plots;
}

function readDoubleLE(buffer: Buffer, offset: number): number {
  return buffer.readDoubleLE(offset);
}

/** 解析二进制 rawfile（write 默认格式）：头是 ASCII，`Binary:` 之后是 little-endian double。 */
export function parseRawBinary(data: Buffer): RawPlot[] {
  const plots: RawPlot[] = [];
  let position = 0;
  while (position < data.length) {
    const binaryOffset = data.indexOf("Binary:", position);
    if (binaryOffset < 0) break;
    const header = data.subarray(position, binaryOffset).toString("latin1");
    const binaryStart = binaryOffset + "Binary:\n".length;
    const plot: RawPlot = {
      title: "",
      plotname: "",
      flags: "real",
      n_vars: 0,
      n_points: 0,
      vars: [],
      points: [],
    };
    let inVars = false;
    for (const rawLine of header.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("Title:")) {
        plot.title = line.slice(6).trim();
        inVars = false;
      } else if (line.startsWith("Plotname:")) {
        plot.plotname = line.slice(9).trim();
        inVars = false;
      } else if (line.startsWith("Flags:")) {
        plot.flags = line.slice(6).trim();
        inVars = false;
      } else if (line.startsWith("No. Variables:")) {
        plot.n_vars = Number.parseInt(line.split(":")[1] ?? "0", 10) || 0;
        inVars = false;
      } else if (line.startsWith("No. Points:")) {
        plot.n_points = Number.parseInt(line.split(":")[1] ?? "0", 10) || 0;
        inVars = false;
      } else if (line === "Variables:") {
        inVars = true;
      } else if (inVars && line) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) plot.vars.push(parts[1] ?? "");
      }
    }
    if (plot.n_vars === 0 || plot.n_points === 0 || plot.vars.length === 0) break;
    const perPoint = plot.flags.includes("complex") ? 2 : 1;
    const size = plot.n_points * plot.n_vars * perPoint * 8;
    const blob = data.subarray(binaryStart, binaryStart + size);
    const values: number[] = [];
    for (let i = 0; i + 8 <= blob.length; i += 8) values.push(readDoubleLE(blob, i));

    const points: RawValue[][] = [];
    let k = 0;
    for (let pointIndex = 0; pointIndex < plot.n_points; pointIndex += 1) {
      const row: RawValue[] = [];
      for (let varIndex = 0; varIndex < plot.n_vars; varIndex += 1) {
        if (perPoint === 2) {
          row.push([values[k] ?? 0, values[k + 1] ?? 0]);
          k += 2;
        } else {
          row.push(values[k] ?? 0);
          k += 1;
        }
      }
      points.push(row);
    }
    plot.points = points;
    plots.push(plot);
    position = binaryStart + size;
    while (position < data.length && (data[position] === 0x0a || data[position] === 0x0d)) {
      position += 1;
    }
    if (data.subarray(position, position + 6).toString("latin1") !== "Title:") break;
  }
  return plots;
}

/** 按内容自动分派 ASCII / 二进制解析。 */
export function parseRawBuffer(data: Buffer): RawPlot[] {
  if (data.includes("Binary:")) return parseRawBinary(data);
  return parseRawAscii(data.toString("latin1"));
}

/** 读文件并解析；解析不出任何 plot 时抛 RawParseError。 */
export function parseRawFile(file: string): RawPlot[] {
  const plots = parseRawBuffer(readFileSync(file));
  if (plots.length === 0) {
    throw new RawParseError("RAW_NO_PLOTS", `没有从 raw 文件里解析出任何 plot: ${file}`);
  }
  return plots;
}

/** 把解析后的 plots 写成 CSV（多 plot 用注释行分隔）。 */
export function plotsToCsv(plots: readonly RawPlot[], file: string): string {
  const lines: string[] = [];
  for (const plot of plots) {
    lines.push(`# ${plot.plotname}`);
    lines.push(plot.vars.join(","));
    for (const row of plot.points) {
      lines.push(
        row
          .map((value) =>
            Array.isArray(value) ? `${fmt(value[0], 6)},${fmt(value[1], 6)}` : fmt(value, 6),
          )
          .join(","),
      );
    }
  }
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}
