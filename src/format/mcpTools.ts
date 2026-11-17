import { z } from "zod";

import { ToolError, defineTool, type ToolDef } from "../mcp/types.ts";
import {
  getExample,
  getFormatLog,
  getPrimitive,
  listTypes,
  validateFormat,
  validateLine,
  type RecordValidation,
} from "./index.ts";

/**
 * 文件格式工具：查类型、看图元定义与示例、校验一行格式数据。
 *
 * 下面几条是 SKILL.md 里反复强调的硬规则，直接写进工具描述，避免模型只读参数就猜：
 * - 同名图元在不同文档类型下 schema 不同，类型名要带文档前缀（PCB_LINE）或给 docType；
 * - DOCHEAD 是第一行，顺序 DOCHEAD → CANVAS → 其他图元；
 * - 同一原子多行时 ticket 大者胜，平票比文档头 client，字典序大者胜；
 * - 删除 = 再写一行、载荷置空串，不是抹掉旧行；
 * - META 绝不能写空串载荷，删 META 用 DELETE_DOC。
 */

const FORMAT_RULES =
  "关键约束：DOCHEAD 必须先于 CANVAS；同一原子按 ticket 大者胜，平票比较 client；删除用空载荷追加记录，META 不可空载荷。完整规则用 skill_docs 读取 easyeda-format/SKILL.md。";

export const formatListTypesTool = defineTool({
  name: "format_list_types",
  description:
    "列出嘉立创EDA/EasyEDA Pro 文件格式的图元类型：中文名、类型名、所属文档域与 schema key。" +
    "校验或生成数据前先在这里确认类型名与文档域。" +
    "同名图元在不同文档下 schema 不同，用 `<文档类型>_<图元名>`（如 PCB_LINE）或另外给 docType。" +
    "query 支持中文名（过孔、焊盘）、类型名（TPcbVia）与 schema key（t-pcb-via）。\n",
  input: {
    docType: z
      .string()
      .optional()
      .describe("只看某个文档类型，如 PCB、SCH_PAGE、PANEL_LIB、REFERENCE"),
    query: z.string().optional().describe("检索词：中文名、类型名或 schema key"),
    limit: z.number().int().min(1).max(200).optional().describe("返回条数上限，默认 50"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ docType, query, limit }, ctx) => {
    const results = listTypes({ docType, query, limit }, ctx.env);
    return { count: results.length, docType: docType ?? null, query: query ?? null, results };
  },
});

export const formatGetPrimitiveTool = defineTool({
  name: "format_get_primitive",
  description:
    "取一个图元的字段定义：primitives 原文、对应 schema 路径、示例文档里的真实格式行。" +
    "type 可写类型名（TPcbVia）、外层类型（VIA / PCB_VIA）、schema key（t-pcb-via）或中文名（过孔）；" +
    "跨文档类型时给 docType（如 type=LINE、docType=PCB 取走线而不是导线）。" +
    "字段表里 PCB 坐标与尺寸单位是 mil，原理图沿用 0.01 inch；不要照 schema 的 required 猜必填，" +
    "已知 schema 与真机写盘有出入（如 VIA 的 zIndex），校验时会以 WARNING 提示。\n",
  input: {
    type: z.string().min(1).describe("类型名 / 外层类型 / schema key / 中文名"),
    docType: z.string().optional().describe("文档类型，如 PCB、SCH_PAGE、PANEL"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ type, docType }, ctx) => {
    const result = getPrimitive(type, docType, ctx.env);
    if (!result) {
      throw new ToolError(
        "NOT_FOUND",
        `没有找到图元 ${type}${docType ? `（docType=${docType}）` : ""}`,
        {
          hint: "先用 format_list_types 确认类型名；跨文档类型时补上 docType。",
        },
      );
    }
    return result;
  },
});

function parsePayload(raw: unknown, type: string): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (text === "") return "";
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ToolError("INVALID_JSON", `${type} 的 data 不是合法 JSON`, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export const formatValidateRecordTool = defineTool({
  name: "format_validate_record",
  description:
    "校验一条格式数据：line 给完整记录行，或 type + data 给载荷（JSON 字符串或对象，空串表示删除）。docType 用于区分文档域；返回 valid/errors/warnings，已知 schema 差异降为 warning。" +
    FORMAT_RULES,
  input: {
    line: z.string().optional().describe('整行：`{"type":"VIA","id":"...","ticket":1}||{...}`'),
    type: z.string().optional().describe("图元类型，如 PCB_LINE、VIA；给了 line 时可省略"),
    data: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional()
      .describe("内层载荷：JSON 字符串或对象；空串表示删除"),
    docType: z.string().optional().describe("文档类型，如 PCB、SCH_PAGE；用于解析裸类型名"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ line, type, data, docType }) => {
    if (line !== undefined && line.trim() !== "") {
      const result: RecordValidation = validateLine(line, docType);
      return result;
    }
    if (type === undefined || type.trim() === "") {
      throw new ToolError("INVALID_ARGUMENT", "需要 line，或者 type + data", {
        hint: "整行用 line；只校验载荷用 type + data。",
      });
    }
    if (data === undefined) {
      throw new ToolError("INVALID_ARGUMENT", `缺少 ${type} 的 data（内层载荷）`);
    }
    return validateFormat(type, parsePayload(data, type), docType);
  },
});

export const formatExampleTool = defineTool({
  name: "format_example",
  description:
    "取某个图元的真实示例：示例 Markdown 全文与其中带 `||` 的格式行。" +
    "示例行直接来自编辑器写盘数据，比 schema 更能代表真实形态；生成数据时照着示例补字段。" +
    "示例行同样遵循：DOCHEAD、CANVAS 在前；删除用空串载荷；META 不能空串；" +
    "多行同一原子按 ticket 大者胜、平票比 client 字典序大者胜。" +
    "type 支持类型名、外层类型、schema key 或中文名，跨域时给 docType。",
  input: {
    type: z.string().min(1).describe("类型名 / 外层类型 / schema key / 中文名"),
    docType: z.string().optional().describe("文档类型，如 PCB、SCH_PAGE、PANEL"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ type, docType }, ctx) => {
    const result = getExample(type, docType, ctx.env);
    if (!result) {
      throw new ToolError("NOT_FOUND", `没有找到图元 ${type} 的示例`, {
        hint: "REFERENCE 里的枚举类型可能没有示例；先用 format_list_types 确认类型。",
      });
    }
    return result;
  },
});

export const formatChangelogTool = defineTool({
  name: "format_changelog",
  description:
    "读取 FORMATLOG.md：V3 → V4 文件格式差异与后续补充（文档类型扩充、CANVAS、单位、删除语义、仿真设定等）。" +
    "写盘前拿不准字段含义或版本差异时先看这里；类型名同样要带文档前缀或另给 docType。" +
    "注意版本口径：3.0 起同一原子按 ticket 大者胜、平票比文档头 client 字典序大者胜；" +
    "删除是追加一行并把载荷置空串；META 不能用空串删除，要写 DELETE_DOC。",
  input: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: (_args, ctx) => {
    const log = getFormatLog(ctx.env);
    if (!log) {
      throw new ToolError("NOT_FOUND", "assets/format/FORMATLOG.md 不存在", {
        hint: "确认打包时带上了 assets/format。",
      });
    }
    return { file: log.file, text: log.text };
  },
});

export const formatTools: ToolDef[] = [
  formatListTypesTool,
  formatGetPrimitiveTool,
  formatValidateRecordTool,
  formatExampleTool,
  formatChangelogTool,
];
