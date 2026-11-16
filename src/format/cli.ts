import {
  CliUsageError,
  numberValue,
  parseArgs,
  stringValue,
  type OptionSpec,
} from "../core/cliArgs.ts";
import type { Io } from "../core/io.ts";
import {
  getExample,
  getPrimitive,
  isKnownDocType,
  knownDocTypes,
  listTypes,
  validateFormat,
  validateLine,
  validateOuter,
  type RecordValidation,
} from "./index.ts";

/**
 * `lceda-connect format <动作>` 的实现。
 *
 * 动作与源仓库的 validate.js 对齐：types / show / validate / example。
 * validate 同时接受两种写法：
 *   validate [--doc D] <type> '<内层JSON>'
 *   validate [--doc D] '<外层JSON>||<内层JSON>|'
 * 校验不通过时退出码是 1，通过是 0。
 */

const OPTIONS: readonly OptionSpec[] = [
  { name: "doc", type: "string", placeholder: "D", description: "文档类型（PCB / SCH_PAGE / …）" },
  {
    name: "limit",
    aliases: ["n"],
    type: "number",
    placeholder: "N",
    description: "types 返回条数上限（默认 50）",
  },
  { name: "json", type: "boolean", description: "以 JSON 输出" },
  { name: "help", aliases: ["h"], type: "boolean", description: "显示帮助" },
];

export function formatHelpLines(): string[] {
  return [
    "",
    "  lceda-connect format  --  嘉立创EDA/EasyEDA Pro 文件格式知识库与校验",
    "  ------------------------------------------------------------",
    "  用法: lceda-connect format <动作> [参数] [选项]",
    "",
    "  动作:",
    "    types [关键词]          列出图元类型（支持中文名、类型名、schema key）",
    "    show <类型>             图元字段定义原文 + schema 路径 + 示例行",
    "    validate [类型] <数据>  校验内层载荷，或校验一整行 `{外层}||{内层}|`",
    "    example <类型>          真实示例文档与格式行",
    "    help                    这个帮助",
    "",
    "  选项:",
    "    --doc <D>               文档类型：PCB、SCH_PAGE、PANEL_LIB、REFERENCE …",
    "    --limit, -n <N>         types 返回条数上限（默认 50，最多 200）",
    "    --json                  以 JSON 输出",
    "",
    "  类型名:",
    "    同名图元在不同文档类型下 schema 不同。用 <文档类型>_<图元名> 前缀名（PCB_LINE），",
    "    或给裸名加 --doc。裸名按 SCH_PAGE > SCH > SYMBOL > PCB > 其他 解析，跨域不可靠。",
    "",
    "  硬规则:",
    "    DOCHEAD 必须是第一行，顺序 DOCHEAD → CANVAS → 其他图元；",
    "    同一原子多行时 ticket 大者胜，平票比文档头 client，字典序大者胜；",
    "    删除 = 再写一行、载荷置空串；META 绝不能写空串（删 META 用 DELETE_DOC）。",
    "",
    "  例子:",
    "    lceda-connect format types 过孔",
    "    lceda-connect format types --doc PCB",
    "    lceda-connect format show PCB_LINE",
    "    lceda-connect format show LINE --doc PCB",
    '    lceda-connect format validate PCB_LINE \'{"netName":"+5V"}\'',
    '    lceda-connect format validate \'{"type":"VIA","id":"c34473f1ef63f532","ticket":1}||{...}|\'',
    "    lceda-connect format example TPcbVia --json",
    "",
  ];
}

function usageError(io: Io, message: string): number {
  io.err(`  ${message}`);
  for (const line of formatHelpLines()) io.err(line);
  return 1;
}

function printTypesText(
  io: Io,
  query: string | undefined,
  results: ReturnType<typeof listTypes>,
): void {
  if (results.length === 0) {
    io.out(`  没有匹配${query ? `「${query}」` : ""}的类型。试试更短的关键词，或去掉 --doc。`);
    return;
  }
  io.out("");
  io.out(`  ${query ? `「${query}」命中 ` : ""}${results.length} 个类型：`);
  for (const item of results) {
    const docs = item.docTypes.length > 0 ? `  [${item.docTypes.join(" / ")}]` : "";
    io.out(`  ${item.className}${item.chinese ? `  ${item.chinese}` : ""}${docs}`);
    io.out(`    ${item.primitive}${item.schema ? `  → schema ${item.schema}` : ""}`);
  }
  io.out("");
}

function printPrimitiveText(io: Io, result: NonNullable<ReturnType<typeof getPrimitive>>): void {
  io.out("");
  io.out(`  ${result.className}${result.chinese ? `  ${result.chinese}` : ""}`);
  if (result.docTypes.length > 0) io.out(`  文档域: ${result.docTypes.join(" / ")}`);
  io.out(`  图元文档: assets/format/${result.primitive}`);
  io.out(
    `  JSON Schema: ${result.schemaFile ? `assets/format/${result.schemaFile.file}` : "（无）"}`,
  );
  if (result.exampleFile) {
    io.out(
      `  示例: assets/format/${result.exampleFile.file}（${result.exampleFile.lines.length} 行）`,
    );
  }
  io.out("");
  io.out("  ---- primitives 原文 ----");
  io.out("");
  for (const line of result.text.split(/\r?\n/)) io.out(`  ${line}`);
  io.out("");
  if (result.exampleFile && result.exampleFile.lines.length > 0) {
    io.out("  ---- 示例行 ----");
    for (const line of result.exampleFile.lines) io.out(`  ${line}`);
    io.out("");
  }
}

function printValidationText(io: Io, result: RecordValidation): void {
  const head = [
    result.valid ? "✓ 合法" : "✗ 不合法",
    result.type ? `type=${result.type}` : "",
    result.schema ? `schema=${result.schema}` : "",
    result.docType ? `docType=${result.docType}` : "",
  ].filter((item) => item !== "");
  io.out(head.join("  "));
  for (const warning of result.warnings) {
    io.out(`  [${warning.severity}] ${warning.field}: ${warning.message}`);
  }
  for (const error of result.errors) {
    io.out(`  [${error.severity}] ${error.field}: ${error.message}`);
  }
}

function printExampleText(io: Io, result: NonNullable<ReturnType<typeof getExample>>): void {
  io.out("");
  io.out(`  ${result.className}${result.chinese ? `  ${result.chinese}` : ""}`);
  if (result.docTypes.length > 0) io.out(`  文档域: ${result.docTypes.join(" / ")}`);
  io.out(`  示例文档: assets/format/${result.file}（${result.lines.length} 行格式数据）`);
  io.out("");
  for (const line of result.text.split(/\r?\n/)) io.out(`  ${line}`);
  io.out("");
}

/** 显式给了 type 又给整行时，外层照校、内层按显式 type 校（兼容 validate.js 的行为）。 */
function validateTypedLine(
  type: string,
  raw: string,
  docType: string | undefined,
): RecordValidation {
  const lineResult = validateLine(raw, docType);
  if (lineResult.type === "" || lineResult.type === type || lineResult.payload === undefined) {
    return lineResult;
  }
  const payloadResult = validateFormat(type, lineResult.payload, docType);
  const outerErrors = lineResult.outer === undefined ? [] : validateOuter(lineResult.outer);
  const errors = [...outerErrors, ...payloadResult.errors];
  const merged: RecordValidation = {
    valid: errors.length === 0,
    type,
    schema: payloadResult.schema,
    errors,
    warnings: payloadResult.warnings,
  };
  if (lineResult.docType !== undefined) merged.docType = lineResult.docType;
  if (lineResult.outer !== undefined) merged.outer = lineResult.outer;
  merged.payload = lineResult.payload;
  return merged;
}

export async function runFormatCommand(
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv, OPTIONS);
  } catch (error) {
    if (error instanceof CliUsageError) return usageError(io, error.message);
    throw error;
  }

  const json = parsed.values.json === true;
  const [action = "help", ...positionals] = parsed.positionals;
  if (parsed.values.help === true || action === "help" || action === "--help" || action === "-h") {
    for (const line of formatHelpLines()) io.out(line);
    return 0;
  }

  const docType = stringValue(parsed, "doc");
  if (docType !== undefined && !isKnownDocType(docType, env)) {
    io.err(`  未知的文档类型: ${docType}`);
    io.err(`  已知文档类型: ${knownDocTypes(env).join(", ")}`);
    return 1;
  }

  if (action === "types") {
    if (positionals.length > 1)
      return usageError(io, `多余的参数: ${positionals.slice(1).join(" ")}`);
    const query = positionals[0];
    const limit = numberValue(parsed, "limit");
    const results = listTypes({ docType, query, limit }, env);
    if (json) {
      io.out(
        JSON.stringify(
          { query: query ?? null, docType: docType ?? null, count: results.length, results },
          null,
          2,
        ),
      );
    } else {
      printTypesText(io, query, results);
    }
    return 0;
  }

  if (action === "show") {
    const type = positionals[0];
    if (!type) return usageError(io, "show 需要一个类型名，如 PCB_LINE 或 TPcbVia。");
    if (positionals.length > 1)
      return usageError(io, `多余的参数: ${positionals.slice(1).join(" ")}`);
    const result = getPrimitive(type, docType, env);
    if (!result) {
      io.err(
        `  没有找到图元 ${type}${docType ? `（--doc ${docType}）` : ""}。先用 format types 查类型名。`,
      );
      return 1;
    }
    if (json) io.out(JSON.stringify(result, null, 2));
    else printPrimitiveText(io, result);
    return 0;
  }

  if (action === "validate") {
    if (positionals.length === 0) {
      return usageError(
        io,
        "validate 需要数据：`validate <类型> '<JSON>'` 或 `validate '<整行>'`。",
      );
    }

    let result: RecordValidation;
    if (positionals.length === 1) {
      const raw = positionals[0] ?? "";
      if (!raw.includes("||")) {
        return usageError(io, "只给一段 JSON 时要用整行写法（含外层与 `||` 分隔符）。");
      }
      result = validateLine(raw, docType);
    } else {
      const type = positionals[0] ?? "";
      const raw = positionals.slice(1).join(" ").trim();
      if (raw.includes("||")) {
        result = validateTypedLine(type, raw, docType);
      } else {
        let data: unknown;
        try {
          data = raw === "" ? "" : (JSON.parse(raw) as unknown);
        } catch (error) {
          io.err(`  数据不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
          io.err("  提示：整行数据要写成 `{外层JSON}||{内层JSON}|` 的形式。");
          return 1;
        }
        result = validateFormat(type, data, docType);
      }
    }

    if (json) {
      io.out(JSON.stringify(result, null, 2));
    } else {
      printValidationText(io, result);
    }
    return result.valid ? 0 : 1;
  }

  if (action === "example") {
    const type = positionals[0];
    if (!type) return usageError(io, "example 需要一个类型名，如 TPcbVia。");
    if (positionals.length > 1)
      return usageError(io, `多余的参数: ${positionals.slice(1).join(" ")}`);
    const result = getExample(type, docType, env);
    if (!result) {
      io.err(`  没有找到图元 ${type} 的示例。REFERENCE 下的枚举类型可能没有示例。`);
      return 1;
    }
    if (json) io.out(JSON.stringify(result, null, 2));
    else printExampleText(io, result);
    return 0;
  }

  return usageError(io, `不认识的命令: ${action}`);
}
