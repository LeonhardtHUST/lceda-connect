import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { assetsDir } from "../core/assets.ts";

/**
 * EasyEDA Pro API 文档检索。
 *
 * 数据是 scripts/build-api-index.ts 生成的 assets/api-docs/index.json，
 * 原文是 assets/api-docs/references/ 下从 easyeda-api-skill 收进来的 Markdown。
 * 这里只做加载、打分检索与取原文，不联网、不依赖 ws。
 */

export type ApiEntryKind = "class" | "interface" | "enum" | "type";
export type ApiMemberKind = "method" | "property" | "enum-member" | "constructor";

export interface ApiMember {
  name: string;
  kind: ApiMemberKind;
  /** 单个成员的签名（多行已压成一行）。 */
  signature?: string;
  summary?: string;
  /** 属性类型，如 `string`、`() => void`。 */
  type?: string;
  /** 枚举成员值，如 `27`。 */
  value?: string;
}

export interface ApiEntry {
  name: string;
  kind: ApiEntryKind;
  /** 相对 assets/api-docs 的原文路径。 */
  file: string;
  summary: string;
  /** 类在编辑器里的访问路径，如 `eda.pcb_PrimitiveVia`；接口/枚举/类型没有。 */
  callPath?: string;
  members: ApiMember[];
}

export interface ApiIndexFile {
  version: number;
  source: { repo: string; sha: string; generatedAt: string };
  counts: Record<ApiEntryKind, number>;
  entries: ApiEntry[];
}

export interface ApiSearchOptions {
  kind?: ApiEntryKind;
  limit?: number;
}

export interface ApiSearchHit {
  name: string;
  kind: ApiEntryKind;
  file: string;
  summary: string;
  callPath?: string;
  /** 命中打分，仅用于排序，不承诺稳定数值。 */
  score: number;
  member?: Pick<ApiMember, "name" | "kind" | "signature" | "summary" | "type" | "value">;
}

export interface ApiEntryDetail {
  name: string;
  kind: ApiEntryKind;
  file: string;
  summary: string;
  callPath?: string;
  members: ApiMember[];
}

export interface ApiMemberText {
  className: string;
  member: string;
  kind: ApiMemberKind;
  file: string;
  /** 原文里的签名段落（从 `### 成员名` 到下一个成员之前）。 */
  text: string;
}

export interface FormatDoc {
  type: string;
  name: string;
  file: string;
  text: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const cache = new Map<string, ApiIndexFile>();

function apiDocsRoot(env: NodeJS.ProcessEnv): string {
  return path.join(assetsDir(env), "api-docs");
}

export const API_DOCS_UPSTREAM = "https://prodocs.lceda.cn/cn/api/";

export const API_DOCS_MISSING =
  "API 文档是可选资料，npm 包不附带。请将自备资料生成的索引 index.json 与原文放入 " +
  "LCEDA_CONNECT_ASSETS 指向目录的 api-docs/ 下。上游 API 文档：" +
  API_DOCS_UPSTREAM;

/** 是否安装可选 API 文档索引；按调用方环境定位，不回退到其他资产目录。 */
export function apiDocsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(path.join(apiDocsRoot(env), "index.json"));
}

export function loadApiIndex(env: NodeJS.ProcessEnv = process.env): ApiIndexFile {
  const file = path.join(apiDocsRoot(env), "index.json");
  const cached = cache.get(file);
  if (cached) return cached;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`${API_DOCS_MISSING}（找不到 API 索引：${file}）`);
  }
  const index = JSON.parse(raw) as ApiIndexFile;
  cache.set(file, index);
  return index;
}

function normalized(text: string | undefined): string {
  return (text ?? "").trim().toLowerCase();
}

function textScore(text: string, query: string): number {
  if (text === "" || query === "") return 0;
  if (text === query) return 1000;
  if (text.startsWith(query)) return 700;
  if (text.includes(query)) return 400;
  return 0;
}

interface Candidate {
  score: number;
  member?: ApiMember;
}

/**
 * 给一条索引条目打分。
 *
 * 排序约定：名称精确 > 名称前缀 > 名称包含 > 摘要命中；
 * 带点号（`pcb_PrimitiveVia.create`）时按「类 + 成员」的组合串匹配。
 */
function scoreEntry(entry: ApiEntry, query: string): Candidate {
  const name = normalized(entry.name);
  const callPath = normalized(entry.callPath);
  let best: Candidate = { score: textScore(name, query) };

  const pathScore = textScore(callPath, query);
  if (pathScore > best.score) best = { score: pathScore };

  const summary = normalized(entry.summary);
  if (summary.includes(query)) best = { score: Math.max(best.score, 120) };

  for (const member of entry.members) {
    const memberName = normalized(member.name);
    const qualified = [`${name}.${memberName}`, callPath ? `${callPath}.${memberName}` : ""];
    let memberScore = 0;
    for (const key of qualified) {
      if (key === "") continue;
      const score = textScore(key, query);
      if (score > memberScore) memberScore = score;
    }
    // 单独命中成员名排在类名精确命中之后，避免搜类名时被成员淹没
    memberScore = Math.max(memberScore, Math.min(500, textScore(memberName, query)));
    if (memberScore > 0) {
      const bonus = query.includes(".") ? 150 : 0;
      if (memberScore + bonus > best.score) best = { score: memberScore + bonus, member };
    } else if (normalized(member.summary).includes(query) && best.score < 80) {
      best = { score: 80, member };
    }
  }

  return best;
}

/** 检索 API：名称/访问路径/成员名/摘要按优先级打分，最多返回 limit 条。 */
export function search(
  query: string,
  options: ApiSearchOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ApiSearchHit[] {
  const raw = query.trim();
  if (raw === "") return [];
  const normalizedQuery = normalized(raw.replace(/^eda\./i, ""));
  if (normalizedQuery === "") return [];

  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const hits: ApiSearchHit[] = [];
  for (const entry of loadApiIndex(env).entries) {
    if (options.kind && entry.kind !== options.kind) continue;
    const candidate = scoreEntry(entry, normalizedQuery);
    if (candidate.score <= 0) continue;
    const hit: ApiSearchHit = {
      name: entry.name,
      kind: entry.kind,
      file: entry.file,
      summary: entry.summary,
      score: candidate.score,
    };
    if (entry.callPath) hit.callPath = entry.callPath;
    if (candidate.member) {
      const member = candidate.member;
      hit.member = {
        name: member.name,
        kind: member.kind,
        ...(member.signature ? { signature: member.signature } : {}),
        ...(member.summary ? { summary: member.summary } : {}),
        ...(member.type ? { type: member.type } : {}),
        ...(member.value ? { value: member.value } : {}),
      };
    }
    hits.push(hit);
  }

  hits.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  return hits.slice(0, limit);
}

function findEntry(name: string, env: NodeJS.ProcessEnv): ApiEntry | null {
  const wanted = normalized(name);
  if (wanted === "") return null;
  for (const entry of loadApiIndex(env).entries) {
    if (normalized(entry.name) === wanted) return entry;
    if (entry.callPath && normalized(entry.callPath) === wanted) return entry;
    if (normalized(entry.file) === wanted) return entry;
  }
  // 允许不带命名空间前缀：`PrimitiveVia` 命中 `PCB_PrimitiveVia`
  const suffix = loadApiIndex(env).entries.find((entry) => normalized(entry.name).endsWith(wanted));
  return suffix ?? null;
}

/** 取类/接口/枚举/类型的成员表；带 member 时返回该成员的签名段落原文。 */
export function getEntry(
  className: string,
  member?: string,
  env: NodeJS.ProcessEnv = process.env,
): ApiEntryDetail | ApiMemberText | null {
  const entry = findEntry(className, env);
  if (!entry) return null;

  if (member === undefined || member.trim() === "") {
    const detail: ApiEntryDetail = {
      name: entry.name,
      kind: entry.kind,
      file: entry.file,
      summary: entry.summary,
      members: entry.members,
    };
    if (entry.callPath) detail.callPath = entry.callPath;
    return detail;
  }

  const indexMember = findMember(entry, member);
  if (!indexMember) return null;
  const text = readMemberSection(entry, indexMember, env);
  return {
    className: entry.name,
    member: indexMember.name,
    kind: indexMember.kind,
    file: entry.file,
    text,
  };
}

function findMember(entry: ApiEntry, name: string): ApiMember | null {
  const wanted = normalized(name).replace(/\(\)$/, "").replace(/\?$/, "");
  return (
    entry.members.find((item) => normalized(item.name) === wanted) ??
    entry.members.find((item) => normalized(item.name).replace(/\?$/, "") === wanted) ??
    null
  );
}

function readDoc(entry: ApiEntry, env: NodeJS.ProcessEnv): string {
  const file = path.join(apiDocsRoot(env), entry.file);
  try {
    return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
}

/** 从原文里切出 `### 成员名` 那一整段；原文没有详情段（枚举、纯类型）时用索引信息拼一句。 */
function readMemberSection(entry: ApiEntry, member: ApiMember, env: NodeJS.ProcessEnv): string {
  const text = readDoc(entry, env);
  if (text !== "") {
    const starts = [...text.matchAll(/^###\s+(.+)$/gm)];
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index]?.index ?? 0;
      const next = starts[index + 1]?.index ?? text.length;
      const block = text.slice(start, next).trim();
      const title = /^#\s+(.+)$/m.exec(block)?.[1] ?? "";
      const heading = (starts[index]?.[1] ?? "").replace(/[\\`*_]/g, "").trim();
      const titleMember =
        /\.([A-Za-z0-9_$]+)\s*(?:\(\))?\s*(?:method|property|accessor)?\s*$/i.exec(
          title.replace(/\\/g, ""),
        )?.[1];
      const names = [heading.toLowerCase(), (titleMember ?? "").toLowerCase()];
      if (names.includes(normalized(member.name))) return block;
    }
  }

  if (member.kind === "enum-member") {
    return `${member.name} = ${member.value ?? "?"}${member.summary ? ` — ${member.summary}` : ""}`;
  }
  if (member.signature) return member.signature;
  return member.summary ?? `${entry.name}.${member.name}`;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * 读格式（文件源格式）文档：`getFormatDoc("pcb", "primitive")`。
 * 只接受字母数字下划线与连字符，避免路径穿越。
 */
export function getFormatDoc(
  type: string,
  name?: string,
  env: NodeJS.ProcessEnv = process.env,
): FormatDoc | null {
  const cleanType = type.trim();
  if (!SAFE_SEGMENT.test(cleanType)) return null;
  const cleanName = (name ?? "").trim();
  if (cleanName !== "" && !SAFE_SEGMENT.test(cleanName)) return null;

  const rels =
    cleanName === ""
      ? [`format/${cleanType}.md`, `format/${cleanType}/index.md`]
      : [`format/${cleanType}/${cleanName}.md`];
  const root = apiDocsRoot(env);
  for (const rel of rels) {
    const full = path.resolve(root, rel);
    const relative = path.relative(root, full);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    try {
      return {
        type: cleanType,
        name: cleanName === "" ? "index" : cleanName,
        file: rel,
        text: readFileSync(full, "utf8"),
      };
    } catch {
      // 试下一个候选（pcb.md / pcb/index.md）
    }
  }
  return null;
}
