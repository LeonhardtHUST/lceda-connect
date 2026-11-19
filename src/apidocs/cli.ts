import { CliUsageError, numberValue, parseArgs, stringValue } from "../core/cliArgs.ts";
import type { Io } from "../core/io.ts";
import {
  API_DOCS_MISSING,
  apiDocsAvailable,
  getEntry,
  search,
  type ApiEntryKind,
  type ApiEntryDetail,
} from "./index.ts";

/**
 * `lceda-connect api <动作>` 的实现。
 * 只读索引文件，不连编辑器；lead 负责把它挂到 main 里。
 */

const KINDS: readonly ApiEntryKind[] = ["class", "interface", "enum", "type"];

const OPTIONS = [
  {
    name: "kind",
    type: "string" as const,
    placeholder: "KIND",
    description: "只看 class/interface/enum/type",
  },
  {
    name: "limit",
    aliases: ["n"],
    type: "number" as const,
    placeholder: "N",
    description: "返回条数上限（默认 20）",
  },
  { name: "json", type: "boolean" as const, description: "以 JSON 输出" },
  { name: "help", aliases: ["h"], type: "boolean" as const, description: "显示帮助" },
];

export function apiHelpLines(): string[] {
  return [
    "",
    "  lceda-connect api  --  EasyEDA Pro API 文档检索",
    "  ------------------------------------------------------------",
    "  用法: lceda-connect api <动作> [参数] [选项]",
    "",
    "  动作:",
    "    search <词>            检索类/接口/枚举/类型与成员（支持中文与 pcb_PrimitiveVia.create 写法）",
    "    get <类> [成员]        列出成员表；带成员时返回签名段落原文",
    "    help                   这个帮助",
    "",
    "  选项:",
    "    --kind <KIND>          search 只看 class/interface/enum/type",
    "    --limit, -n <N>        search 返回条数上限（默认 20，最多 100）",
    "    --json                 以 JSON 输出",
    "",
    "  例子:",
    "    lceda-connect api search 过孔",
    "    lceda-connect api search pcb_PrimitiveVia.create",
    "    lceda-connect api get PCB_PrimitiveVia create",
    "    lceda-connect api get EPCB_LayerId --json",
    "",
  ];
}

function usageError(io: Io, message: string): number {
  io.err(`  ${message}`);
  for (const line of apiHelpLines()) io.err(line);
  return 1;
}

function printSearchText(io: Io, query: string, hits: ReturnType<typeof search>): void {
  if (hits.length === 0) {
    io.out(`  没有匹配「${query}」的条目。试试更短的关键词，或英文类名。`);
    return;
  }
  io.out("");
  io.out(`  「${query}」命中 ${hits.length} 条：`);
  for (const hit of hits) {
    const where = hit.callPath ? `  ${hit.callPath}` : "";
    io.out(`  ${hit.name}  [${hit.kind}]${where}`);
    if (hit.summary) io.out(`    ${hit.summary}`);
    if (hit.member) {
      const signature = hit.member.signature ?? hit.member.type ?? hit.member.value ?? "";
      io.out(`    → ${hit.member.name}: ${signature}`);
    }
  }
  io.out("");
}

function printEntryText(io: Io, entry: ApiEntryDetail): void {
  io.out("");
  io.out(`  ${entry.name}  [${entry.kind}]`);
  if (entry.callPath) io.out(`  访问路径: ${entry.callPath}`);
  if (entry.summary) io.out(`  说明: ${entry.summary}`);
  io.out(`  原文: assets/api-docs/${entry.file}`);
  if (entry.members.length === 0) {
    io.out("  （这个条目没有成员）");
  } else {
    io.out(`  成员 (${entry.members.length}):`);
    for (const member of entry.members) {
      const signature = member.signature ?? member.type ?? "";
      const summary = member.summary ? `  — ${member.summary}` : "";
      io.out(`    ${member.name}${signature ? `: ${signature}` : ""}${summary}`);
    }
  }
  io.out("");
}

export async function runApiCommand(
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const action = (argv[0] ?? "help").trim().toLowerCase();
  if (action === "help" || action === "--help" || action === "-h") {
    for (const line of apiHelpLines()) io.out(line);
    return 0;
  }

  let parsed;
  try {
    parsed = parseArgs(argv.slice(1), OPTIONS);
  } catch (error) {
    if (error instanceof CliUsageError) return usageError(io, error.message);
    throw error;
  }
  if (parsed.values.help === true) {
    for (const line of apiHelpLines()) io.out(line);
    return 0;
  }

  if ((action === "search" || action === "get") && !apiDocsAvailable(env)) {
    io.err(`  ${API_DOCS_MISSING}`);
    return 1;
  }

  const json = parsed.values.json === true;
  const [first, second, ...extras] = parsed.positionals;
  if (extras.length > 0) return usageError(io, `多余的参数: ${extras.join(" ")}`);

  if (action === "search") {
    if (!first) return usageError(io, "search 需要一个检索词。");
    const kindRaw = stringValue(parsed, "kind");
    let kind: ApiEntryKind | undefined;
    if (kindRaw !== undefined) {
      const lowered = kindRaw.trim().toLowerCase() as ApiEntryKind;
      if (!KINDS.includes(lowered)) {
        return usageError(io, `--kind 只能是 ${KINDS.join(" / ")}，收到 "${kindRaw}"`);
      }
      kind = lowered;
    }
    const limit = numberValue(parsed, "limit");
    const hits = search(first, { kind, limit }, env);
    if (json) {
      io.out(JSON.stringify({ query: first, count: hits.length, results: hits }, null, 2));
    } else {
      printSearchText(io, first, hits);
    }
    return 0;
  }

  if (action === "get") {
    if (!first) return usageError(io, "get 需要一个类名。");
    const entry = getEntry(first, second, env);
    if (!entry) {
      io.err(
        `  没有找到 ${first}${second ? `.${second}` : ""}。先用 api search 找准确的类名/成员名。`,
      );
      return 1;
    }
    if (json) {
      io.out(JSON.stringify(entry, null, 2));
      return 0;
    }
    if ("text" in entry) {
      io.out("");
      io.out(`  ${entry.className}.${entry.member}  [${entry.kind}]`);
      io.out(`  原文: assets/api-docs/${entry.file}`);
      io.out("");
      for (const line of entry.text.split(/\r?\n/)) io.out(`  ${line}`);
      io.out("");
      return 0;
    }
    printEntryText(io, entry);
    return 0;
  }

  return usageError(io, `不认识的命令: ${action}`);
}
