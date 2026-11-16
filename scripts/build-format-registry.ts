/// <reference types="node" />
/**
 * 生成 assets/format/registry.json（格式类型 → JSON Schema 的解析表）。
 *
 * 数据来源是 easyeda-format-skill 仓库根目录的 validate.js：它用四个对象字面量
 * 维护 OUTER_SCHEMA、TYPE_TO_SCHEMA、DOC_TYPES、DOC_TYPE_MAP、TYPE_MAP。
 * 这里不 require ajv，也不执行 validate.js 的校验逻辑，只把这几段对象字面量
 * 抽出来用 node:vm 求值，写成运行时可加载的 JSON。
 *
 * 运行方式（Node 26 自带 TypeScript 类型擦除，不需要 tsx）：
 *   node scripts/build-format-registry.ts
 *   node scripts/build-format-registry.ts --source D:\Projects\GitHub\easyeda-format-skill
 *
 * 默认从本仓库同级的 easyeda-format-skill 读源文件；源仓库只读，不做任何改动。
 * 源仓库 HEAD 记在 assets/format/.source-sha，重新生成后与生成物一起提交。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "assets", "format");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "registry.json");
const SOURCE_SHA_FILE = path.join(OUTPUT_DIR, ".source-sha");

const REPO = "easyeda/easyeda-format-skill";

interface FormatRegistryFile {
  version: number;
  source: { repo: string; sha: string; validateScript: string; generatedAt: string };
  counts: {
    schemas: number;
    docTypes: number;
    docTypeMap: number;
    typeMap: number;
  };
  outerSchema: unknown;
  /** schema key（如 t-pcb-via）→ schemas/ 下的文件名（如 t-pcb-via.json）。 */
  typeToSchema: Record<string, string>;
  docTypes: string[];
  /** `<文档类型>_<图元名>`（小写）→ schema key。 */
  docTypeMap: Record<string, string>;
  /** 裸名 / 前缀名 / 别名（小写）→ schema key。 */
  typeMap: Record<string, string>;
}

function sourceDir(): string {
  const argv = process.argv.slice(2);
  const flag = argv.findIndex((item) => item === "--source");
  if (flag >= 0) {
    const value = argv[flag + 1];
    if (!value) throw new Error("--source 后面需要跟 easyeda-format-skill 仓库路径");
    return path.resolve(value);
  }
  const fromEnv = process.env.EASYEDA_FORMAT_SKILL;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(ROOT, "..", "easyeda-format-skill");
}

/**
 * 从 `const NAME = {...}` 里截出完整对象字面量。
 *
 * 不能按行或简单数大括号：description 里可能出现 `{`、`}`、`//`，
 * 所以扫描时跳过字符串与注释。返回值含最外层大括号，可直接交给 vm。
 */
function extractObjectLiteral(text: string, name: string): string {
  const marker = `const ${name} = `;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`validate.js 里找不到 ${name} 的定义`);
  const open = text.indexOf("{", start + marker.length);
  if (open < 0) throw new Error(`${name} 的定义不是对象字面量`);

  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  throw new Error(`${name} 的对象字面量没有闭合`);
}

/** 在沙箱里求值对象字面量。`require("./schemas/x.json")` 只用来拿文件名，不读文件。 */
function evaluateLiteral<T>(literal: string, name: string): T {
  const sandbox = {
    require: (id: string): string => id,
  };
  try {
    return vm.runInNewContext(`(${literal})`, sandbox, {
      timeout: 1000,
      filename: `${name}.literal.js`,
    }) as T;
  } catch (error) {
    throw new Error(`求值 ${name} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function readSha(): string {
  try {
    return readFileSync(SOURCE_SHA_FILE, "utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function main(): void {
  const source = sourceDir();
  const validateFile = path.join(source, "validate.js");
  if (!existsSync(validateFile)) {
    throw new Error(
      `找不到 ${validateFile}。用 --source <easyeda-format-skill 路径> 或设置 EASYEDA_FORMAT_SKILL 指定源仓库。`,
    );
  }
  const text = readFileSync(validateFile, "utf8").replace(/\r\n/g, "\n");

  const outerSchema = evaluateLiteral<unknown>(
    extractObjectLiteral(text, "OUTER_SCHEMA"),
    "OUTER_SCHEMA",
  );
  const rawTypeToSchema = evaluateLiteral<Record<string, string>>(
    extractObjectLiteral(text, "TYPE_TO_SCHEMA"),
    "TYPE_TO_SCHEMA",
  );
  const rawDocTypes = evaluateLiteral<Record<string, boolean>>(
    extractObjectLiteral(text, "DOC_TYPES"),
    "DOC_TYPES",
  );
  const rawDocTypeMap = evaluateLiteral<Record<string, string>>(
    extractObjectLiteral(text, "DOC_TYPE_MAP"),
    "DOC_TYPE_MAP",
  );
  const rawTypeMap = evaluateLiteral<Record<string, string>>(
    extractObjectLiteral(text, "TYPE_MAP"),
    "TYPE_MAP",
  );

  const typeToSchema: Record<string, string> = {};
  for (const [key, requiredPath] of Object.entries(rawTypeToSchema)) {
    const match = /^\.\/schemas\/(.+\.json)$/.exec(String(requiredPath));
    if (!match) throw new Error(`TYPE_TO_SCHEMA["${key}"] 不是 ./schemas/*.json：${requiredPath}`);
    const file = match[1] ?? "";
    const expected = `${key}.json`;
    if (file !== expected) {
      process.stderr.write(`提示：schema key ${key} 指向 ${file}，与 key 不同名\n`);
    }
    typeToSchema[key] = file;
  }

  const docTypes = Object.keys(rawDocTypes).sort();
  const docTypeMap = { ...rawDocTypeMap };
  const typeMap = { ...rawTypeMap };

  const missing = new Set<string>();
  for (const [key, schema] of Object.entries(docTypeMap)) {
    if (!typeToSchema[schema]) missing.add(`${key} → ${schema}`);
  }
  for (const [key, schema] of Object.entries(typeMap)) {
    if (!typeToSchema[schema]) missing.add(`${key} → ${schema}`);
  }
  if (missing.size > 0) {
    process.stderr.write(
      `警告：${missing.size} 个映射指向未注册的 schema（运行时按未知类型处理）：\n` +
        [...missing]
          .slice(0, 20)
          .map((item) => `  ${item}`)
          .join("\n") +
        "\n",
    );
  }

  const registry: FormatRegistryFile = {
    version: 1,
    source: {
      repo: REPO,
      sha: readSha(),
      validateScript: "validate.js",
      generatedAt: new Date().toISOString(),
    },
    counts: {
      schemas: Object.keys(typeToSchema).length,
      docTypes: docTypes.length,
      docTypeMap: Object.keys(docTypeMap).length,
      typeMap: Object.keys(typeMap).length,
    },
    outerSchema,
    typeToSchema,
    docTypes,
    docTypeMap,
    typeMap,
  };

  const body = `${JSON.stringify(registry)}\n`;
  writeFileSync(OUTPUT_FILE, body, "utf8");
  const kb = Math.round(Buffer.byteLength(body, "utf8") / 1024);
  process.stdout.write(
    `registry 已生成：${registry.counts.schemas} 个 schema、${registry.counts.docTypes} 个文档类型、` +
      `${registry.counts.docTypeMap} 条 docType 映射、${registry.counts.typeMap} 条类型映射，` +
      `${kb} KB → ${path.relative(ROOT, OUTPUT_FILE)}\n`,
  );
}

main();
