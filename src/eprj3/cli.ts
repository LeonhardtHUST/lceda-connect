/**
 * `.eprj3` 文件夹工程 CLI：inspect / records / validate / netlist / run。
 *
 * 记录解析、归约、格式门和网表在 TS 层；`run` 把参数原样转交 sidecar 脚本
 * （建工程、原子编辑、门禁）。只依赖 Io 抽象，由 main 挂到顶层命令。
 */
import { existsSync } from "node:fs";
import path from "node:path";

import {
  CliUsageError,
  boolValue,
  formatOptions,
  numberValue,
  parseArgs,
  stringValue,
  type OptionSpec,
} from "../core/cliArgs.ts";
import type { Io } from "../core/io.ts";
import { ToolError } from "../mcp/types.ts";
import { netlistProject } from "./netlist.ts";
import {
  documentFiles,
  inspectEprj3Project,
  loadEprj3Project,
  resolveProjectPath,
  Eprj3ProjectError,
} from "./project.ts";
import { readDocumentFile, reduceDocSection, type Eprj3Record } from "./records.ts";
import { runEprj3Script } from "./sidecar.ts";
import { validateEprj3Project } from "./validate.ts";

const JSON_OPTION: OptionSpec = {
  name: "json",
  type: "boolean",
  description: "以 JSON 输出",
};

const INSPECT_OPTIONS: readonly OptionSpec[] = [JSON_OPTION];

const RECORDS_OPTIONS: readonly OptionSpec[] = [
  {
    name: "file",
    type: "string",
    placeholder: "F",
    description: "只读这个文件（工程内相对路径或绝对路径）",
  },
  {
    name: "type",
    type: "string",
    placeholder: "T",
    description: "只返回该类型的记录，如 COMPONENT、WIRE、PAD_NET",
  },
  {
    name: "raw",
    type: "boolean",
    description: "打印原始行（含全部编辑历史，相当于 --no-reduce）",
  },
  {
    name: "limit",
    type: "number",
    placeholder: "N",
    description: "最多打印/返回多少条（默认 500）",
  },
  JSON_OPTION,
];

const VALIDATE_OPTIONS: readonly OptionSpec[] = [
  {
    name: "strict",
    type: "boolean",
    description: "额外对每条存活记录跑 src/format 的格式校验",
  },
  JSON_OPTION,
];

const NETLIST_OPTIONS: readonly OptionSpec[] = [JSON_OPTION];

const RUN_OPTIONS: readonly OptionSpec[] = [JSON_OPTION];

export function eprj3HelpLines(): string[] {
  return [
    "",
    "  lceda-connect eprj3  --  嘉立创EDA专业版 .eprj3 文件夹工程",
    "  ------------------------------------------------------------",
    "  用法: lceda-connect eprj3 <动作> [参数] [选项]",
    "",
    "  .eprj3 是文件夹工程：<工程名>.eprj3 是 JSON 索引，文档是逐行记录流",
    '  {"type","ticket","id"}||{body}|，空体（|||）表示删除，库文档在前、主文档最后。',
    "  坐标单位 mil（1 mil = 0.0254 mm）。",
    "",
    "  动作:",
    "    inspect <目录>           索引 profile、文档清单、记录类型计数、墓碑数",
    "    records <目录>           逐条读记录；默认按 ticket 归约",
    "    validate <目录>          格式门（墓碑感知，已修正真机误报）",
    "    netlist <目录>           原理图 / PCB 网表",
    "    run <脚本> -- <参数...>  转交 sidecar 脚本（build、add-*、erc、drc、eda…）",
    "    help                     这个帮助",
    "",
    "  选项:",
    ...formatOptions(INSPECT_OPTIONS),
    "    records 另有 --file <F>、--type <T>、--raw、--limit <N>",
    "    validate 另有 --strict（对每条记录再跑格式器；schema 与真机有已知出入，结果只作参考）",
    "",
    "  规则:",
    "    - 同一原子的记录按 ticket 大者胜；平票比 DOCHEAD client，字典序大者胜；",
    "    - 空体是墓碑（删除）；META 不能写空体，删 META 用 DELETE_DOC；",
    "    - 库文档（SYMBOL/FOOTPRINT/DEVICE）嵌在容器前部，主文档在最后；",
    "    - 原理图摆放与 PCB 预布局由本技能负责，铺铜和最终布线交给嘉立创EDA客户端；",
    "    - sidecar 写操作（build / add-* / set-refdes）先 dryRun 或 --plan 预览。",
    "",
    "  例子:",
    "    lceda-connect eprj3 inspect ./my-board",
    "    lceda-connect eprj3 records ./my-board --type PAD_NET --limit 20",
    "    lceda-connect eprj3 records ./my-board --file pcb/PCB1.epcb2 --raw --limit 50",
    "    lceda-connect eprj3 validate ./my-board --strict",
    "    lceda-connect eprj3 netlist ./my-board --json",
    "    lceda-connect eprj3 run validate -- --dir ./my-board --json",
    "    lceda-connect eprj3 run build -- --design design.json --dir ./out --dry-run",
    "",
  ];
}

function usageError(io: Io, message: string): number {
  io.err(`  ${message}`);
  io.err("  用 `lceda-connect eprj3 help` 查看用法。");
  return 1;
}

function requireDir(io: Io, positionals: readonly string[], action: string): string | null {
  if (positionals.length === 0) {
    usageError(io, `${action} 需要工程目录。`);
    return null;
  }
  if (positionals.length > 1) {
    usageError(io, `${action} 只接受一个工程目录，多余的参数：${positionals.slice(1).join(" ")}`);
    return null;
  }
  return path.resolve(positionals[0] ?? "");
}

function countsText(counts: Record<string, number>, limit = 8): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, limit).map(([type, count]) => `${type} ${count}`);
  if (entries.length > limit) shown.push(`… 共 ${entries.length} 种`);
  return shown.join("、") || "无";
}

function printInspectText(io: Io, info: ReturnType<typeof inspectEprj3Project>): void {
  io.out(`工程: ${info.name}`);
  io.out(`目录: ${info.dir}`);
  io.out(`索引: ${info.indexFile}`);
  io.out(
    `profile: 板 ${info.profile.boards} / 原理图 ${info.profile.schematics} / 页 ${info.profile.sheets} / ` +
      `PCB ${info.profile.pcbs} / 面板 ${info.profile.panels}`,
  );
  io.out(
    `总计: 文件 ${info.totals.files}（存在 ${info.totals.presentFiles}）、文档 ${info.totals.docs}、` +
      `记录 ${info.totals.records}（墓碑 ${info.totals.tombstones}，归约后 ${info.totals.reducedRecords}）`,
  );
  io.out(`记录类型: ${countsText(info.totals.types)}`);
  io.out("");
  io.out("文档文件:");
  for (const file of info.files) {
    const state = file.exists ? "" : "（缺失）";
    io.out(`  ${file.relPath}  [${file.role}]${state}`);
    if (file.role === "evar") {
      io.out("    变体数据，不按记录流解析");
      continue;
    }
    if (!file.exists) continue;
    io.out(
      `    文档 ${file.docs.length}、记录 ${file.recordCount}（墓碑 ${file.tombstoneCount}，` +
        `归约后 ${file.reducedRecordCount}）`,
    );
    if (file.unparsed > 0) io.out(`    无法解析的行: ${file.unparsed}`);
    io.out(`    类型: ${countsText(file.typeCounts)}`);
    for (const doc of file.docs) {
      io.out(
        `    - ${doc.docType ?? "?"} ${doc.uuid ?? "?"}  记录 ${doc.recordCount}` +
          `（归约 ${doc.reducedRecordCount}）${doc.metaEmpty ? "  [META 空体]" : ""}`,
      );
    }
  }
  if (info.warnings.length > 0) {
    io.out("");
    io.out("提示:");
    for (const warning of info.warnings) io.out(`  - ${warning}`);
  }
}

function printRecordLine(io: Io, record: Eprj3Record, raw: boolean): void {
  if (raw) {
    io.out(`    ${record.raw}`);
    return;
  }
  const body = JSON.stringify(record.body);
  const clipped = body.length > 200 ? `${body.slice(0, 200)}…` : body;
  io.out(
    `    ${record.type.padEnd(12)} ticket=${record.ticket ?? "-"} id=${record.id ?? "-"}  ${clipped}`,
  );
}

function recordsCommand(argv: readonly string[], io: Io): number {
  const parsed = parseArgs(argv, RECORDS_OPTIONS);
  const dir = requireDir(io, parsed.positionals, "records");
  if (dir === null) return 1;
  const project = loadEprj3Project(dir);
  const json = boolValue(parsed, "json");
  const raw = boolValue(parsed, "raw");
  const type = stringValue(parsed, "type");
  const limit = numberValue(parsed, "limit") ?? 500;
  const fileArg = stringValue(parsed, "file");

  const files =
    fileArg === undefined
      ? documentFiles(project)
          .filter((entry) => entry.exists && entry.role !== "evar")
          .map((entry) => entry.relPath)
      : [resolveProjectPath(project, fileArg).relative];

  const docs: {
    file: string;
    docType: string | null;
    uuid: string | null;
    client: string | null;
    recordCount: number;
    tombstoneCount: number;
    metaEmpty: boolean;
    unparsed: number;
    records: Eprj3Record[];
  }[] = [];
  let returned = 0;
  let total = 0;
  let truncated = false;
  for (const relative of files) {
    const absolute = path.resolve(project.rootDir, relative);
    if (!existsSync(absolute)) {
      io.err(`ERROR: 文档文件不存在：${relative}`);
      return 1;
    }
    const split = readDocumentFile(absolute);
    for (const section of split.sections) {
      const reduced = reduceDocSection(section);
      const records = raw ? section.records : reduced.records;
      const filtered =
        type === undefined ? records : records.filter((record) => record.type === type);
      total += filtered.length;
      const out: Eprj3Record[] = [];
      for (const record of filtered) {
        if (returned >= limit) {
          truncated = true;
          break;
        }
        out.push(record);
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

  if (json) {
    io.out(
      JSON.stringify(
        {
          dir: project.rootDir,
          file: fileArg ?? null,
          type: type ?? null,
          raw,
          reduce: !raw,
          totalRecords: total,
          returnedRecords: returned,
          truncated,
          limit,
          docs: docs.map((doc) => ({
            ...doc,
            records: doc.records.map((record) => ({
              type: record.type,
              id: record.id,
              ticket: record.ticket,
              body: record.body,
              raw: raw ? record.raw : undefined,
            })),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  io.out(`工程: ${project.name}（${project.rootDir}）`);
  io.out(
    `模式: ${raw ? "原始行（不归约）" : "按 ticket 归约"}${type === undefined ? "" : `，只看 ${type}`}`,
  );
  for (const doc of docs) {
    if (doc.records.length === 0) continue;
    io.out("");
    io.out(
      `${doc.file}  [${doc.docType ?? "?"} ${doc.uuid ?? "?"}]  ` +
        `记录 ${doc.recordCount}（墓碑 ${doc.tombstoneCount}）`,
    );
    for (const record of doc.records) printRecordLine(io, record, raw);
  }
  if (returned === 0) io.out("没有匹配的记录。");
  if (truncated) io.out(`\n已到 --limit ${limit}，还有更多记录（加大 --limit 或用 --json）。`);
  return 0;
}

function validateCommand(argv: readonly string[], io: Io): number {
  const parsed = parseArgs(argv, VALIDATE_OPTIONS);
  const dir = requireDir(io, parsed.positionals, "validate");
  if (dir === null) return 1;
  const result = validateEprj3Project(dir, { strict: boolValue(parsed, "strict") });
  if (boolValue(parsed, "json")) {
    io.out(JSON.stringify(result, null, 2));
  } else {
    for (const warning of result.warnings) io.out(`warn: ${warning}`);
    for (const error of result.errors) io.err(`error: ${error}`);
    if (result.strict !== undefined) {
      io.out(
        `strict: 检查 ${result.strict.checked} 条记录，错误 ${result.strict.errorCount}，` +
          `警告 ${result.strict.warningCount}，跳过未知类型 ${result.strict.skippedUnknownTypes}`,
      );
      for (const issue of result.strict.warnings) {
        io.out(`  warn ${issue.file} ${issue.type}.${issue.field}: ${issue.message}`);
      }
      for (const issue of result.strict.errors) {
        io.err(`  error ${issue.file} ${issue.type}.${issue.field}: ${issue.message}`);
      }
    }
    io.out(
      `统计: 文件 ${result.stats.files}、文档 ${result.stats.docs}、记录 ${result.stats.records}` +
        `（墓碑 ${result.stats.tombstones}，归约后 ${result.stats.reducedRecords}）`,
    );
    if (result.ok) io.out(`OK（0 error，${result.warnings.length} warning）`);
    else io.err(`FAILED（${result.errors.length} error，${result.warnings.length} warning）`);
  }
  return result.ok ? 0 : 1;
}

function netlistCommand(argv: readonly string[], io: Io): number {
  const parsed = parseArgs(argv, NETLIST_OPTIONS);
  const dir = requireDir(io, parsed.positionals, "netlist");
  if (dir === null) return 1;
  const result = netlistProject(dir);
  if (boolValue(parsed, "json")) {
    io.out(JSON.stringify(result, null, 2));
    return 0;
  }
  io.out(`工程: ${result.project.name}（${result.project.dir}）`);
  for (const warning of result.warnings) io.out(`warn: ${warning}`);
  for (const entry of result.perSheet) {
    io.out(
      `\n页 ${entry.sheet}（${entry.schematic ?? "?"}）: 元件 ${entry.netlist.components.length}、` +
        `引脚 ${entry.netlist.pinCount}、导线 ${entry.netlist.wireCount}、网络 ${entry.netlist.nets.length}、` +
        `悬空引脚 ${entry.netlist.unconnected.length}`,
    );
    for (const net of entry.netlist.nets.slice(0, 20)) {
      io.out(`  ${net.name}: ${net.pins.map((pin) => `${pin.ref}.${pin.num}`).join(" ")}`);
    }
    if (entry.netlist.nets.length > 20) io.out(`  … 还有 ${entry.netlist.nets.length - 20} 个网络`);
  }
  for (const entry of result.pcb) {
    io.out(
      `\nPCB ${entry.pcb}: 焊盘 ${entry.netlist.pads.length}、网络 ${entry.netlist.nets.length}`,
    );
    for (const net of entry.netlist.nets.slice(0, 20)) {
      io.out(`  ${net.name}: ${net.pins.map((pin) => `${pin.ref}.${pin.num}`).join(" ")}`);
    }
    if (entry.netlist.nets.length > 20) io.out(`  … 还有 ${entry.netlist.nets.length - 20} 个网络`);
  }
  return 0;
}

function runCommand(argv: readonly string[], io: Io, env: NodeJS.ProcessEnv): Promise<number> {
  const separator = argv.indexOf("--");
  const head = separator < 0 ? argv : argv.slice(0, separator);
  const tail = separator < 0 ? [] : argv.slice(separator + 1);
  const parsed = parseArgs(head, RUN_OPTIONS);
  const script = parsed.positionals[0];
  if (script === undefined) {
    usageError(io, "run 需要一个 sidecar 脚本名，如 validate、build、add-wire。");
    return Promise.resolve(1);
  }
  if (parsed.positionals.length > 1) {
    usageError(io, `sidecar 参数要放在 -- 之后，收到：${parsed.positionals.slice(1).join(" ")}`);
    return Promise.resolve(1);
  }
  return runEprj3Script(script, tail, { env }).then((result) => {
    if (boolValue(parsed, "json")) {
      io.out(JSON.stringify(result, null, 2));
    } else {
      io.out(`脚本: ${result.script}`);
      io.out(`退出码: ${result.exitCode}${result.timedOut ? "（超时）" : ""}`);
      if (result.stdout.trim() !== "") {
        io.out("--- stdout ---");
        io.out(result.stdout.trimEnd());
      }
      if (result.stderr.trim() !== "") {
        io.err("--- stderr ---");
        io.err(result.stderr.trimEnd());
      }
    }
    return result.exitCode;
  });
}

/** 处理 `eprj3` 子命令；返回进程退出码。 */
export async function runEprj3Command(
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const [action = "help", ...rest] = argv;
  if (
    action === "help" ||
    action === "--help" ||
    action === "-h" ||
    rest.includes("--help") ||
    rest.includes("-h")
  ) {
    for (const line of eprj3HelpLines()) io.out(line);
    return 0;
  }
  try {
    if (action === "inspect") {
      const parsed = parseArgs(rest, INSPECT_OPTIONS);
      const dir = requireDir(io, parsed.positionals, "inspect");
      if (dir === null) return 1;
      const info = inspectEprj3Project(dir);
      if (boolValue(parsed, "json")) io.out(JSON.stringify(info, null, 2));
      else printInspectText(io, info);
      return 0;
    }
    if (action === "records") return recordsCommand(rest, io);
    if (action === "validate") return validateCommand(rest, io);
    if (action === "netlist") return netlistCommand(rest, io);
    if (action === "run") return await runCommand(rest, io, env);
    return usageError(io, `不认识的 eprj3 动作：${action}`);
  } catch (error) {
    if (error instanceof Eprj3ProjectError) {
      io.err(`ERROR: ${error.message}`);
      return 2;
    }
    if (error instanceof ToolError) {
      io.err(`ERROR[${error.code}]: ${error.message}`);
      if (error.details !== undefined) io.err(`  ${JSON.stringify(error.details)}`);
      return 2;
    }
    if (error instanceof CliUsageError) return usageError(io, error.message);
    throw error;
  }
}
