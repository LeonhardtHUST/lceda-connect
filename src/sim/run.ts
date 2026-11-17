/**
 * 仿真执行器：deck → ngspice → raw → 指标 → manifest
 * （源仓库 scripts/sim_exec.py 的单次分析路径；sweep / pdn / montecarlo 属 sidecar）。
 *
 * 架构边界：EasyEDA = CAD 数据源；ngspice = 仿真引擎；本模块 = 编排层。
 * 工作目录由调用方给出，所有产物（deck.cir / *.raw / *.csv / metrics.json /
 * simulation_manifest.json）都落在工作目录里。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { RunResult } from "../core/exec.ts";
import { buildDeck, hasControlBlock } from "./deck.ts";
import {
  NGSPICE_RUN_TIMEOUT_MS,
  NgspiceError,
  findNgspiceSync,
  getNgspiceVersion,
  probeNgspice,
  runNgspiceBatch,
} from "./ngspice.ts";
import { buildManifest, fileHash, writeManifest } from "./manifest.ts";
import { computeMetrics } from "./metrics.ts";
import { parseRawFile, plotsToCsv } from "./raw.ts";
import type {
  MetricErrorEntry,
  MetricSpec,
  NetlistReport,
  SimConfig,
  SimManifest,
  SimRawFile,
  SimRunRecord,
} from "./types.ts";

export type SimDeckRunner = (
  bin: string,
  deckPath: string,
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<RunResult>;

export interface RunSimulationOptions {
  /** 未经 .control 的网表文本；已经带 .control 时按现成 deck 直接跑。 */
  netlist: string;
  /** op | tran | ac | dc | custom */
  mode: string;
  args?: string | null;
  workDir: string;
  timeoutSec?: number;
  metrics?: readonly MetricSpec[];
  netlistReport?: NetlistReport | null;
  project?: string | null;
  /** 源文件（.epro2 / netlist.cir），用于 manifest 的 source_hash。 */
  sourceFile?: string | null;
  config?: Partial<SimConfig> | null;
  ngspiceBin?: string | null;
  env?: NodeJS.ProcessEnv;
  /** 测试注入：默认走 ngspice -b。 */
  runner?: SimDeckRunner;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, message: string) => void | Promise<void>;
}

export interface RunSimulationResult {
  ok: boolean;
  returncode: number;
  timedOut: boolean;
  deckPath: string;
  workDir: string;
  stdoutTail: string[];
  raws: SimRawFile[];
  plots: number;
  metrics: Record<string, Record<string, unknown>>;
  metricErrors: MetricErrorEntry[];
  metricsPath: string | null;
  manifest: SimManifest;
  manifestPath: string;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * 跑一次仿真。ngspice 不存在时抛 NgspiceError("NGSPICE_NOT_FOUND")；
 * ngspice 返回非零只记在结果里（"跑过了但失败"与"没跑"要能区分）。
 */
export async function runSimulation(options: RunSimulationOptions): Promise<RunSimulationResult> {
  const progress = options.onProgress;
  await progress?.(0, 4, "写 deck");
  const env = options.env ?? process.env;
  const workDir = path.resolve(options.workDir);
  mkdirSync(workDir, { recursive: true });

  const deckText = hasControlBlock(options.netlist)
    ? options.netlist
    : buildDeck(options.netlist, options.mode, options.args ?? null);
  const deckPath = path.join(workDir, "deck.cir");
  writeFileSync(deckPath, deckText, "utf8");

  let bin = options.ngspiceBin ?? null;
  if (!bin) {
    bin = findNgspiceSync(env, (options.config?.["ngspice_bin"] as string | undefined) ?? null);
  }
  const injected = options.runner !== undefined;
  if (!bin) {
    if (injected) {
      // 测试注入执行器时不需要真的装 ngspice；版本留空。
      bin = "fake-ngspice";
    } else {
      const probe = await probeNgspice(env);
      throw new NgspiceError("NGSPICE_NOT_FOUND", probe.hint);
    }
  }
  const version = bin === "fake-ngspice" ? null : await getNgspiceVersion(bin);

  const runner = options.runner ?? runNgspiceBatch;
  const runResult = await runner(bin, deckPath, {
    cwd: workDir,
    timeoutMs: options.timeoutSec ? options.timeoutSec * 1000 : NGSPICE_RUN_TIMEOUT_MS,
    env,
    signal: options.signal,
  });
  await progress?.(2, 4, "运行 ngspice");
  writeFileSync(path.join(workDir, "stdout.txt"), runResult.stdout, "utf8");
  writeFileSync(path.join(workDir, "stderr.txt"), runResult.stderr, "utf8");

  const raws: SimRawFile[] = [];
  await progress?.(3, 4, "解析 raw");
  const rawErrors: string[] = [];
  const plots = [];
  for (const name of readdirSync(workDir).sort()) {
    if (!name.toLowerCase().endsWith(".raw")) continue;
    const filePath = path.join(workDir, name);
    try {
      const parsed = parseRawFile(filePath);
      plots.push(...parsed);
      const csvPath = path.join(workDir, `${name.slice(0, -4)}.csv`);
      plotsToCsv(parsed, csvPath);
      raws.push({
        name,
        path: filePath,
        csv: csvPath,
        plots: parsed.map((plot) => ({
          plotname: plot.plotname,
          vars: plot.vars,
          n_points: plot.n_points,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rawErrors.push(`${name}: ${message}`);
      raws.push({ name, path: filePath, csv: null, plots: [], error: message });
    }
  }

  const metricSpecs = options.metrics ?? [];
  await progress?.(4, 4, "计算指标");
  const metricResult = computeMetrics(plots, metricSpecs, options.mode);
  const metricsPath =
    Object.keys(metricResult.metrics).length > 0 ? path.join(workDir, "metrics.json") : null;
  if (metricsPath) {
    writeFileSync(metricsPath, JSON.stringify(metricResult.metrics, null, 1), "utf8");
  }

  const record: SimRunRecord = {
    id: "single",
    index: 1,
    params: {},
    returncode: runResult.code,
    dir: ".",
    raw: raws.map((raw) => raw.name),
    metrics: metricResult.metrics,
    metric_errors: metricResult.errors,
  };
  if (rawErrors.length > 0) record.raw_errors = rawErrors;

  const manifest = buildManifest(
    options.netlistReport ?? null,
    { mode: options.mode, args: options.args ?? null, sweep: options.config?.["sweep"] ?? null },
    {
      project: options.project ?? null,
      sourceHash: options.sourceFile ? fileHash(options.sourceFile) : hashText(options.netlist),
      ngspice: version,
      workdir: workDir,
      runs: [record],
    },
  );
  manifest["deck"] = deckPath;
  manifest["ngspice_bin"] = bin;
  manifest["timedOut"] = runResult.timedOut;
  if (rawErrors.length > 0) manifest["raw_errors"] = rawErrors;
  const manifestPath = writeManifest(manifest, path.join(workDir, "simulation_manifest.json"));

  const tail = `${runResult.stdout}\n${runResult.stderr}`
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-25);

  return {
    ok: runResult.code === 0 && !runResult.timedOut,
    returncode: runResult.code,
    timedOut: runResult.timedOut,
    deckPath,
    workDir,
    stdoutTail: tail,
    raws,
    plots: plots.length,
    metrics: metricResult.metrics,
    metricErrors: metricResult.errors,
    metricsPath,
    manifest,
    manifestPath,
  };
}

/** 读一份网表文件（CLI / MCP 共用）。 */
export function readNetlistFile(file: string): string {
  return readFileSync(file, "utf8");
}
