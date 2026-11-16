import { readFileSync } from "node:fs";
import path from "node:path";

import { assetsDir } from "../core/assets.ts";

/**
 * 格式类型解析表：加载 assets/format/registry.json。
 *
 * registry.json 由 scripts/build-format-registry.ts 从 easyeda-format-skill 的
 * validate.js 抽出（OUTER_SCHEMA / TYPE_TO_SCHEMA / DOC_TYPES / DOC_TYPE_MAP / TYPE_MAP）。
 * 运行时只读这份 JSON 和 schemas/，不依赖 ajv，也不联网。
 */

export interface FormatRegistrySource {
  repo: string;
  sha: string;
  validateScript: string;
  generatedAt: string;
}

export interface FormatRegistryCounts {
  schemas: number;
  docTypes: number;
  docTypeMap: number;
  typeMap: number;
}

export interface FormatRegistry {
  version: number;
  source: FormatRegistrySource;
  counts: FormatRegistryCounts;
  outerSchema: unknown;
  /** schema key（如 t-pcb-via）→ schemas/ 下的文件名（如 t-pcb-via.json）。 */
  typeToSchema: Record<string, string>;
  /** 已知文档类型（BLOB / BOARD / … / SYMBOL）。 */
  docTypes: string[];
  /** `<文档类型>_<图元名>`（小写）→ schema key。 */
  docTypeMap: Record<string, string>;
  /** 裸名 / 前缀名 / 别名（小写）→ schema key。 */
  typeMap: Record<string, string>;
}

export type JsonSchema = Record<string, unknown>;

const registryCache = new Map<string, FormatRegistry>();
const schemaCache = new Map<string, JsonSchema | null>();

/** assets/format 的绝对路径。 */
export function formatAssetsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(assetsDir(env), "format");
}

function readJsonFile<T>(file: string, hint: string): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (error) {
    throw new Error(
      `读取 ${file} 失败：${error instanceof Error ? error.message : String(error)}（${hint}）`,
    );
  }
}

/** 载入解析表（按 assets 根目录缓存）。缺失说明打包没带上 assets/format。 */
export function loadRegistry(env: NodeJS.ProcessEnv = process.env): FormatRegistry {
  const file = path.join(formatAssetsRoot(env), "registry.json");
  const cached = registryCache.get(file);
  if (cached) return cached;
  const registry = readJsonFile<FormatRegistry>(
    file,
    "运行 node scripts/build-format-registry.ts 生成",
  );
  registryCache.set(file, registry);
  return registry;
}

export function loadOuterSchema(env: NodeJS.ProcessEnv = process.env): unknown {
  return loadRegistry(env).outerSchema;
}

/** 已知文档类型，原样（大写）返回。 */
export function knownDocTypes(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...loadRegistry(env).docTypes];
}

export function isKnownDocType(docType: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const wanted = docType.trim().toUpperCase();
  return loadRegistry(env).docTypes.includes(wanted);
}

/**
 * 解析 schema key，规则与源仓库 validate.js 的 resolveSchemaKey 一致：
 * 给了 docType 先查 `<docType>_<type>`，否则查裸名/前缀名表；
 * 都没命中就原样返回小写（可直接传 schema key，如 t-pcb-via）。
 */
export function resolveSchemaKey(
  type: string,
  docType?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const registry = loadRegistry(env);
  const lower = type.trim().toLowerCase();
  if (docType !== undefined && docType.trim() !== "") {
    const scoped = registry.docTypeMap[`${docType.trim().toLowerCase()}_${lower}`];
    if (scoped) return scoped;
  }
  return registry.typeMap[lower] ?? lower;
}

/** 图元是否登记在指定文档类型下；直接给 schema 文件名也认。 */
export function isRegisteredPair(
  type: string,
  docType: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const registry = loadRegistry(env);
  const lower = type.trim().toLowerCase();
  if (registry.docTypeMap[`${docType.trim().toLowerCase()}_${lower}`]) return true;
  return Boolean(registry.typeToSchema[lower]);
}

/** schema key 是否在注册表里（即 validate.js require 过的那 198 个）。 */
export function hasSchema(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(loadRegistry(env).typeToSchema[key.trim().toLowerCase()]);
}

/** schema 在 assets 里的相对路径（如 format/schemas/t-pcb-via.json），未知返回 null。 */
export function schemaRelativePath(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const file = loadRegistry(env).typeToSchema[key.trim().toLowerCase()];
  return file ? `format/schemas/${file}` : null;
}

/** 从 assets/format/schemas 读 schema 并缓存；未知 key 返回 null。 */
export function loadSchema(key: string, env: NodeJS.ProcessEnv = process.env): JsonSchema | null {
  const normalized = key.trim().toLowerCase();
  const file = loadRegistry(env).typeToSchema[normalized];
  if (!file) return null;
  const full = path.join(formatAssetsRoot(env), "schemas", file);
  if (schemaCache.has(full)) return schemaCache.get(full) ?? null;
  let schema: JsonSchema | null = null;
  try {
    schema = readJsonFile<JsonSchema>(full, "schemas/ 应从 easyeda-format-skill 原样复制");
  } catch {
    schema = null;
  }
  schemaCache.set(full, schema);
  return schema;
}

/** 清空缓存（测试里换 assets 根目录时用）。 */
export function clearFormatCaches(): void {
  registryCache.clear();
  schemaCache.clear();
}
