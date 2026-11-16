/// <reference types="node" />
/**
 * 生成 assets/api-docs/index.json（API 文档检索索引）。
 *
 * 数据来源是 assets/api-docs/references/ 下从 easyeda-api-skill 收进来的
 * TypeDoc 生成式 Markdown（classes / interfaces / enums / types）。
 *
 * 运行方式（Node 26 自带 TypeScript 类型擦除，不需要 tsx）：
 *   node scripts/build-api-index.ts
 *
 * 索引里的 file 是相对 assets/api-docs 的路径，运行时用 assetPath("api-docs", file) 取原文。
 * 改了解析规则就重新跑一次，把生成物一起提交。
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type EntryKind = "class" | "interface" | "enum" | "type";
type MemberKind = "method" | "property" | "enum-member" | "constructor";

interface IndexMember {
  name: string;
  kind: MemberKind;
  signature?: string;
  summary?: string;
  type?: string;
  value?: string;
}

interface IndexEntry {
  name: string;
  kind: EntryKind;
  file: string;
  summary: string;
  callPath?: string;
  members: IndexMember[];
}

interface ApiIndexFile {
  version: number;
  source: { repo: string; sha: string; generatedAt: string };
  counts: Record<EntryKind, number>;
  entries: IndexEntry[];
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = path.join(ROOT, "assets", "api-docs");
const REFERENCES_DIR = path.join(DOCS_DIR, "references");
const OUTPUT_FILE = path.join(DOCS_DIR, "index.json");
const SOURCE_SHA_FILE = path.join(DOCS_DIR, ".source-sha");

const MAX_SUMMARY = 320;
const MAX_MEMBER_SUMMARY = 200;
const MAX_SIGNATURE = 600;

const DIR_KINDS: { dir: string; kind: EntryKind }[] = [
  { dir: "classes", kind: "class" },
  { dir: "interfaces", kind: "interface" },
  { dir: "enums", kind: "enum" },
  { dir: "types", kind: "type" },
];

const SECTION_KINDS: { test: RegExp; kind: MemberKind }[] = [
  { test: /^methods?$/i, kind: "method" },
  { test: /^constructors?$/i, kind: "constructor" },
  { test: /^properties$/i, kind: "property" },
  { test: /enumeration/i, kind: "enum-member" },
];

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_all, num: string) => String.fromCodePoint(Number.parseInt(num, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function squeeze(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** TypeDoc 会把下划线等字符转义成 `\_`，检索与展示都要还原。 */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+.!~|-])/g, "$1");
}

function clip(text: string, max: number): string {
  const flat = squeeze(text);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** 把 TypeDoc 表格单元格压成一行纯文本：去标签、去 Markdown 链接包装、解实体。 */
function cellText(html: string): string {
  const withoutTags = html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ");
  return squeeze(decode(withoutTags).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"));
}

/** 单元格里的说明还带着 `**bold**`、`_(Optional)_` 这类装饰，统一剥掉。 */
function plainText(text: string): string {
  const decoded = unescapeMarkdown(decode(text));
  return squeeze(decoded.replace(/\*\*|__|`/g, "").replace(/(^|\s)_([^_]+)_(?=\s|$)/g, "$1$2"));
}

function splitCells(row: string, tag: "td" | "th"): string[] {
  const cells: string[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  for (const match of row.matchAll(re)) cells.push(cellText(match[1] ?? ""));
  return cells;
}

function sectionAt(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const headings = [...before.matchAll(/^##\s+(.+)$/gm)];
  const last = headings[headings.length - 1];
  return last ? squeeze(last[1] ?? "") : "";
}

interface TableRow {
  section: string;
  header: string[];
  cells: string[];
}

function readTables(text: string): TableRow[] {
  const rows: TableRow[] = [];
  for (const table of text.matchAll(/<table>([\s\S]*?)<\/table>/gi)) {
    const body = table[1] ?? "";
    const bodyOffset = (table.index ?? 0) + table[0].indexOf(body);
    const rowsHtml = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1] ?? "");
    if (rowsHtml.length === 0) continue;
    const header = splitCells(rowsHtml[0] ?? "", "th");
    const section = sectionAt(text, bodyOffset);
    for (const row of rowsHtml.slice(1)) {
      const cells = splitCells(row, "td");
      if (cells.length > 0) rows.push({ section, header, cells });
    }
  }
  return rows;
}

interface DetailBlock {
  name: string;
  signature: string;
  summary: string;
}

/** 详情段落以 `### <成员名>` 开头，紧跟 `# 类.成员()`、摘要、`## Signature` 代码块。 */
function readDetails(text: string): DetailBlock[] {
  const blocks: { heading: string; body: string }[] = [];
  for (const match of text.matchAll(/^###\s+(.+)$/gm)) {
    const start = match.index ?? 0;
    const next = text.slice(start + match[0].length).search(/^###\s+/m);
    const end = next < 0 ? text.length : start + match[0].length + next;
    blocks.push({ heading: squeeze(match[1] ?? ""), body: text.slice(start, end) });
  }

  const details: DetailBlock[] = [];
  for (const block of blocks) {
    const titleMatch = /^#\s+(.+)$/m.exec(block.body);
    const title = titleMatch ? plainText(squeeze(titleMatch[1] ?? "")) : "";
    let name = block.heading;
    if (/\.\(constructor\)/.test(title)) {
      name = "constructor";
    } else {
      const memberMatch =
        /\.([A-Za-z0-9_$]+)\s*(?:\(\))?\s*(?:method|property|accessor)?\s*$/i.exec(title);
      if (memberMatch?.[1]) name = memberMatch[1];
    }
    const signatureMatch = /##\s+Signature\s*\n+```(?:typescript|ts)?\n([\s\S]*?)```/i.exec(
      block.body,
    );
    const summaryEnd = block.body.search(/^##\s+/m);
    const summary =
      summaryEnd < 0
        ? ""
        : block.body
            .slice(titleMatch ? (titleMatch.index ?? 0) + titleMatch[0].length : 0, summaryEnd)
            .split(/\n{2,}/)
            .map((part) => plainText(part))
            .filter((part) => part !== "")
            .join(" ");
    details.push({
      name,
      signature: signatureMatch ? clip(signatureMatch[1] ?? "", MAX_SIGNATURE) : "",
      summary: clip(summary, MAX_MEMBER_SUMMARY),
    });
  }
  return details;
}

function memberKindFor(section: string, header: string[]): MemberKind | null {
  for (const spec of SECTION_KINDS) {
    if (spec.test.test(section)) return spec.kind;
  }
  const first = (header[0] ?? "").toLowerCase();
  if (first.startsWith("method")) return "method";
  if (first.startsWith("property")) return "property";
  if (first.startsWith("member")) return "enum-member";
  return null;
}

function memberFromRow(row: TableRow, kind: MemberKind): IndexMember | null {
  const first = row.cells[0] ?? "";
  if (!first) return null;
  const name = plainText(first.split("(")[0] ?? "").replace(/\?$/, "");
  if (!name) return null;
  const description = plainText(row.cells[row.cells.length - 1] ?? "");
  const typed = row.header.findIndex((item) => /^type$/i.test(item));
  const valueIndex = row.header.findIndex((item) => /^value$/i.test(item));
  const member: IndexMember = { name, kind };
  if (typed >= 0 && row.cells[typed]) member.type = plainText(row.cells[typed] ?? "");
  if (valueIndex >= 0 && row.cells[valueIndex])
    member.value = plainText(row.cells[valueIndex] ?? "");
  if (description) member.summary = clip(description, MAX_MEMBER_SUMMARY);
  return member;
}

function mergeMembers(rows: IndexMember[], details: DetailBlock[]): IndexMember[] {
  const merged = new Map<string, IndexMember>();
  for (const member of rows) {
    const key = member.name.toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...member });
      continue;
    }
    // 同一个成员可能被重载多次，合并时保留第一段说明，补齐缺失字段
    if (!existing.summary && member.summary) existing.summary = member.summary;
    if (!existing.type && member.type) existing.type = member.type;
  }

  for (const detail of details) {
    const key = detail.name.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      if (detail.signature && !existing.signature) existing.signature = detail.signature;
      if (detail.summary && !existing.summary) existing.summary = detail.summary;
    } else {
      merged.set(key, {
        name: detail.name,
        kind: detail.name === "constructor" ? "constructor" : "method",
        ...(detail.signature ? { signature: detail.signature } : {}),
        ...(detail.summary ? { summary: detail.summary } : {}),
      });
    }
  }

  // 方法按名称排序，属性/enum 成员保持文档顺序（枚举值顺序有意义）
  return [...merged.values()];
}

function entryKindOf(text: string, fallback: EntryKind): EntryKind {
  const title = /^#\s+.+?\b(class|interface|enum|type)\b/im.exec(text);
  const word = title?.[1];
  if (word === "class" || word === "interface" || word === "enum" || word === "type") return word;
  return fallback;
}

function summaryOf(text: string): string {
  const withoutTitle = text.replace(/^#\s+.+$/m, "");
  const head = withoutTitle.split(/^##\s+/m)[0] ?? "";
  const paragraphs = head
    .split(/\n{2,}/)
    .map((part) => plainText(part))
    .filter((part) => part !== "" && !part.startsWith(">"));
  return clip(paragraphs[0] ?? "", MAX_SUMMARY);
}

function parseDocFile(file: string, kind: EntryKind, relFile: string): IndexEntry {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const name = path.basename(file, ".md");
  const actualKind = entryKindOf(text, kind);
  const details = readDetails(text);

  const rows: IndexMember[] = [];
  for (const table of readTables(text)) {
    const memberKind = memberKindFor(table.section, table.header);
    if (!memberKind) continue;
    const member = memberFromRow(table, memberKind);
    if (member) rows.push(member);
  }

  const members = mergeMembers(rows, details);
  if (actualKind === "class") {
    members.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "constructor" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }

  const entry: IndexEntry = {
    name,
    kind: actualKind,
    file: relFile,
    summary: summaryOf(text),
    members,
  };
  return entry;
}

/**
 * 从 EDA.md 的属性表推出 `eda.xxx` 访问路径。
 * 只有真的挂在 eda 上的类才有 callPath；IPCB_* 这类由接口返回的对象没有。
 */
function assignCallPaths(entries: IndexEntry[]): void {
  const eda = entries.find((entry) => entry.name === "EDA");
  const typeToProp = new Map<string, string>();
  for (const member of eda?.members ?? []) {
    const match = /^function\s+([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_]+)/.exec(member.signature ?? "");
    const prop = match?.[1];
    const type = match?.[2];
    if (prop && type) typeToProp.set(type, prop);
  }

  for (const entry of entries) {
    if (entry.kind !== "class") continue;
    if (entry.name === "EDA") {
      entry.callPath = "eda";
      entry.summary ||= "全局入口变量 eda，所有模块都挂在它下面";
      continue;
    }
    const prop = typeToProp.get(entry.name);
    if (prop) entry.callPath = `eda.${prop}`;
  }
}

function listDocs(): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const spec of DIR_KINDS) {
    const dir = path.join(REFERENCES_DIR, spec.dir);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".md")) continue;
      const file = path.join(dir, name);
      if (!statSync(file).isFile()) continue;
      entries.push(parseDocFile(file, spec.kind, `references/${spec.dir}/${name}`));
    }
  }
  return entries;
}

function readSourceMeta(): { repo: string; sha: string } {
  let sha = "";
  try {
    sha = readFileSync(SOURCE_SHA_FILE, "utf8").trim();
  } catch {
    sha = "unknown";
  }
  return { repo: "easyeda/easyeda-api-skill", sha };
}

function main(): void {
  const entries = listDocs();
  assignCallPaths(entries);
  const counts: Record<EntryKind, number> = { class: 0, interface: 0, enum: 0, type: 0 };
  for (const entry of entries) counts[entry.kind] += 1;

  const meta = readSourceMeta();
  const index: ApiIndexFile = {
    version: 1,
    source: { ...meta, generatedAt: new Date().toISOString() },
    counts,
    entries,
  };

  const body = `${JSON.stringify(index)}\n`;
  writeFileSync(OUTPUT_FILE, body, "utf8");
  const members = entries.reduce((sum, entry) => sum + entry.members.length, 0);
  const kb = Math.round(Buffer.byteLength(body, "utf8") / 1024);
  process.stdout.write(
    `索引已生成：${entries.length} 条（${counts.class} 类 / ${counts.interface} 接口 / ${counts.enum} 枚举 / ${counts.type} 类型），` +
      `${members} 个成员，${kb} KB → ${path.relative(ROOT, OUTPUT_FILE)}\n`,
  );
}

main();
