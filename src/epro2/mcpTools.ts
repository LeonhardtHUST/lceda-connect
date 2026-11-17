/**
 * `.epro2` 工程解析的 MCP 工具。
 *
 * 大结果只回摘要与计数，完整数据用 epro2_report 的 outDir 落盘（结果超过
 * 64 KiB 会被 MCP 层截断）。PCB 侧 PAD_NET 是权威网表，原理图侧网表用于交叉验证。
 */
import { z } from "zod";

import { ToolError, defineTool, type ToolDef } from "../mcp/types.ts";
import {
  analyzeSummary,
  checkConsistency,
  collect,
  inspectProject,
  runDiff,
  runSingle,
} from "./analyze.ts";
import { ProjectError } from "./container.ts";
import type { SchematicIr } from "./contract.ts";
import { compare, summarize } from "./diff.ts";

async function projectGuard<T>(action: () => T | Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ProjectError) {
      throw new ToolError(`EPRO2_${error.code}`, error.message);
    }
    throw error;
  }
}

const fileSchema = z.string().min(1).describe("本地 .epro2 文件路径");

function pageBrief(ir: SchematicIr): Record<string, unknown> {
  const names = ir.nets.map((net) => net.name);
  return {
    uuid: ir.page.uuid,
    name: ir.page.name,
    label: ir.page.label ?? ir.page.name,
    components: ir.components.length,
    wires: ir.wires.length,
    nets: ir.nets.length,
    namedNets: ir.nets.filter((net) => net.named).length,
    netNames: names.slice(0, 200),
    netNamesTruncated: names.length > 200,
    conflicts: ir.nets.filter((net) => net.conflicts.length > 0).length,
  };
}

export const inspectTool = defineTool({
  name: "epro2_inspect",
  description:
    "检查 .epro2 工程容器与记录流：工程标题、记录行数、文档构成（SYMBOL/DEVICE/FOOTPRINT/SCH_PAGE/PCB）、" +
    "库表数量与可用原理图页。只读，不生成产物；需要完整网表或几何时用 epro2_report。",
  input: { file: fileSchema },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ file }) =>
    projectGuard(() => {
      const info = inspectProject(file);
      const docCounts: Record<string, number> = {};
      for (const doc of info.documents) {
        const key = doc.docType ?? "null";
        docCounts[key] = (docCounts[key] ?? 0) + 1;
      }
      return {
        project: info.title,
        source: info.source,
        epru: info.epru,
        recordLines: info.recordLines,
        recordUnparsed: info.recordUnparsed,
        members: info.members.length,
        documents: docCounts,
        library: info.library,
        pages: info.documents
          .filter((doc) => doc.docType === "SCH_PAGE" || doc.docType === "SIMULATION")
          .map((doc) => ({ uuid: doc.uuid, name: doc.title || "(未命名)", docType: doc.docType })),
        projectMeta: info.projectMeta,
      };
    }),
});

export const schematicNetsTool = defineTool({
  name: "epro2_schematic_nets",
  description:
    "从 .epro2 重建原理图侧网络（引脚坐标 + 导线几何 + 并查集），返回逐页网络数量、网络名与冲突计数。" +
    "page 可选，传页名或 uuid；不传则解析全部原理图页。大工程的完整引脚成员表请用 epro2_report " +
    "落盘后读 nets.json。原理图坐标是逻辑坐标，不做 mm 换算。",
  input: {
    file: fileSchema,
    page: z.string().optional().describe("只解析指定页（页名或 uuid）"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ file, page }) =>
    projectGuard(() => {
      const collected = collect(file, page ?? null);
      return {
        project: collected.proj.title,
        pages: collected.artifacts.pages_ir.map(pageBrief),
        warnings: collected.artifacts.pages_ir.flatMap((ir) => ir.warnings),
        note: "完整网络成员表与同一页的引脚坐标见 epro2_report 的 nets.json / schematic_<页>.json。",
      };
    }),
});

export const pcbNetlistTool = defineTool({
  name: "epro2_pcb_netlist",
  description:
    "导出 .epro2 的 PCB 侧权威网表：只认带 Designator 的元件，PAD_NET 按 (元件, 焊盘) 取最大 ticket，" +
    "焊盘号先按符号 Pin Number 匹配、找不到才用焊盘 id 兜底。返回行数、剔除告警与前 200 行；" +
    "完整 CSV 用 epro2_report 落盘 pcb_netlist.csv。焊盘号为封装物理引脚号，不是符号引脚 id。",
  input: { file: fileSchema },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ file }) =>
    projectGuard(() => {
      const collected = collect(file);
      const rows = collected.artifacts.pcb_rows;
      return {
        project: collected.proj.title,
        rowCount: rows.length,
        designators: [...new Set(rows.map((row) => row.designator))].sort(),
        warnings: collected.artifacts.pcb_warnings,
        truncated: rows.length > 200,
        rows: rows.slice(0, 200),
        note: "完整网表见 epro2_report 的 pcb_netlist.csv（UTF-8 BOM，Excel 可直接打开）。",
      };
    }),
});

export const pcbGeometryTool = defineTool({
  name: "epro2_pcb_geometry",
  description:
    "提取 .epro2 的 PCB 几何：板框（mil/mm）、铜层声明与实际引用、叠层、按网络汇总的走线、逐段端点、" +
    "过孔孔径分布与焊盘绝对坐标。PCB 坐标单位是 mil（1 mil = 0.0254 mm），与 CANVAS.unit 写的 mm 无关。" +
    "返回摘要与前 20 个走线网络；完整数据用 epro2_report 落盘 pcb_geometry.json。",
  input: { file: fileSchema },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ file }) =>
    projectGuard(() => {
      const collected = collect(file);
      const geo = collected.artifacts.geometry;
      return {
        project: collected.proj.title,
        unit: geo.unit,
        outline: geo.outline,
        outlines: geo.outlines.slice(0, 50),
        outlinesTruncated: geo.outlines.length > 50,
        copperLayers: {
          declared: geo.copper_layers_declared ?? 0,
          used: geo.copper_layers_used ?? 0,
        },
        stackupCount: geo.stackup.length,
        traces: {
          count: geo.traces.length,
          totalLengthMm:
            Math.round(geo.traces.reduce((sum, trace) => sum + trace.length_mm, 0) * 10) / 10,
          top: geo.traces.slice(0, 20),
        },
        segments: geo.segment_count ?? 0,
        pads: geo.pad_count ?? 0,
        vias: geo.vias.length,
        viaHoleHistogram: geo.via_hole_histogram ?? {},
        warnings: geo.warnings,
        note: "逐段端点、逐焊盘坐标与完整叠层见 epro2_report 的 pcb_geometry.json。",
      };
    }),
});

export const crosscheckTool = defineTool({
  name: "epro2_crosscheck",
  description:
    "按 (位号, 引脚号) 交叉比对原理图侧网络与 PCB 侧权威网表，返回可比引脚数、不一致明细、" +
    "未命名跳过、重复位号、跨页重复位号与重复引脚键统计。只用两侧都有正式网络名的引脚；" +
    "N$n 临时网络不计入比对。",
  input: { file: fileSchema, page: z.string().optional().describe("只解析指定页（页名或 uuid）") },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ file, page }) =>
    projectGuard(() => {
      const collected = collect(file, page ?? null);
      const { mismatches, stats } = checkConsistency(collected.artifacts);
      return {
        project: collected.proj.title,
        stats,
        mismatches: mismatches.slice(0, 200),
        mismatchesTruncated: mismatches.length > 200,
        warnings: collected.artifacts.pcb_warnings,
      };
    }),
});

export const reportTool = defineTool({
  name: "epro2_report",
  description:
    "全量解析 .epro2 并把产物写到 outDir（必填）：meta.json、schematic_<页>.json、nets.json、" +
    "pcb_netlist.csv、pcb_geometry.json、report.md。返回摘要、一致性统计与文件路径。" +
    "PCB 侧 PAD_NET 是权威网表，原理图侧仅做交叉验证；坐标单位：PCB 为 mil（另给 mm），原理图为逻辑坐标。",
  input: {
    file: fileSchema,
    outDir: z.string().min(1).describe("产物目录，不存在时自动创建；同名文件会被覆盖"),
    page: z.string().optional().describe("只解析指定页（页名或 uuid）"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  handler: async ({ file, outDir, page }, ctx) =>
    projectGuard(async () => {
      const safeOutDir = await ctx.resolveWritePath(outDir);
      const run = runSingle(file, safeOutDir, page ?? null);
      return analyzeSummary(run);
    }),
});

export const diffTool = defineTool({
  name: "epro2_diff",
  description:
    "比较两版 .epro2 的语义差异：元素级新增/删除/变更（过滤 ticket、客户端 GUID、铺铜重灌等噪声）" +
    "与按 (位号, 焊盘号) 比对的网表差异。max/min 等几何字段不会被当噪声剔除。" +
    "给 outDir 时写出 diff.json / diff.md；不给则只返回摘要。",
  input: {
    oldFile: fileSchema.describe("旧版 .epro2"),
    newFile: fileSchema.describe("新版 .epro2"),
    outDir: z.string().optional().describe("产物目录；给出时写出 diff.json 与 diff.md"),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
  handler: async ({ oldFile, newFile, outDir }, ctx) =>
    projectGuard(async () => {
      if (outDir) {
        const run = runDiff(oldFile, newFile, await ctx.resolveWritePath(outDir));
        return {
          summary: run.summary,
          files: run.files,
          elements: {
            added: run.result.elements.added.length,
            removed: run.result.elements.removed.length,
            changed: run.result.elements.changed.length,
            noiseFiltered: run.result.elements.noise_filtered,
          },
          netlist: {
            rowsOld: run.result.netlist_rows.old,
            rowsNew: run.result.netlist_rows.new,
            added: run.result.netlist.added.length,
            removed: run.result.netlist.removed.length,
            changed: run.result.netlist.changed.length,
          },
        };
      }
      const result = compare(oldFile, newFile);
      return {
        summary: summarize(result),
        elements: {
          added: result.elements.added.length,
          removed: result.elements.removed.length,
          changed: result.elements.changed.length,
          noiseFiltered: result.elements.noise_filtered,
          changedSample: result.elements.changed.slice(0, 50),
        },
        netlist: {
          rowsOld: result.netlist_rows.old,
          rowsNew: result.netlist_rows.new,
          added: result.netlist.added.length,
          removed: result.netlist.removed.length,
          changed: result.netlist.changed.slice(0, 50),
        },
      };
    }),
});

export const epro2Tools: ToolDef[] = [
  inspectTool,
  schematicNetsTool,
  pcbNetlistTool,
  pcbGeometryTool,
  crosscheckTool,
  reportTool,
  diffTool,
];
