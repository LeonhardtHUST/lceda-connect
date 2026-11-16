/**
 * ngspice 仿真 CLI：probe / netlist / run / raw / stackup / touchstone。
 *
 * 只依赖 Io 抽象，由 main 负责挂到顶层命令；`--json` 输出机器可读结果，
 * 默认输出中文摘要与产物路径。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Io } from "../core/io.ts";
import {
  CliUsageError,
  boolValue,
  formatOptions,
  numberValue,
  parseArgs,
  stringValue,
  type OptionSpec,
} from "../core/cliArgs.ts";
import { ProjectError } from "../epro2/container.ts";
import { loadSimConfig } from "./config.ts";
import { buildPinNetTable, generateNetlist } from "./netlist.ts";
import { fromEpro2File, loadSimIr, validateIr } from "./ir.ts";
import { probeNgspice } from "./ngspice.ts";
import { metricSummaryLine } from "./metrics.ts";
import { parseRawFile, plotsToCsv } from "./raw.ts";
import { readNetlistFile, runSimulation } from "./run.ts";
import { probePython, listSimSidecarScripts } from "./sidecar.ts";
import { Stackup, traceParams, viaParasitics, stackupSummaryLines } from "./stackup.ts";
import { parseTouchstone, touchstoneMetrics } from "./touchstone.ts";
import type { MetricSpec, NetlistReport } from "./types.ts";
import { SimError } from "./types.ts";

const PROBE_OPTIONS: readonly OptionSpec[] = [
  { name: "ngspice", type: "string", placeholder: "路径", description: "指定 ngspice 可执行文件" },
  { name: "python", type: "string", placeholder: "路径", description: "指定 Python 解释器" },
  { name: "json", type: "boolean", description: "输出 JSON" },
];

const NETLIST_OPTIONS: readonly OptionSpec[] = [
  {
    name: "out",
    aliases: ["o"],
    type: "string",
    placeholder: "目录",
    description: "产物目录（默认 sim-out）",
  },
  { name: "page", type: "string", placeholder: "页名或 uuid", description: "只取指定原理图页" },
  { name: "ir", type: "boolean", description: "把第一个参数当成 IR JSON 而不是 .epro2" },
  { name: "config", type: "string", placeholder: "文件", description: "sim_config.json" },
  { name: "models", type: "string", placeholder: "文件", description: "model_map.json" },
  { name: "power-policy", type: "string", placeholder: "auto|explicit", description: "电源策略" },
  { name: "strict", type: "boolean", description: "拓扑可疑直接报错" },
  { name: "allow-partial-model", type: "boolean", description: "pin mapping 不完整时降级为警告" },
  { name: "json", type: "boolean", description: "输出 JSON" },
];

const RUN_OPTIONS: readonly OptionSpec[] = [
  {
    name: "mode",
    aliases: ["m"],
    type: "string",
    placeholder: "op|tran|ac|dc",
    description: "分析类型",
  },
  { name: "args", type: "string", placeholder: "参数", description: "分析参数（如 '10p 600n'）" },
  {
    name: "out",
    aliases: ["o"],
    type: "string",
    placeholder: "目录",
    description: "工作目录（默认 sim-out）",
  },
  { name: "timeout", type: "number", placeholder: "秒", description: "超时（默认 600）" },
  {
    name: "config",
    type: "string",
    placeholder: "文件",
    description: "sim_config.json（取 metrics）",
  },
  {
    name: "report",
    type: "string",
    placeholder: "文件",
    description: "netlist_report.json（写进 manifest）",
  },
  { name: "project", type: "string", placeholder: "名称", description: "工程名（写进 manifest）" },
  { name: "ngspice", type: "string", placeholder: "路径", description: "指定 ngspice 可执行文件" },
  { name: "json", type: "boolean", description: "输出 JSON" },
];

const RAW_OPTIONS: readonly OptionSpec[] = [
  { name: "csv", type: "boolean", description: "同时写 <raw>.csv" },
  { name: "list", type: "boolean", description: "只列 plot 与变量名" },
  { name: "json", type: "boolean", description: "输出 JSON（默认对每个 plot 给摘要）" },
];

const STACKUP_OPTIONS: readonly OptionSpec[] = [
  {
    name: "board-thickness",
    type: "string",
    placeholder: "mm",
    description: "板厚 mm（过孔长度兜底）",
  },
  {
    name: "via",
    type: "string",
    placeholder: "d,p,h",
    description: "过孔 钻孔,焊盘,长度（mm），估 R/L/C",
  },
  { name: "json", type: "boolean", description: "输出 JSON" },
];

const TOUCHSTONE_OPTIONS: readonly OptionSpec[] = [
  { name: "json", type: "boolean", description: "输出 JSON" },
];

export function simHelp(): string[] {
  return [
    "ngspice 仿真（.epro2 原理图 → 网表 → deck → ngspice → raw → 指标 → manifest）",
    "",
    "用法:",
    "  sim probe [--ngspice <路径>] [--python <路径>] [--json]",
    "  sim netlist <工程.epro2> [--page <页名或 uuid>] --out <目录> [--config <sim_config.json>] [--json]",
    "  sim netlist <ir.json> --ir --out <目录> [--json]",
    "  sim run <网表.cir> --mode <op|tran|ac|dc> [--args '<参数>'] --out <目录> [--timeout <秒>] [--json]",
    "  sim raw <file.raw> [--csv] [--list] [--json]",
    "  sim stackup <stackup.json> <层名> <线宽mm> [长度mm] [--via 钻孔,焊盘,长度] [--json]",
    "  sim touchstone <file.sNp> [--json]",
    "",
    "netlist 产物:",
    "  schematic.cir（未注入 .control 的网表）/ netlist_report.json（分类、地映射、模型与排除清单）",
    "run 产物（工作目录内）:",
    "  deck.cir / *.raw / *.csv / metrics.json / simulation_manifest.json / stdout.txt / stderr.txt",
    "",
    "规则:",
    "  - `$` 是 ngspice 行内注释符：虚拟节点 `$X` 落 deck 时写成 `__X`，报告保留 `$X`。",
    "  - 子电路实例必须 `X` 开头（否则被当成 URC 传输线）。",
    "  - 0Ω 电阻写成 1mΩ；tran 的步长必须远小于最快边沿。",
    "  - 默认只把 GND/GROUND/0 映射到节点 0，AGND/DGND 保持独立（要合并得在 ground_aliases 声明）。",
    "  - 叠层 / 走线 / 过孔的 Z0、TD、R/L/C 都是解析估计：ANALYTIC_ESTIMATE / ENGINEERING_ESTIMATE。",
    "",
    "选项:",
    ...formatOptions(RUN_OPTIONS),
    "  （各子命令只接受自己那一组：probe / netlist / run / raw / stackup / touchstone）",
  ];
}

function usageError(io: Io, message: string): number {
  io.err(`ERROR: ${message}`);
  io.err("用 `sim --help` 查看用法。");
  return 2;
}

function printJson(io: Io, data: unknown): void {
  io.out(JSON.stringify(data, null, 2));
}

async function probeCommand(
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const parsed = parseArgs(argv, PROBE_OPTIONS);
  if (parsed.positionals.length > 0) return usageError(io, "probe 不接受位置参数");
  const ngspice = await probeNgspice(env, stringValue(parsed, "ngspice") ?? null);
  const pythonPath = stringValue(parsed, "python");
  const python = await probePython(pythonPath ? { ...env, LCEDA_PYTHON: pythonPath } : env);
  const scripts = listSimSidecarScripts();
  if (boolValue(parsed, "json")) {
    printJson(io, {
      ngspice: {
        available: ngspice.available,
        bin: ngspice.bin,
        version: ngspice.version,
        source: ngspice.source,
      },
      python: { available: python.available, command: python.command, version: python.version },
      sidecar: { scripts: scripts.length },
    });
    return 0;
  }
  io.out(
    ngspice.available
      ? `ngspice: ${ngspice.version ?? "未知版本"}（${ngspice.bin}，来源 ${ngspice.source}）`
      : `ngspice: 不可用。${ngspice.hint}`,
  );
  io.out(
    python.available
      ? `python: ${python.version ?? "未知版本"}（${python.command ?? ""}）`
      : `python: 不可用。${python.hint}`,
  );
  io.out(`sidecar 脚本: ${scripts.length} 个（scripts/ 下 .py）`);
  return ngspice.available ? 0 : 1;
}

function netlistCommand(argv: readonly string[], io: Io): number {
  const parsed = parseArgs(argv, NETLIST_OPTIONS);
  const source = parsed.positionals[0];
  if (!source) return usageError(io, "netlist 需要给出 .epro2 或 IR JSON 路径");
  if (parsed.positionals.length > 1) return usageError(io, "netlist 只接受一个输入文件");
  const outDir = path.resolve(stringValue(parsed, "out") ?? "sim-out");
  const config = loadSimConfig(stringValue(parsed, "config") ?? null);
  const asIr = boolValue(parsed, "ir");
  const converted = asIr ? null : fromEpro2File(source, stringValue(parsed, "page") ?? null);
  const simIr = converted ? converted.ir : loadSimIr(source);
  mkdirSync(outDir, { recursive: true });
  const { text, report } = generateNetlist(simIr, buildPinNetTable(simIr), {
    config,
    models: stringValue(parsed, "models") ?? null,
    powerPolicy: stringValue(parsed, "power-policy") ?? null,
    strict: boolValue(parsed, "strict") ? true : undefined,
    allowPartialModel: boolValue(parsed, "allow-partial-model") ? true : undefined,
    deckDir: outDir,
  });
  const deckPath = path.join(outDir, "schematic.cir");
  writeFileSync(deckPath, text, "utf8");
  const reportPath = path.join(outDir, "netlist_report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 1), "utf8");

  const fidelity = report.fidelity.overall_level;
  if (boolValue(parsed, "json")) {
    printJson(io, {
      project: simIr.project,
      page: simIr.page.name ?? null,
      components: simIr.components.filter((comp) => comp.componentType === "part").length,
      nets: simIr.nets.length,
      irWarnings: validateIr(simIr),
      deck: deckPath,
      report: reportPath,
      counts: report.counts,
      groundMapping: report.ground_mapping,
      fidelity: report.fidelity,
      models: report.models,
      excluded: report.excluded,
      warnings: report.warnings,
      errors: report.errors,
    });
    return report.errors.length > 0 && report.strict ? 3 : 0;
  }
  io.out(`工程: ${simIr.project ?? "(未命名)"}  页: ${String(simIr.page.name ?? "-")}`);
  io.out(
    `器件: ${simIr.components.filter((comp) => comp.componentType === "part").length}，网络: ${simIr.nets.length}，fidelity: Level ${fidelity}`,
  );
  io.out(
    `入网表: ${report.counts?.["included"] ?? 0}，排除: ${report.counts?.["excluded"] ?? 0}，` +
      `厂商模型: ${report.counts?.["models"] ?? 0}，电源: ${report.counts?.["power_sources"] ?? 0}`,
  );
  for (const line of report.ground_lines ?? []) io.out(line);
  for (const include of report.includes) io.out(`  include: ${include}`);
  for (const entry of report.excluded) {
    io.out(`  [excluded] ${String(entry["designator"])}: ${String(entry["reason"])}`);
  }
  for (const warning of report.warnings) io.out(`  [warn] ${warning}`);
  for (const error of report.errors) io.out(`  [ERROR] ${error.code}: ${error.message}`);
  io.out("产物:");
  io.out(`  ${deckPath}`);
  io.out(`  ${reportPath}`);
  return report.errors.length > 0 && report.strict ? 3 : 0;
}

async function runCommand(
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const parsed = parseArgs(argv, RUN_OPTIONS);
  const deck = parsed.positionals[0];
  if (!deck) return usageError(io, "run 需要给出网表 .cir 路径");
  if (parsed.positionals.length > 1) return usageError(io, "run 只接受一个网表路径");
  const mode = stringValue(parsed, "mode");
  if (!mode) return usageError(io, "run 需要 --mode（op|tran|ac|dc）");
  const workDir = path.resolve(stringValue(parsed, "out") ?? "sim-out");
  const configPath = stringValue(parsed, "config");
  const config = configPath ? loadSimConfig(configPath) : null;
  let report: NetlistReport | null = null;
  const reportPath = stringValue(parsed, "report");
  if (reportPath) {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as NetlistReport;
  }
  const result = await runSimulation({
    netlist: readNetlistFile(deck),
    mode,
    args: stringValue(parsed, "args") ?? null,
    workDir,
    timeoutSec: numberValue(parsed, "timeout"),
    metrics: (config?.metrics ?? []) as unknown as MetricSpec[],
    netlistReport: report,
    project: stringValue(parsed, "project") ?? null,
    sourceFile: deck,
    config,
    ngspiceBin: stringValue(parsed, "ngspice") ?? null,
    env,
  });

  if (boolValue(parsed, "json")) {
    printJson(io, {
      ok: result.ok,
      returncode: result.returncode,
      timedOut: result.timedOut,
      deck: result.deckPath,
      workDir: result.workDir,
      raws: result.raws.map((raw) => ({
        name: raw.name,
        csv: raw.csv,
        plots: raw.plots,
        error: raw.error,
      })),
      metrics: result.metrics,
      metricErrors: result.metricErrors,
      manifest: result.manifestPath,
      stdoutTail: result.stdoutTail,
    });
    return result.ok ? 0 : 5;
  }
  io.out(
    `ngspice: ${String(result.manifest.ngspice_version ?? "未知")}  返回码: ${result.returncode}`,
  );
  for (const line of result.stdoutTail) io.out(`  ${line}`);
  for (const raw of result.raws) {
    io.out(`raw: ${raw.name}（${raw.plots.length} 个 plot${raw.csv ? `，CSV ${raw.csv}` : ""}）`);
    for (const plot of raw.plots) {
      io.out(`  [${plot.plotname}] ${plot.n_points} 点，变量 ${plot.vars.length} 个`);
    }
    if (raw.error) io.out(`  [raw ERROR] ${raw.error}`);
  }
  for (const [name, metric] of Object.entries(result.metrics)) {
    io.out(`  ${metricSummaryLine(name, metric)}`);
  }
  for (const error of result.metricErrors) {
    io.out(`  [metric!] ${error.metric}: ${error.code} ${error.message}`);
  }
  io.out(`manifest: ${result.manifestPath}`);
  if (result.timedOut) io.out("注意：ngspice 超时被 kill，结果可能不完整。");
  return result.ok ? 0 : 5;
}

function rawCommand(argv: readonly string[], io: Io): number {
  const parsed = parseArgs(argv, RAW_OPTIONS);
  const file = parsed.positionals[0];
  if (!file) return usageError(io, "raw 需要给出 .raw 文件路径");
  if (parsed.positionals.length > 1) return usageError(io, "raw 只接受一个 .raw 路径");
  const plots = parseRawFile(file);
  if (boolValue(parsed, "csv")) {
    const csvPath = path.join(
      path.dirname(file),
      `${path.basename(file).replace(/\.raw$/i, "")}.csv`,
    );
    plotsToCsv(plots, csvPath);
    io.out(`CSV: ${csvPath}`);
  }
  if (boolValue(parsed, "list") || boolValue(parsed, "json")) {
    const summary = plots.map((plot) => ({
      plotname: plot.plotname,
      flags: plot.flags,
      n_points: plot.n_points,
      vars: plot.vars,
    }));
    if (boolValue(parsed, "json")) printJson(io, summary);
    else
      for (const plot of summary)
        io.out(`[${plot.plotname}] ${plot.n_points} 点，变量 ${plot.vars.join(", ")}`);
    return 0;
  }
  for (const plot of plots) {
    io.out(`[${plot.plotname}] ${plot.n_points} 点，变量: ${plot.vars.join(", ")}`);
  }
  return 0;
}

function stackupCommand(argv: readonly string[], io: Io): number {
  const parsed = parseArgs(argv, STACKUP_OPTIONS);
  const [file, layer, widthText, lengthText] = parsed.positionals;
  if (!file) return usageError(io, "stackup 需要给出 stackup.json 路径");
  const width = widthText === undefined ? null : Number.parseFloat(widthText);
  if (widthText !== undefined && !Number.isFinite(width)) {
    return usageError(io, `线宽不是数字: ${widthText}`);
  }
  const length = lengthText === undefined ? null : Number.parseFloat(lengthText);
  if (lengthText !== undefined && !Number.isFinite(length)) {
    return usageError(io, `长度不是数字: ${lengthText}`);
  }
  const stackup = Stackup.fromFile(file);
  const boardThickness = stringValue(parsed, "board-thickness");
  const viaText = stringValue(parsed, "via");
  if (layer && width !== null) {
    const trace = traceParams(stackup, layer, width, length);
    const via = viaText
      ? viaParasitics(parseVia(viaText), stackup, {
          boardThicknessMm: boardThickness ? Number.parseFloat(boardThickness) : null,
        })
      : null;
    if (boolValue(parsed, "json")) {
      printJson(io, { trace, via, stackup: stackup.toDict(), missing: stackup.validate() });
      return 0;
    }
    for (const line of stackupSummaryLines(trace)) io.out(line);
    if (trace.td_ps !== undefined)
      io.out(`TD = ${trace.td_ps} ps（${String(trace.length_mm)} mm）`);
    if (via) {
      io.out(
        `过孔: L=${via.l_nh} nH C=${via.c_pf} pF R=${(via.r_ohm * 1e3).toFixed(3)} mΩ [${via.model_fidelity}]`,
      );
    }
    return 0;
  }
  const missing = stackup.validate();
  if (boolValue(parsed, "json")) {
    printJson(io, { stackup: stackup.toDict(), missing });
    return 0;
  }
  io.out(
    `叠层: ${String(stackup.source ?? "-")}，铜层 ${stackup.layers.length}，介质 ${stackup.dielectrics.length}`,
  );
  for (const layerItem of stackup.layers) {
    io.out(`  ${layerItem.name}  ${layerItem.type}  ${String(layerItem.copper_um ?? "-")} µm`);
  }
  if (missing.length > 0) {
    io.out("缺失项（auto-Z0 前必须补齐）:");
    for (const item of missing) io.out(`  - ${item}`);
  } else {
    io.out("叠层信息完整，可估 Z0/TD。");
  }
  return 0;
}

function parseVia(text: string): { drill_mm?: number; pad_mm?: number; length_mm?: number } {
  const [drill, pad, length] = text.split(",").map((part) => Number.parseFloat(part.trim()));
  return {
    drill_mm: Number.isFinite(drill) ? drill : undefined,
    pad_mm: Number.isFinite(pad) ? pad : undefined,
    length_mm: Number.isFinite(length) ? length : undefined,
  };
}

function touchstoneCommand(argv: readonly string[], io: Io): number {
  const parsed = parseArgs(argv, TOUCHSTONE_OPTIONS);
  const file = parsed.positionals[0];
  if (!file) return usageError(io, "touchstone 需要给出 .sNp 文件路径");
  if (parsed.positionals.length > 1) return usageError(io, "touchstone 只接受一个 .sNp 路径");
  const touchstone = parseTouchstone(file);
  const metrics = touchstoneMetrics(touchstone);
  if (boolValue(parsed, "json")) {
    printJson(io, { summary: touchstone.toDict(), metrics });
    return 0;
  }
  const summary = touchstone.toDict();
  io.out(
    `${String(summary["file"])}: ${String(summary["num_ports"])} 端口，` +
      `${String(summary["n_points"])} 点，${String(summary["f_start_hz"])}..${String(summary["f_stop_hz"])} Hz，` +
      `z0=${String(summary["z0"])} Ω（${String(summary["data_format"]).toUpperCase()} / ${String(summary["freq_unit"])}）`,
  );
  if (touchstone.num_ports === 1) {
    io.out(`|Z|max = ${String(metrics["z_max_ohm"])} Ω @ ${String(metrics["z_max_f"])} Hz`);
    io.out(
      `回损 = ${Number(metrics["return_loss_db"] ?? 0).toFixed(2)} dB（最差 ${Number(metrics["worst_return_loss_db"] ?? 0).toFixed(2)} dB）`,
    );
  } else {
    io.out(
      `插损 = ${Number(metrics["insertion_loss_db"] ?? 0).toFixed(2)} dB @ ${String(metrics["peak_s21_f"])} Hz`,
    );
    io.out(
      `回损 = ${Number(metrics["return_loss_db"] ?? 0).toFixed(2)} dB（最差 ${Number(metrics["worst_return_loss_db"] ?? 0).toFixed(2)} dB）`,
    );
    const bandwidth = metrics["bandwidth_3db"] as { bandwidth?: number } | undefined;
    if (bandwidth?.bandwidth) io.out(`-3 dB 带宽 = ${(bandwidth.bandwidth / 1e6).toFixed(3)} MHz`);
  }
  for (const warning of touchstone.warnings) io.out(`  [warn] ${warning}`);
  return 0;
}

/** 处理 `sim` 子命令；返回进程退出码。 */
export async function runSimCommand(
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    for (const line of simHelp()) io.out(line);
    return 0;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    for (const line of simHelp()) io.out(line);
    return 0;
  }
  try {
    if (command === "probe") return await probeCommand(rest, io, env);
    if (command === "netlist") return netlistCommand(rest, io);
    if (command === "run") return await runCommand(rest, io, env);
    if (command === "raw") return rawCommand(rest, io);
    if (command === "stackup") return stackupCommand(rest, io);
    if (command === "touchstone") return touchstoneCommand(rest, io);
    io.err(`ERROR: 不认识的 sim 子命令：${command}`);
    for (const line of simHelp()) io.out(line);
    return 1;
  } catch (error) {
    if (error instanceof ProjectError) {
      io.err(`ERROR: ${error.message}`);
      return 2;
    }
    if (error instanceof SimError) {
      io.err(`ERROR ${error.code}: ${error.message}`);
      return 2;
    }
    if (error instanceof CliUsageError) return usageError(io, error.message);
    throw error;
  }
}
