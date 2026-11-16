/**
 * ngspice 仿真的 MCP 工具。
 *
 * 分工：`sim_netlist` 只生成网表（纯本地推导），`sim_run` 才执行外部程序；
 * 需要 numpy/scipy/scikit-rf 的 RF / 拟合 / PDN / Monte Carlo 走 `sim_sidecar`。
 *
 * 描述里写入了源仓库踩过的坑（`$` 是 ngspice 行内注释、子电路实例必须 X 开头、
 * tran 步长与最快边沿的关系、AC raw 的 X 轴也是复数对），省得调用方再撞一遍。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { ProjectError } from "../epro2/container.ts";
import { ToolError, defineTool, requireConfirm, type ToolDef } from "../mcp/types.ts";
import { buildPinNetTable, generateNetlist } from "./netlist.ts";
import { fromEpro2File, loadSimIr, validateIr } from "./ir.ts";
import { loadSimConfig } from "./config.ts";
import { probeNgspice } from "./ngspice.ts";
import { computeMetrics } from "./metrics.ts";
import { parseRawFile, plotsToCsv } from "./raw.ts";
import { readNetlistFile, runSimulation } from "./run.ts";
import { probePython, listSimSidecarScripts, runSimSidecar, simSidecarDir } from "./sidecar.ts";
import { Stackup, traceParams, viaParasitics } from "./stackup.ts";
import { parseTouchstone, touchstoneMetrics } from "./touchstone.ts";
import type { MetricSpec, NetlistReport, ViaGeometry } from "./types.ts";
import { SimError } from "./types.ts";

const historyNote =
  "历史产物（.raw/.csv/metrics.json/simulation_manifest.json）用 sim_run，不要指望单点工具返回全部细节。";

function guard<T>(action: () => Promise<T> | T): Promise<T> {
  return (async () => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (error instanceof ProjectError) throw new ToolError("EPRO2_PROJECT_ERROR", error.message);
      if (error instanceof SimError) {
        throw new ToolError(error.code, error.message, error.details);
      }
      throw error;
    }
  })();
}

const metricSpecSchema = z.record(z.string(), z.unknown());

export const probeTool = defineTool({
  name: "sim_probe",
  description:
    "探测仿真环境：ngspice 可执行文件（配置 → NGSPICE_BIN 环境变量 → PATH 的 ngspice_con/ngspice → " +
    "%USERPROFILE%\\.workbuddy\\binaries\\ngspice\\<版本>\\Spice64\\bin）与 Python sidecar 解释器" +
    "（LCEDA_PYTHON → python → py -3）。只读，不跑仿真；本机没装时返回 available=false 与安装提示，" +
    "不会静默降级。",
  input: {
    ngspiceBin: z.string().optional().describe("指定 ngspice 可执行文件路径（覆盖环境探测）"),
    python: z.string().optional().describe("指定 Python 解释器（等价于临时设置 LCEDA_PYTHON）"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ ngspiceBin, python }, ctx) =>
    guard(async () => {
      const env = ctx.env;
      const ngspice = await probeNgspice(env, ngspiceBin ?? null);
      const pythonProbe = await probePython(python ? { ...env, LCEDA_PYTHON: python } : env);
      const scripts = listSimSidecarScripts();
      return {
        ngspice: {
          available: ngspice.available,
          bin: ngspice.bin,
          version: ngspice.version,
          source: ngspice.source,
          checked: ngspice.candidates.map((candidate) => ({
            bin: candidate.bin,
            source: candidate.source,
            ok: candidate.ok,
            version: candidate.version,
          })),
          hint: ngspice.hint,
        },
        python: {
          available: pythonProbe.available,
          command: pythonProbe.command,
          version: pythonProbe.version,
          source: pythonProbe.source,
          hint: pythonProbe.hint,
        },
        sidecar: {
          dir: simSidecarDir(),
          scriptCount: scripts.length,
          scripts: scripts.slice(0, 200),
          requirements: "requirements-core.txt / requirements-rf.txt / requirements-em.txt",
        },
        note:
          "sidecar 脚本依赖 numpy/scipy/scikit-rf；ngspice 只认 batch 模式（-b），" +
          "仿真产物都落在 sim_run 的 workDir 里。",
      };
    }),
});

export const netlistTool = defineTool({
  name: "sim_netlist",
  description:
    "把 .epro2 工程（或已导出的 IR JSON）转成 ngspice 网表与 netlist_report.json，写到 outDir：" +
    "R/C/L 直接出实例，Q/D/M 查离散模型库、查不到用泛化模型，U/IC/X 必须有 model_map 里可验证的 " +
    ".SUBCKT/.MODEL 引脚映射（否则排除；strict 下报 UNMAPPED_IC），电源网标按 power_policy " +
    "auto（按网名补理想源并告警）或 explicit（只认真实源与 external_supplies）。" +
    "地策略默认只把 GND/GROUND/0 映射到节点 0，AGND/DGND 保持独立，要合并必须在 ground_aliases 显式声明。" +
    "注意：0Ω 电阻会写成 1mΩ（ngspice 不接受零阻值）；子电路实例名强制 X 开头；" +
    "虚拟节点 $X 落 deck 时写成 __X（$ 是 ngspice 行内注释符）。",
  input: {
    file: z.string().optional().describe(".epro2 文件路径（与 ir 二选一）"),
    ir: z.string().optional().describe("已有 IR JSON 路径（与 file 二选一）"),
    page: z.string().optional().describe("只取指定原理图页（页名或 uuid），仅 file 模式有效"),
    outDir: z.string().min(1).describe("产物目录，写 schematic.cir 与 netlist_report.json"),
    configPath: z
      .string()
      .optional()
      .describe("sim_config.json 路径（models / ground_aliases / 电源策略）"),
    models: z.string().optional().describe("model_map.json 路径（覆盖配置）"),
    powerPolicy: z.enum(["auto", "explicit"]).optional().describe("电源策略，覆盖配置"),
    strict: z.boolean().optional().describe("拓扑可疑直接报错（UNMAPPED_IC 等）"),
    allowPartialModel: z.boolean().optional().describe("pin mapping 不完整时降级为警告"),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
  handler: ({
    file,
    ir,
    page,
    outDir,
    configPath,
    models,
    powerPolicy,
    strict,
    allowPartialModel,
  }) =>
    guard(async () => {
      if (!file && !ir)
        throw new ToolError("SIM_INPUT_REQUIRED", "必须给 file（.epro2）或 ir（IR JSON）");
      if (file && ir) throw new ToolError("SIM_INPUT_INVALID", "file 与 ir 只能给一个");
      const config = loadSimConfig(configPath ?? null);
      let simIr;
      let pageLabel: string | null = null;
      let pages: unknown[] | null = null;
      if (file) {
        const converted = fromEpro2File(file, page ?? null);
        simIr = converted.ir;
        pageLabel = converted.ir.page.name ?? null;
        pages = converted.pages;
      } else {
        simIr = loadSimIr(ir as string);
        pageLabel = (simIr.page.name as string | undefined) ?? null;
      }
      const deckDir = path.resolve(outDir);
      mkdirSync(deckDir, { recursive: true });
      const { text, report } = generateNetlist(simIr, buildPinNetTable(simIr), {
        config,
        models: models ?? null,
        powerPolicy: powerPolicy ?? null,
        strict: strict ?? undefined,
        allowPartialModel: allowPartialModel ?? undefined,
        deckDir,
      });
      const deckPath = path.join(deckDir, "schematic.cir");
      writeFileSync(deckPath, text, "utf8");
      const reportPath = path.join(deckDir, "netlist_report.json");
      writeFileSync(reportPath, JSON.stringify(report, null, 1), "utf8");
      return {
        project: simIr.project,
        page: pageLabel,
        pages,
        components: simIr.components.filter((comp) => comp.componentType === "part").length,
        nets: simIr.nets.length,
        irWarnings: validateIr(simIr),
        deck: deckPath,
        report: reportPath,
        counts: report.counts,
        powerPolicy: report.power_policy,
        strict: report.strict,
        groundMapping: report.ground_mapping,
        groundLines: report.ground_lines ?? [],
        includes: report.includes,
        fidelity: report.fidelity,
        models: report.models.map((model) => ({
          designator: model["designator"],
          type: model["type"],
          status: model["status"],
          matchedBy: model["matched_by"],
          source: model["file_display"],
        })),
        excluded: report.excluded.map((entry) => ({
          designator: entry["designator"],
          reason: entry["reason"],
        })),
        errors: report.errors,
        warnings: report.warnings,
        note: `网表 ${deckPath} 未注入分析块；用 sim_run 传入该路径即可生成 deck 并执行。${historyNote}`,
      };
    }),
});

export const runTool = defineTool({
  name: "sim_run",
  description:
    "执行一次 ngspice 仿真：把网表（未注入 .control 时自动生成 deck）写到 workDir/deck.cir，跑 " +
    "`ngspice -b`，解析所有 *.raw（ASCII 与二进制都支持，AC 的 frequency 也按复数对解），按 metrics " +
    "规格算指标，并写 metrics.json 与 simulation_manifest.json。返回 raw/csv 文件、指标、manifest 摘要与 " +
    "stdout 尾部。tran 的步长必须远小于最快边沿（300 ps 边沿配 tran 100p 会陷收敛风暴，改 10p 才出结果）；" +
    "ngspice 非零退出只记录在 returncode 里，不会被当成没跑过。",
  input: {
    deck: z.string().min(1).describe("网表文件路径（schematic.cir / 已带 .control 的 deck 都行）"),
    mode: z
      .enum(["op", "tran", "ac", "dc"])
      .describe("分析类型（已带 .control 的 deck 只用于挑选指标 plot）"),
    args: z
      .string()
      .optional()
      .describe("分析参数，如 tran 的 '10p 600n'、ac 的 'dec 100 10 100meg'"),
    workDir: z.string().min(1).describe("工作目录（deck/raw/csv/metrics/manifest 都落这里）"),
    timeoutSec: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("超时秒数（默认 600，超时会 kill）"),
    metrics: z
      .array(metricSpecSchema)
      .optional()
      .describe("指标规格数组（见 SKILL.md Metrics 一节）"),
    netlistReport: z.string().optional().describe("netlist_report.json 路径，写进 manifest"),
    project: z.string().optional().describe("工程名（manifest 用）"),
    ngspiceBin: z.string().optional().describe("指定 ngspice 可执行文件"),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: ({
    deck,
    mode,
    args,
    workDir,
    timeoutSec,
    metrics,
    netlistReport,
    project,
    ngspiceBin,
  }) =>
    guard(async () => {
      const netlist = readNetlistFile(deck);
      let report: NetlistReport | null = null;
      if (netlistReport) {
        try {
          report = JSON.parse(readFileSync(netlistReport, "utf8")) as NetlistReport;
        } catch {
          throw new ToolError("SIM_REPORT_INVALID", `netlist_report 读不出来: ${netlistReport}`);
        }
      }
      const result = await runSimulation({
        netlist,
        mode,
        args: args ?? null,
        workDir,
        timeoutSec: timeoutSec ?? undefined,
        metrics: (metrics ?? []) as unknown as MetricSpec[],
        netlistReport: report,
        project: project ?? null,
        sourceFile: deck,
        ngspiceBin: ngspiceBin ?? null,
      });
      return {
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
        metricsPath: result.metricsPath,
        manifest: {
          path: result.manifestPath,
          ngspice: result.manifest.ngspice_version,
          fidelity: result.manifest.fidelity,
          groundMapping: result.manifest.ground_mapping,
          powerSources: result.manifest.power_sources,
          excluded: result.manifest.excluded_components,
          warnings: result.manifest.warnings,
          errors: result.manifest.errors,
        },
        stdoutTail: result.stdoutTail,
        note: `完整 manifest 见 ${result.manifestPath}；历史 raw/CSV 都在 ${result.workDir}。`,
      };
    }),
});

export const metricsTool = defineTool({
  name: "sim_metrics",
  description:
    "从一个 ngspice raw 文件算可量化指标（不跑仿真）：tran_stats（最大/最小/峰峰/过冲/下冲/上升下降，" +
    "DC 电源轨自动切成 rail 只报纹波与偏差）、threshold_crossings（振铃聚类）、time_delta（skew）、" +
    "impedance（|Z(f)| 与谐振峰）、fft_harmonics。节点名可写 $CLK / CLK / 3V3（自动兼容 N_3V3 / v(...)），" +
    "电流写 I(V1)。AC raw 的 X 轴也是复数对，本工具已按 [re, im] 拆解。",
  input: {
    raw: z.string().min(1).describe("ngspice raw 文件路径"),
    metrics: z.array(metricSpecSchema).min(1).describe("指标规格数组"),
    mode: z
      .enum(["op", "tran", "ac", "dc"])
      .optional()
      .describe("分析类型（决定挑实数还是复数 plot）"),
    csv: z.string().optional().describe("可选：把解析结果另存成 CSV 的路径"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ raw, metrics, mode, csv }) =>
    guard(() => {
      const plots = parseRawFile(raw);
      const result = computeMetrics(plots, metrics as MetricSpec[], mode ?? null);
      if (csv) plotsToCsv(plots, csv);
      return {
        raw,
        csv: csv ?? null,
        plots: plots.map((plot) => ({
          plotname: plot.plotname,
          flags: plot.flags,
          vars: plot.vars,
          n_points: plot.n_points,
        })),
        metrics: result.metrics,
        errors: result.errors,
      };
    }),
});

export const stackupTool = defineTool({
  name: "sim_stackup",
  description:
    "叠层与传输线参数解析估计：Hammerstad-Jensen 微带线（外层）+ IPC-2141 带状线（内层），" +
    "给出 Z0 / εeff / TD（ps 与 ps/mm），精度一律标 ANALYTIC_ESTIMATE（±10% 量级，不能当阻抗控制验收依据）；" +
    "给 via 参数时按 ENGINEERING_ESTIMATE 估过孔 R/L/C（反焊盘按焊盘+间隙估计）。" +
    "缺 εr 或铜厚时明确报 STACKUP_INCOMPLETE，绝不默认 FR4 εr=4.5。",
  input: {
    file: z.string().optional().describe("stackup.json 路径（layers / dielectrics）"),
    layers: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe("内联铜层：{name, type: signal|plane, copper_um}"),
    dielectrics: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe("内联介质：{between: [a,b], thickness_mm, er, loss_tangent}"),
    layer: z.string().optional().describe("要估参数的铜层名（给 widthMm 时必需）"),
    widthMm: z.number().positive().optional().describe("走线宽度 mm"),
    lengthMm: z.number().positive().optional().describe("走线长度 mm（给了就算 TD）"),
    boardThicknessMm: z.number().positive().optional().describe("板厚 mm（过孔长度兜底）"),
    via: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("过孔参数：{id, drill_mm, pad_mm, length_mm}"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ file, layers, dielectrics, layer, widthMm, lengthMm, boardThicknessMm, via }) =>
    guard(() => {
      if (!file && !layers) {
        throw new ToolError("SIM_STACKUP_INPUT_REQUIRED", "必须给 file（stackup.json）或 layers");
      }
      const stackup = file
        ? Stackup.fromFile(file)
        : new Stackup({
            layers: layers as unknown as {
              name?: string;
              type?: string;
              copper_um?: number | null;
            }[],
            dielectrics: dielectrics as unknown as {
              between?: string[];
              thickness_mm?: number | null;
              er?: number | null;
            }[],
          }).normalize();
      const result: Record<string, unknown> = {
        stackup: stackup.toDict(),
        missing: stackup.validate(),
        warnings: stackup.warnings,
      };
      if (layer && widthMm) {
        const trace = traceParams(stackup, layer, widthMm, lengthMm ?? null);
        result["trace"] = trace;
        result["summary"] =
          `${layer}: Z0=${trace.z0_ohm} Ω, εeff=${trace.eps_eff}, ` +
          `td=${trace.td_ps_per_mm} ps/mm` +
          (trace.td_ps ? `, TD=${trace.td_ps} ps` : "");
      }
      if (via) {
        result["via"] = viaParasitics(via as unknown as ViaGeometry, stackup, {
          boardThicknessMm: boardThicknessMm ?? null,
        });
      }
      result["fidelity"] =
        "ANALYTIC_ESTIMATE（解析估计，±10% 量级；过孔部分 ENGINEERING_ESTIMATE）";
      return result;
    }),
});

export const touchstoneTool = defineTool({
  name: "sim_touchstone",
  description:
    "解析 Touchstone 文件（.s1p/.s2p/.sNp）并给出摘要：端口数、频点范围、z0，按 RI/MA/DB 格式与 " +
    "Hz/kHz/MHz/GHz 单位换算；2 端口给插损（-max S21 dB）、回损（-min S11 dB）与 -3 dB 带宽，" +
    "1 端口给 |Z| 极值与回损。支持 `!` 注释、`#` 选项行与折行；Y/Z/H/G 参数格式明确报错而不是猜。",
  input: {
    file: z.string().min(1).describe(".sNp 文件路径"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ file }) =>
    guard(() => {
      const touchstone = parseTouchstone(file);
      const metrics = touchstoneMetrics(touchstone);
      const summaryMetrics: Record<string, unknown> = {};
      for (const key of [
        "file",
        "num_ports",
        "n_points",
        "z0",
        "f_start_hz",
        "f_stop_hz",
        "insertion_loss_db",
        "peak_s21_db",
        "peak_s21_f",
        "return_loss_db",
        "worst_return_loss_db",
        "z_max_ohm",
        "z_max_f",
        "z_min_ohm",
        "bandwidth_3db",
        "is_reciprocal",
      ]) {
        if (metrics[key] !== undefined) summaryMetrics[key] = metrics[key];
      }
      const resonances = metrics["resonances"] as { f: number; value: number }[] | undefined;
      const notches = metrics["notches"] as { f: number; value: number }[] | undefined;
      return {
        summary: touchstone.toDict(),
        metrics: summaryMetrics,
        resonances: (resonances ?? []).slice(0, 20),
        notches: (notches ?? []).slice(0, 20),
        comments: touchstone.comments.slice(0, 20),
        warnings: touchstone.warnings,
        note:
          "完整 S 参数曲线请用 sim_sidecar 调 rf_network.py / sparam_metrics.py" +
          `（需 scikit-rf）。${historyNote}`,
      };
    }),
});

export const sidecarTool = defineTool({
  name: "sim_sidecar",
  description:
    "执行 assets/sidecar/ngspice-sim/scripts 下的 Python sidecar 脚本（只认脚本名，不接受路径）；" +
    "用于依赖 numpy/scipy/scikit-rf 的 RF 网络、vector fitting、de-embedding、PDN 多端口、Monte Carlo、" +
    "参数拟合、实测相关，以及 override/behavioral/IBIS/pcb_geometry 等本轮未移植的规则密集模块。" +
    "属执行外部程序：必须 confirm:true；解释器按 LCEDA_PYTHON → python → py -3 探测，缺失时报 " +
    "PY_SIDECAR_UNAVAILABLE。用 sim_probe 可先看脚本清单与依赖提示。",
  input: {
    script: z.string().min(1).describe("sidecar 脚本文件名（如 rf_network.py）"),
    args: z.array(z.string()).optional().describe("传给脚本的参数数组"),
    workDir: z.string().optional().describe("工作目录（默认当前进程目录）"),
    timeoutSec: z.number().int().positive().optional().describe("超时秒数（默认 600）"),
    confirm: z.boolean().optional().describe("执行外部程序的确认位，必须为 true"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  handler: ({ script, args, workDir, timeoutSec, confirm }, ctx) =>
    guard(async () => {
      requireConfirm(confirm, {
        script,
        args: args ?? [],
        workDir: workDir ?? process.cwd(),
        candidates: listSimSidecarScripts().slice(0, 50),
        note: "sidecar 脚本会读写文件并可能长时间占用 CPU；确认脚本与参数后用 confirm:true 重试。",
      });
      const result = await runSimSidecar(script, args ?? [], {
        cwd: workDir ?? undefined,
        timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined,
        env: ctx.env ?? process.env,
      });
      return {
        script: result.script,
        python: result.python,
        code: result.code,
        ok: result.ok,
        timedOut: result.timedOut,
        stdout: result.stdout.slice(-20_000),
        stderr: result.stderr.slice(-20_000),
        cwd: workDir ?? process.cwd(),
      };
    }),
});

export const simTools: ToolDef[] = [
  probeTool,
  netlistTool,
  runTool,
  metricsTool,
  stackupTool,
  touchstoneTool,
  sidecarTool,
];
