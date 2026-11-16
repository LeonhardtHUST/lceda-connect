/**
 * .epro2 工程解析 CLI：analyze / diff / inspect。
 *
 * 只依赖 Io 抽象，由 main 负责挂到顶层命令；`--json` 输出机器可读摘要，
 * 默认输出中文结果与产物路径。
 */
import type { Io } from "../core/io.ts";
import {
  CliUsageError,
  boolValue,
  formatOptions,
  parseArgs,
  stringValue,
  type OptionSpec,
} from "../core/cliArgs.ts";
import { ProjectError } from "./container.ts";
import { analyzeSummary, inspectProject, runDiff, runSingle } from "./analyze.ts";

const ANALYZE_OPTIONS: readonly OptionSpec[] = [
  {
    name: "out",
    aliases: ["o"],
    type: "string",
    placeholder: "目录",
    description: "产物目录（默认 ./eda-out）",
  },
  {
    name: "page",
    type: "string",
    placeholder: "页名或 uuid",
    description: "只解析指定原理图页",
  },
  {
    name: "json",
    type: "boolean",
    description: "输出 JSON 摘要而不是中文文本",
  },
];

const DIFF_OPTIONS: readonly OptionSpec[] = [
  {
    name: "out",
    aliases: ["o"],
    type: "string",
    placeholder: "目录",
    description: "差异产物目录（默认 ./eda-diff）",
  },
  {
    name: "json",
    type: "boolean",
    description: "输出 JSON 摘要而不是中文文本",
  },
];

const INSPECT_OPTIONS: readonly OptionSpec[] = [
  {
    name: "json",
    type: "boolean",
    description: "输出 JSON 摘要而不是中文文本",
  },
];

export function epro2Help(): string[] {
  return [
    "嘉立创EDA专业版工程解析（.epro2）",
    "",
    "用法:",
    "  epro2 analyze <工程.epro2> --out <目录> [--page <页名或 uuid>] [--json]",
    "  epro2 diff <旧.epro2> <新.epro2> --out <目录> [--json]",
    "  epro2 inspect <工程.epro2> [--json]",
    "",
    "analyze 产物（与源技能同名同结构）:",
    "  meta.json / schematic_<页>.json / nets.json / pcb_netlist.csv /",
    "  pcb_geometry.json / report.md",
    "diff 产物: diff.json / diff.md",
    "",
    "规则:",
    "  - PCB 侧 PAD_NET 是权威网表；原理图侧按几何重建，只做交叉验证。",
    "  - PCB 坐标单位是 mil（1 mil = 0.0254 mm），原理图是逻辑坐标。",
    "  - 同一 (类型, id) 只取 ticket 最大的记录；无位号的 PCB 元件是删除残留。",
    "",
    "选项:",
    ...formatOptions(ANALYZE_OPTIONS),
    "  （diff / inspect 只接受对应的 --out / --json）",
  ];
}

function usageError(io: Io, message: string): number {
  io.err(`ERROR: ${message}`);
  io.err("用 `epro2 --help` 查看用法。");
  return 2;
}

function printAnalyze(run: ReturnType<typeof runSingle>, io: Io): void {
  io.out(`工程: ${run.artifacts.meta.project}`);
  const pages = run.artifacts.meta.pages_analyzed.join("、") || "无";
  io.out(
    `文档: ${run.artifacts.meta.documents.length}，解析页: ${pages}，PCB 网表: ${run.artifacts.pcb_rows.length} 行`,
  );
  io.out(
    `网表比对: 可比 ${run.consistency.compared}，不一致 ${run.consistency.mismatch}，` +
      `未命名跳过 ${run.consistency.skipped_unnamed}`,
  );
  io.out("产物:");
  for (const file of run.files) io.out(`  ${file}`);
}

function printDiff(run: ReturnType<typeof runDiff>, io: Io): void {
  for (const line of run.summary.split("\n")) io.out(line);
  io.out("产物:");
  for (const file of run.files) io.out(`  ${file}`);
}

function printInspect(info: ReturnType<typeof inspectProject>, io: Io): void {
  io.out(`工程: ${info.title}`);
  io.out(`记录流: ${info.epru}（${info.recordLines} 行，解析失败 ${info.recordUnparsed} 行）`);
  io.out(
    `库表: 符号 ${info.library.symbols} / 器件 ${info.library.devices} / 封装 ${info.library.footprints}`,
  );
  io.out("成员:");
  for (const member of [...info.members].sort((a, b) => a.name.localeCompare(b.name))) {
    io.out(`  ${member.name.padEnd(40)} ${String(member.size).padStart(10)} B`);
  }
  const pages = info.documents.filter(
    (doc) => doc.docType === "SCH_PAGE" || doc.docType === "SIMULATION",
  );
  if (pages.length > 0) {
    io.out("原理图页:");
    for (const page of pages) io.out(`  ${page.uuid ?? "?"}  ${page.title || "(未命名)"}`);
  }
}

function analyzeCommand(argv: readonly string[], io: Io): number {
  const parsed = parseArgs(argv, ANALYZE_OPTIONS);
  const project = parsed.positionals[0];
  if (!project) return usageError(io, "analyze 需要给出 .epro2 文件路径");
  if (parsed.positionals.length > 1) return usageError(io, "analyze 只接受一个 .epro2 文件路径");
  const outDir = stringValue(parsed, "out") ?? "eda-out";
  const page = stringValue(parsed, "page");
  const run = runSingle(project, outDir, page ?? null);
  if (boolValue(parsed, "json")) {
    io.out(JSON.stringify(analyzeSummary(run), null, 2));
  } else {
    printAnalyze(run, io);
  }
  return 0;
}

function diffCommand(argv: readonly string[], io: Io): number {
  const parsed = parseArgs(argv, DIFF_OPTIONS);
  const [oldFile, newFile] = parsed.positionals;
  if (!oldFile || !newFile) return usageError(io, "diff 需要给出旧版与新版两个 .epro2 路径");
  if (parsed.positionals.length > 2) return usageError(io, "diff 只接受两个 .epro2 路径");
  const outDir = stringValue(parsed, "out") ?? "eda-diff";
  const run = runDiff(oldFile, newFile, outDir);
  if (boolValue(parsed, "json")) {
    io.out(
      JSON.stringify(
        {
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
        },
        null,
        2,
      ),
    );
  } else {
    printDiff(run, io);
  }
  return 0;
}

function inspectCommand(argv: readonly string[], io: Io): number {
  const parsed = parseArgs(argv, INSPECT_OPTIONS);
  const project = parsed.positionals[0];
  if (!project) return usageError(io, "inspect 需要给出 .epro2 文件路径");
  if (parsed.positionals.length > 1) return usageError(io, "inspect 只接受一个 .epro2 文件路径");
  const info = inspectProject(project);
  if (boolValue(parsed, "json")) {
    io.out(JSON.stringify(info, null, 2));
  } else {
    printInspect(info, io);
  }
  return 0;
}

/** 处理 `epro2` 子命令；返回进程退出码。 */
export async function runEpro2Command(
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  void env;
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    for (const line of epro2Help()) io.out(line);
    return 0;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    for (const line of epro2Help()) io.out(line);
    return 0;
  }
  try {
    if (command === "analyze") return analyzeCommand(rest, io);
    if (command === "diff") return diffCommand(rest, io);
    if (command === "inspect") return inspectCommand(rest, io);
    io.err(`ERROR: 不认识的 epro2 子命令：${command}`);
    for (const line of epro2Help()) io.out(line);
    return 1;
  } catch (error) {
    if (error instanceof ProjectError) {
      io.err(`ERROR: ${error.message}`);
      return 2;
    }
    if (error instanceof CliUsageError) {
      return usageError(io, error.message);
    }
    throw error;
  }
}
