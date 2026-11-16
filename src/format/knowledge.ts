import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  formatAssetsRoot,
  loadRegistry,
  resolveSchemaKey,
  schemaRelativePath,
} from "./registry.ts";

/**
 * 格式知识检索：types-index.md 的中文名/类型名索引 + primitives 原文 + examples 示例。
 *
 * 目录结构（assets/format，原样来自 easyeda-format-skill）：
 *   types-index.md     中文名 → 类型名 → primitives 路径 → 所属文档
 *   primitives/<域>/*.md   图元字段定义，文末链接到 schema 与 example
 *   examples/<域>/*.md     真实格式行
 *   documents/*.md         15 个文档域的概述与图元索引
 *   FORMATLOG.md           V3 → V4 差异
 */

export interface FormatTypeSummary {
  /** 类型名，如 TPcbVia。 */
  className: string;
  /** 中文名称索引里的中文名，如 过孔。 */
  chinese: string;
  /** 使用该类型的文档类型，如 ["FOOTPRINT", "PCB"]。 */
  docTypes: string[];
  /** 相对 assets/format 的图元文档路径。 */
  primitive: string;
  /** schema key，如 t-pcb-via；没有 schema 链接时为 null。 */
  schema: string | null;
}

export interface FormatPrimitiveResult extends FormatTypeSummary {
  /** primitives md 原文。 */
  text: string;
  /** schema 的路径信息；没有时是 null。 */
  schemaFile: { key: string; file: string } | null;
  /** 对应 example 的真实行；没有示例时为 null。 */
  exampleFile: { file: string; lines: string[] } | null;
}

export interface FormatExampleResult {
  className: string;
  chinese: string;
  docTypes: string[];
  /** 相对 assets/format 的示例文档路径。 */
  file: string;
  /** 整篇示例 Markdown。 */
  text: string;
  /** 文中的真实格式行（含 `||` 的整行，已去掉行尾终止符与空白）。 */
  lines: string[];
}

export interface FormatTypeQuery {
  docType?: string;
  query?: string;
  limit?: number;
}

interface KnowledgeEntry {
  className: string;
  chinese: string;
  docTypes: string[];
  primitive: string;
  schema: string | null;
  example: string | null;
  schemaFile: string | null;
}

interface KnowledgeIndex {
  entries: KnowledgeEntry[];
  bySchema: Map<string, KnowledgeEntry[]>;
  byPrimitive: Map<string, KnowledgeEntry>;
  /** schema key → examples/<域>/<schema>.md（同一个 schema 在多个文档域都有示例）。 */
  examplesBySchema: Map<string, string[]>;
}

const knowledgeCache = new Map<string, KnowledgeIndex>();
const textCache = new Map<string, string | null>();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function cacheKey(env: NodeJS.ProcessEnv): string {
  return formatAssetsRoot(env);
}

function readText(rel: string, env: NodeJS.ProcessEnv): string | null {
  const root = formatAssetsRoot(env);
  const file = path.resolve(root, rel);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const cacheKeyText = `${root}::${rel}`;
  if (textCache.has(cacheKeyText)) return textCache.get(cacheKeyText) ?? null;
  let text: string | null = null;
  try {
    text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  } catch {
    text = null;
  }
  textCache.set(cacheKeyText, text);
  return text;
}

function normalizeDocTypes(text: string): string[] {
  const docs: string[] = [];
  for (const match of text.matchAll(/\[([A-Z][A-Z0-9_]*)\s+文档\]/g)) {
    const name = match[1] ?? "";
    if (name !== "" && !docs.includes(name)) docs.push(name);
  }
  return docs;
}

function schemaKeyFromLink(link: string | undefined): string | null {
  if (!link) return null;
  const file = path.basename(link);
  return file.endsWith(".json") ? file.slice(0, -".json".length) : null;
}

interface PrimitiveLinks {
  schema: string | null;
  example: string | null;
}

function readPrimitiveLinks(rel: string, env: NodeJS.ProcessEnv): PrimitiveLinks {
  const text = readText(rel, env) ?? "";
  const schema = /\]\(\.\.\/\.\.\/schemas\/([^)]+\.json)\)/.exec(text)?.[1];
  const example = /\]\(\.\.\/\.\.\/examples\/([^)]+\.md)\)/.exec(text)?.[1];
  return { schema: schemaKeyFromLink(schema), example: example ? `examples/${example}` : null };
}

/** 扫描 examples/，建立 schema key → 各文档域示例文件的映射。 */
function readExampleFiles(env: NodeJS.ProcessEnv): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const root = path.join(formatAssetsRoot(env), "examples");
  let files: string[] = [];
  try {
    files = readdirSync(root, { recursive: true, encoding: "utf8" })
      .map((item) => String(item).split(path.sep).join("/"))
      .filter((item) => item.endsWith(".md"));
  } catch {
    return map;
  }
  for (const rel of files.sort()) {
    const key = path.posix.basename(rel, ".md");
    const list = map.get(key) ?? [];
    list.push(`examples/${rel}`);
    map.set(key, list);
  }
  return map;
}

function buildIndex(env: NodeJS.ProcessEnv): KnowledgeIndex {
  const key = cacheKey(env);
  const cached = knowledgeCache.get(key);
  if (cached) return cached;

  const raw = readText("types-index.md", env);
  if (raw === null) throw new Error(`找不到 ${path.join(key, "types-index.md")}`);

  const byClass = new Map<string, KnowledgeEntry>();
  const ensure = (className: string, primitive: string): KnowledgeEntry => {
    const existing = byClass.get(className);
    if (existing) return existing;
    const links = readPrimitiveLinks(primitive, env);
    const entry: KnowledgeEntry = {
      className,
      chinese: "",
      docTypes: [],
      primitive,
      schema: links.schema,
      example: links.example,
      schemaFile: links.schema ? `schemas/${links.schema}.json` : null,
    };
    byClass.set(className, entry);
    return entry;
  };

  for (const line of raw.split("\n")) {
    // 中文名称索引：`- 过孔: [TPcbVia](primitives/FOOTPRINT/via.md) → [PCB 文档](...)`
    const chineseFirst = /^-\s+(.+?):\s+\[([^\]]+)\]\((primitives\/[^)]+\.md)\)(.*)$/.exec(line);
    if (chineseFirst) {
      const entry = ensure(chineseFirst[2] ?? "", chineseFirst[3] ?? "");
      if (entry.chinese === "") entry.chinese = (chineseFirst[1] ?? "").trim();
      entry.docTypes = [
        ...new Set([...entry.docTypes, ...normalizeDocTypes(chineseFirst[4] ?? "")]),
      ];
      continue;
    }
    // 类型名索引：`- [TPcbVia](primitives/FOOTPRINT/via.md): 过孔 → [PCB 文档](...)`
    const classFirst = /^-\s+\[([^\]]+)\]\((primitives\/[^)]+\.md)\):(.*)$/.exec(line);
    if (classFirst) {
      const entry = ensure(classFirst[1] ?? "", classFirst[2] ?? "");
      const tail = classFirst[3] ?? "";
      const chinese = tail.split("→")[0]?.trim() ?? "";
      if (entry.chinese === "" && chinese !== "") entry.chinese = chinese;
      entry.docTypes = [...new Set([...entry.docTypes, ...normalizeDocTypes(tail)])];
    }
  }

  const entries = [...byClass.values()].sort((left, right) =>
    left.className.localeCompare(right.className),
  );
  const bySchema = new Map<string, KnowledgeEntry[]>();
  const byPrimitive = new Map<string, KnowledgeEntry>();
  for (const entry of entries) {
    byPrimitive.set(entry.primitive.toLowerCase(), entry);
    if (!entry.schema) continue;
    const list = bySchema.get(entry.schema) ?? [];
    list.push(entry);
    bySchema.set(entry.schema, list);
  }

  const index: KnowledgeIndex = {
    entries,
    bySchema,
    byPrimitive,
    examplesBySchema: readExampleFiles(env),
  };
  knowledgeCache.set(key, index);
  return index;
}

/**
 * 选示例文件：优先显式 docType 对应域，其次图元文档里链接的那篇，
 * 最后同 schema 的其他文档域；优先选真的有格式行的文件。
 */
function resolveExampleFile(
  index: KnowledgeIndex,
  entry: KnowledgeEntry,
  docType: string | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  const candidates: string[] = [];
  const push = (rel: string | null): void => {
    if (rel && !candidates.includes(rel)) candidates.push(rel);
  };
  const all = entry.schema ? (index.examplesBySchema.get(entry.schema) ?? []) : [];
  const wanted = docType?.trim().toUpperCase();
  if (wanted) {
    for (const rel of all) {
      if (rel.startsWith(`examples/${wanted}/`)) push(rel);
    }
  }
  push(entry.example);
  for (const rel of all) push(rel);

  let firstExisting: string | null = null;
  for (const rel of candidates) {
    const lines = exampleLinesOf(rel, env);
    if (lines.length > 0) return rel;
    if (firstExisting === null && readText(rel, env) !== null) firstExisting = rel;
  }
  return firstExisting;
}

function matchesDocType(entry: KnowledgeEntry, docType: string | undefined): boolean {
  if (docType === undefined || docType.trim() === "") return true;
  const wanted = docType.trim().toUpperCase();
  return entry.docTypes.some((item) => item.toUpperCase() === wanted);
}

function sortScore(entry: KnowledgeEntry, query: string): number {
  const className = entry.className.toLowerCase();
  const chinese = entry.chinese.toLowerCase();
  const primitive = entry.primitive.toLowerCase();
  const schema = (entry.schema ?? "").toLowerCase();
  if (className === query || chinese === query || schema === query) return 0;
  if (className.startsWith(query) || chinese.startsWith(query)) return 1;
  if (className.includes(query) || chinese.includes(query)) return 2;
  if (schema.includes(query) || primitive.includes(query)) return 3;
  return 4;
}

function matchesQuery(entry: KnowledgeEntry, query: string): boolean {
  if (query === "") return true;
  const haystack = [
    entry.chinese,
    entry.className,
    entry.primitive,
    entry.schema ?? "",
    ...entry.docTypes,
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

/** 列出类型；支持按文档类型过滤与中英文关键词检索。 */
export function listTypes(
  options: FormatTypeQuery = {},
  env: NodeJS.ProcessEnv = process.env,
): FormatTypeSummary[] {
  const index = buildIndex(env);
  const query = (options.query ?? "").trim().toLowerCase();
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const hits = index.entries
    .filter((entry) => matchesDocType(entry, options.docType) && matchesQuery(entry, query))
    .sort(
      (left, right) =>
        sortScore(left, query) - sortScore(right, query) ||
        left.className.localeCompare(right.className),
    )
    .slice(0, limit);
  return hits.map((entry) => ({
    className: entry.className,
    chinese: entry.chinese,
    docTypes: entry.docTypes,
    primitive: entry.primitive,
    schema: entry.schema,
  }));
}

function normalizeName(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
}

function pickEntry(
  index: KnowledgeIndex,
  type: string,
  docType: string | undefined,
  env: NodeJS.ProcessEnv,
): KnowledgeEntry | null {
  const wanted = type.trim();
  if (wanted === "") return null;
  const lower = wanted.toLowerCase();
  const normalized = normalizeName(wanted);
  const candidates: KnowledgeEntry[] = [];

  // 1. 类型名 / 中文名精确命中
  for (const entry of index.entries) {
    if (entry.className.toLowerCase() === lower || entry.chinese === wanted) {
      candidates.push(entry);
    }
  }

  // 2. 外层类型名 / schema key / <文档类型>_<图元名>：先经解析表落到 schema，再反查图元
  if (candidates.length === 0) {
    const schemaKey = resolveSchemaKey(wanted, docType, env);
    candidates.push(...(index.bySchema.get(schemaKey) ?? []));
  }

  // 3. 图元文件名（via、line、t-pcb-via…），分隔符差异不影响匹配
  if (candidates.length === 0) {
    for (const entry of index.entries) {
      if (
        normalizeName(entry.primitive) === normalized ||
        normalizeName(path.posix.basename(entry.primitive, ".md")) === normalized
      ) {
        candidates.push(entry);
      }
    }
  }

  // 4. 中文名 / 类型名包含关系（如「过孔」命中「过孔类型」）
  if (candidates.length === 0) {
    for (const entry of index.entries) {
      if (entry.chinese.includes(wanted) || normalizeName(entry.className).includes(normalized)) {
        candidates.push(entry);
      }
    }
  }

  const narrowed = candidates.filter((entry) => matchesDocType(entry, docType));
  const pool = narrowed.length > 0 ? narrowed : candidates;
  return pool[0] ?? null;
}

/** 取图元定义：primitives md 原文 + 对应示例行 + schema 路径。 */
export function getPrimitive(
  type: string,
  docType?: string,
  env: NodeJS.ProcessEnv = process.env,
): FormatPrimitiveResult | null {
  const index = buildIndex(env);
  const entry = pickEntry(index, type, docType, env);
  if (!entry) return null;
  const text = readText(entry.primitive, env) ?? "";
  const example = resolveExampleFile(index, entry, docType, env);
  const exampleLines = example ? exampleLinesOf(example, env) : null;
  return {
    className: entry.className,
    chinese: entry.chinese,
    docTypes: entry.docTypes,
    primitive: entry.primitive,
    schema: entry.schema,
    text,
    schemaFile: entry.schema
      ? { key: entry.schema, file: path.posix.join("schemas", `${entry.schema}.json`) }
      : null,
    exampleFile: example ? { file: example, lines: exampleLines ?? [] } : null,
  };
}

function exampleLinesOf(rel: string, env: NodeJS.ProcessEnv): string[] {
  const text = readText(rel, env) ?? "";
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.includes("||")) lines.push(trimmed.replace(/\|+$/, "").trim());
  }
  return lines;
}

/** 取示例：示例 Markdown 全文与其中的真实格式行。 */
export function getExample(
  type: string,
  docType?: string,
  env: NodeJS.ProcessEnv = process.env,
): FormatExampleResult | null {
  const index = buildIndex(env);
  const entry = pickEntry(index, type, docType, env);
  if (!entry) return null;
  const file = resolveExampleFile(index, entry, docType, env);
  if (!file) return null;
  const text = readText(file, env) ?? "";
  return {
    className: entry.className,
    chinese: entry.chinese,
    docTypes: entry.docTypes,
    file,
    text,
    lines: exampleLinesOf(file, env),
  };
}

/** 取 FORMATLOG.md（V3 → V4 差异与历次补充）。 */
export function getFormatLog(
  env: NodeJS.ProcessEnv = process.env,
): { file: string; text: string } | null {
  const text = readText("FORMATLOG.md", env);
  if (text === null) return null;
  return { file: "FORMATLOG.md", text };
}

/** 取某个文档域的概览（documents/<DOC>.md）；文档类型不存在时返回 null。 */
export function getDocument(
  docType: string,
  env: NodeJS.ProcessEnv = process.env,
): { docType: string; file: string; text: string } | null {
  const wanted = docType.trim().toUpperCase();
  if (!loadRegistry(env).docTypes.includes(wanted)) return null;
  const file = `documents/${wanted}.md`;
  const text = readText(file, env);
  if (text === null) return null;
  return { docType: wanted, file, text };
}

/** schema 的 assets 相对路径；未知类型返回 null（给 MCP 展示用）。 */
export function schemaAssetPath(key: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return schemaRelativePath(key, env);
}

/** 文档目录是否存在（诊断用）。 */
export function formatAssetsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(path.join(formatAssetsRoot(env), "registry.json"));
}
