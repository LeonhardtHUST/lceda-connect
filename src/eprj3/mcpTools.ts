/**
 * `.eprj3` 工程的 MCP 工具。
 *
 * 记录解析、归约、格式门与网表在 TS 层（`records.ts` / `validate.ts` /
 * `netlist.ts`）；建工程、原子编辑与门禁转交 sidecar（`sidecar.ts`）。
 *
 * 写操作（build / edit）默认不执行，要 `confirm: true`；build 先跑 `dryRun`
 * 预览。坐标单位一律 mil。原理图摆放与 PCB 预布局由本技能负责，铜皮、铺铜和
 * 最终布线由嘉立创EDA客户端完成（sidecar `eda.js`）。
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { ToolError, defineTool, requireConfirm, type ToolDef } from "../mcp/types.ts";
import {
  documentFiles,
  inspectEprj3Project,
  loadEprj3Project,
  resolveProjectPath,
  type Eprj3Project,
} from "./project.ts";
import { readDocumentFile, reduceDocSection, type Eprj3Record } from "./records.ts";
import { netlistProject } from "./netlist.ts";
import {
  EPRJ3_EDIT_OPS,
  EPRJ3_GATES,
  EPRJ3_GATE_NAMES,
  eprj3GateArgs,
  isEprj3EditOp,
  runEprj3Script,
  type Eprj3Gate,
  type Eprj3ScriptResult,
} from "./sidecar.ts";
import { validateEprj3Project } from "./validate.ts";

function guard<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof Error && error.name === "Eprj3ProjectError") {
      throw new ToolError("EPRJ3_PROJECT_ERROR", error.message);
    }
    throw error;
  }
}

const dirSchema = z.string().min(1).describe("工程目录（.eprj3 文件夹工程）");

function recordOut(record: Eprj3Record): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: record.type,
    id: record.id,
    ticket: record.ticket,
    body: record.body,
  };
  if (record.tombstone) out.tombstone = true;
  return out;
}

/** 把 sidecar 的输出裁到 MCP 结果能接受的体量。 */
function scriptOut(result: Eprj3ScriptResult, limit = 20_000): Record<string, unknown> {
  const stdout =
    result.stdout.length > limit ? `${result.stdout.slice(0, limit)}\n…（截断）` : result.stdout;
  const stderr =
    result.stderr.length > limit ? `${result.stderr.slice(0, limit)}\n…（截断）` : result.stderr;
  return {
    script: result.script,
    exitCode: result.exitCode,
    ok: result.ok,
    timedOut: result.timedOut,
    stdout,
    stderr,
    stdoutTruncated: result.stdout.length > limit,
    stderrTruncated: result.stderr.length > limit,
    json: result.json,
  };
}

function requireProject(dir: string): Eprj3Project {
  return loadEprj3Project(path.resolve(dir));
}

export const eprj3InspectTool = defineTool({
  name: "eprj3_inspect",
  description:
    "检视嘉立创EDA专业版 .eprj3 文件夹工程：索引 profile（板 / 原理图 / 页 / PCB / 面板）、" +
    "每个文档文件的文档清单（DOCHEAD 的 docType/uuid/client）、记录类型计数、墓碑（空体删除）数与归约后条数。" +
    "只读，不写盘。容器文件里库文档（SYMBOL/FOOTPRINT/DEVICE）在前、主文档在最后；" +
    "坐标单位是 mil（1 mil = 0.0254 mm）。要逐条记录用 eprj3_read_records。",
  input: { dir: dirSchema },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ dir }) => guard(() => inspectEprj3Project(dir)),
});

export const eprj3ReadRecordsTool = defineTool({
  name: "eprj3_read_records",
  description:
    "读取 .eprj3 工程的记录流（逐行 `{类型,ticket,id}||{载荷}|`）。" +
    "reduce 默认 true：按「文档 uuid + 归一化 id」归约，ticket 大者胜，平票比 DOCHEAD client 字典序大者胜，" +
    "空体是墓碑（删除）；META 的空体非法，会在 eprj3_validate 里报错。" +
    "file 给工程内相对或绝对路径，只读一个容器；type 过滤记录类型（COMPONENT / WIRE / PAD_NET …）。" +
    "返回结果默认最多 200 条（limit 可调），truncated 标记是否还有更多。坐标单位 mil，只读。",
  input: {
    dir: dirSchema,
    file: z.string().optional().describe("只读这个文件（工程内相对路径或绝对路径）"),
    type: z.string().optional().describe("只返回该类型的记录，如 COMPONENT、WIRE、PAD_NET"),
    reduce: z.boolean().optional().describe("按 ticket 归约，默认 true；false 时看完整编辑历史"),
    limit: z.number().int().min(1).max(5000).optional().describe("返回记录条数上限，默认 200"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ dir, file, type, reduce, limit }) =>
    guard(() => {
      const project = requireProject(dir);
      const useReduce = reduce ?? true;
      const maxRecords = limit ?? 200;
      const files =
        file === undefined
          ? documentFiles(project)
              .filter((entry) => entry.exists && entry.role !== "evar")
              .map((entry) => entry.relPath)
          : [resolveProjectPath(project, file).relative];

      let returned = 0;
      let total = 0;
      let truncated = false;
      const docs: Record<string, unknown>[] = [];
      for (const relative of files) {
        const absolute = path.resolve(project.rootDir, relative);
        if (!existsSync(absolute)) {
          throw new ToolError("EPRJ3_FILE_MISSING", `文档文件不存在：${relative}`);
        }
        const split = readDocumentFile(absolute);
        for (const section of split.sections) {
          const reduced = reduceDocSection(section);
          const records = useReduce ? reduced.records : section.records;
          const filtered =
            type === undefined ? records : records.filter((record) => record.type === type);
          total += filtered.length;
          // 过滤后没有记录的文档不返回，避免大工程里几百个空文档撑爆结果。
          if (filtered.length === 0) continue;
          const out: Record<string, unknown>[] = [];
          for (const record of filtered) {
            if (returned >= maxRecords) {
              truncated = true;
              break;
            }
            out.push(recordOut(record));
            returned += 1;
          }
          docs.push({
            file: relative,
            docType: section.docType,
            uuid: section.uuid,
            client: section.client,
            recordCount: filtered.length,
            tombstoneCount: reduced.tombstones.length,
            metaEmpty: reduced.metaEmpty,
            unparsed: section.unparsed,
            records: out,
          });
          if (truncated) break;
        }
        if (truncated) break;
      }
      return {
        dir: project.rootDir,
        file: file ?? null,
        type: type ?? null,
        reduce: useReduce,
        totalRecords: total,
        returnedRecords: returned,
        truncated,
        limit: maxRecords,
        docs,
      };
    }),
});

export const eprj3ValidateTool = defineTool({
  name: "eprj3_validate",
  description:
    "跑 .eprj3 格式门：索引形状、.ecfg/.evar、文档 uuid/ticket 唯一性、Device/Symbol/Footprint 引用、" +
    "空 NET / 板框 / LAYER、PAD_NET→COMPONENT/NET、POUR/VIA/FILL 网名、面板文件与未登记文件。" +
    "已修正源版对真机的误报：先按 ticket 归约（墓碑感知）、LINE→WIRE 缺失降为 warning、" +
    "OUTLINE 图层画板框、16-hex 引脚 id 的 parentId。" +
    "strict 为 true 时再对每条存活记录调用 src/format 的格式校验器；该 schema 与真机有已知出入" +
    "（例如 ATTR 的 groupId 在真机里可以整键缺失），所以 strict 结果只作参考，默认关闭。" +
    "返回的 errors/warnings 各截断到 200 条，errorCount/warningCount 是总数。只读。",
  input: {
    dir: dirSchema,
    strict: z
      .boolean()
      .optional()
      .describe("额外跑 src/format 的逐记录格式校验（schema 与真机有已知出入）"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ dir, strict }) => {
    const result = validateEprj3Project(dir, { strict: strict ?? false });
    return {
      ...result,
      errorCount: result.errors.length,
      warningCount: result.warnings.length,
      errors: result.errors.slice(0, 200),
      warnings: result.warnings.slice(0, 200),
      errorsTruncated: result.errors.length > 200,
      warningsTruncated: result.warnings.length > 200,
    };
  },
});

export const eprj3NetlistTool = defineTool({
  name: "eprj3_netlist",
  description:
    "导出 .eprj3 工程网表：原理图逐页按引脚 TIP、导线端点、网络标签并查集重建（与客户端同一套连接规则），" +
    "PCB 用 PAD_NET 权威数据。返回逐页元件/引脚/导线/网络计数与前 200 个网名；" +
    "完整成员表用 CLI `eprj3 netlist <dir> --json`。坐标单位 mil，只读。",
  input: { dir: dirSchema },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ dir }) =>
    guard(() => {
      const result = netlistProject(dir);
      return {
        project: result.project,
        warnings: result.warnings,
        sheets: result.perSheet.map((entry) => ({
          schematic: entry.schematic,
          sheet: entry.sheet,
          file: entry.file,
          components: entry.netlist.components.length,
          pins: entry.netlist.pinCount,
          wires: entry.netlist.wireCount,
          nets: entry.netlist.nets.length,
          unconnected: entry.netlist.unconnected.length,
          netNames: entry.netlist.nets.slice(0, 200).map((net) => net.name),
          netNamesTruncated: entry.netlist.nets.length > 200,
        })),
        pcb: result.pcb.map((entry) => ({
          pcb: entry.pcb,
          file: entry.file,
          pads: entry.netlist.pads.length,
          nets: entry.netlist.nets.length,
          netNames: entry.netlist.nets.slice(0, 200).map((net) => net.name),
          netNamesTruncated: entry.netlist.nets.length > 200,
        })),
        note: "PCB 坐标与尺寸是 mil；原理图沿用 0.01 inch 网格。完整引脚成员表见 CLI --json。",
      };
    }),
});

const gatesSchema = z
  .array(z.enum(["erc", "drc", "lint", "intent"]))
  .min(1)
  .describe("要跑的门禁：erc / drc / lint（布局）/ intent（设计意图）");

export const eprj3GatesTool = defineTool({
  name: "eprj3_gates",
  description:
    "跑源技能的审计门禁（sidecar）：erc（电气规则与网表比对）、drc（几何 / 间距 / 铺铜）、" +
    "lint（原理图布局可读性）、intent（design.json 设计意图）。" +
    "erc/drc/lint 需要工程目录；intent 需要 design 路径，不给会报错。只读，不改工程文件，" +
    "但每个门会起一个 node 子进程；每跑完一个门报告一次进度，可随请求取消。",
  input: {
    dir: dirSchema,
    gates: gatesSchema.optional(),
    design: z.string().optional().describe("design.json 路径；erc 用作网表对比，intent 必填"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async ({ dir, gates, design }, ctx) => {
    const project = requireProject(dir);
    // intent 只能校验 design.json；没给 design 时默认不跑它，避免默认调用直接报错。
    const selected = (gates ??
      (design === undefined ? (["erc", "drc", "lint"] as const) : EPRJ3_GATE_NAMES)) as Eprj3Gate[];
    const results: Record<string, unknown>[] = [];
    for (const [index, gate] of selected.entries()) {
      const args = eprj3GateArgs(
        gate,
        project.rootDir,
        design === undefined ? null : path.resolve(design),
      );
      const result = await runEprj3Script(EPRJ3_GATES[gate], args, { signal: ctx.signal });
      results.push({ gate, ...scriptOut(result) });
      await ctx.progress(index + 1, selected.length, gate);
      if (result.timedOut) break;
    }
    return { dir: project.rootDir, gates: selected, results };
  },
});

export const eprj3BuildTool = defineTool({
  name: "eprj3_build",
  description:
    "声明式建 .eprj3 工程（sidecar build.js）：给 design.json 或 gen 模块路径，生成索引、原理图、PCB 预布局与库文档。" +
    "这是写操作：先 dryRun=true 在临时目录试跑并看报告，确认后以 confirm:true 真正写盘。" +
    "原理图摆放与 PCB 预布局由本技能（sidecar）负责，铜皮、铺铜与最终布线由嘉立创EDA客户端完成（eda.js）。" +
    "坐标单位 mil。已有工程重复构建需要 force=true（只清理技能自己写的文件）。",
  input: {
    design: z.string().optional().describe("design.json 路径（与 gen 二选一）"),
    gen: z.string().optional().describe("生成器模块路径（与 design 二选一）"),
    dir: dirSchema.describe("目标工程目录"),
    dryRun: z.boolean().optional().describe("在临时目录试建、报告后删除；不会碰目标目录"),
    force: z.boolean().optional().describe("覆盖已存在的工程（只删技能自己写的文件）"),
    confirm: z.boolean().optional().describe("写操作确认；dryRun=false 时必须为 true"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  handler: async ({ design, gen, dir, dryRun, force, confirm }, ctx) => {
    if ((design === undefined) === (gen === undefined)) {
      throw new ToolError("EPRJ3_BUILD_ARGS", "design 与 gen 必须给且只给一个");
    }
    const targetDir = await ctx.resolveWritePath(dir);
    const args = ["--dir", targetDir];
    if (design !== undefined) args.push("--design", path.resolve(design));
    if (gen !== undefined) args.push("--gen", path.resolve(gen));
    if (dryRun === true) args.push("--dry-run");
    if (force === true) args.push("--force");
    if (dryRun !== true) {
      requireConfirm(confirm, { script: "build.js", args });
    }
    const result = await runEprj3Script("build", args, { signal: ctx.signal });
    return { dryRun: dryRun === true, dir: targetDir, ...scriptOut(result) };
  },
});

export const eprj3EditTool = defineTool({
  name: "eprj3_edit",
  description:
    "对既有 .eprj3 工程做原子编辑（sidecar）：add-symbol / add-footprint / add-wire / add-netlabel / " +
    "add-text / add-shape / add-pcb-text / add-pcb-shape / add-region / set-refdes / generate-symbol / generate-footprint。" +
    `可选 op：${EPRJ3_EDIT_OPS.join("、")}。args 原样传给脚本（如 ["--dir","<工程>","--sch","Schematic1","--sheet","P1",...]），坐标单位 mil。` +
    "这是写操作，必须 confirm:true；支持的脚本先带 --plan 预览。会改工程文件，测试请在 os.tmpdir() 的副本上跑。" +
    "摆放由技能负责，铺铜与最终布线交给客户端。",
  input: {
    op: z.string().min(1).describe("sidecar 编辑脚本名（不带 .js）"),
    args: z.array(z.string()).optional().describe("原样传给脚本的参数数组"),
    confirm: z.boolean().optional().describe("写操作确认，必须为 true"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  handler: async ({ op, args, confirm }, ctx) => {
    if (!isEprj3EditOp(op)) {
      throw new ToolError("EPRJ3_EDIT_OP_UNKNOWN", `不支持的编辑操作 ${op}`, {
        available: EPRJ3_EDIT_OPS,
      });
    }
    const safeArgs = [...(args ?? [])];
    for (let index = 0; index < safeArgs.length; index += 1) {
      const arg = safeArgs[index]!;
      if (arg === "--dir" && safeArgs[index + 1] !== undefined) {
        safeArgs[index + 1] = await ctx.resolveWritePath(safeArgs[index + 1]!);
        index += 1;
      } else if (arg.startsWith("--dir=")) {
        safeArgs[index] = `--dir=${await ctx.resolveWritePath(arg.slice("--dir=".length))}`;
      }
    }
    requireConfirm(confirm, { script: `${op}.js`, args: safeArgs });
    const result = await runEprj3Script(op, safeArgs, { signal: ctx.signal });
    return { op, ...scriptOut(result) };
  },
});

export const eprj3Tools: ToolDef[] = [
  eprj3InspectTool,
  eprj3ReadRecordsTool,
  eprj3ValidateTool,
  eprj3NetlistTool,
  eprj3GatesTool,
  eprj3BuildTool,
  eprj3EditTool,
];
