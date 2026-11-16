import { z } from "zod";

import { ToolError, defineTool, type ToolDef } from "../mcp/types.ts";
import { getEntry, getFormatDoc, loadApiIndex, search, type ApiEntryKind } from "./index.ts";

/**
 * API 文档检索工具：查 EasyEDA Pro 扩展 API 的类、成员签名，以及文件源格式说明。
 * 这些工具只读 assets/api-docs，不连编辑器。
 */

const KINDS = ["class", "interface", "enum", "type"] as const;

export const apiSearchTool = defineTool({
  name: "api_search",
  description:
    "检索 EasyEDA Pro 扩展 API 文档（类/接口/枚举/类型）。query 支持英文名、中文描述与点号写法" +
    "（如 `pcb_PrimitiveVia.create`）。写代码前先查签名：返回 Promise 的 API 必须 await；" +
    "PCB 坐标与尺寸单位是 mil；枚举参数用文档里的成员名（如 EPCB_LayerId.TOP），不要猜数字。",
  input: {
    query: z.string().min(1).describe("检索词，如 过孔、EPCB_LayerId、pcb_PrimitiveVia.create"),
    kind: z.enum(KINDS).optional().describe("只看某一类条目"),
    limit: z.number().int().min(1).max(100).optional().describe("返回条数上限，默认 20"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ query, kind, limit }, ctx) => {
    const results = search(query, { kind: kind as ApiEntryKind | undefined, limit }, ctx.env);
    return { query, count: results.length, results };
  },
});

export const apiGetTool = defineTool({
  name: "api_get",
  description:
    "取一个类/接口/枚举/类型的成员表与访问路径（如 `eda.pcb_PrimitiveVia`）；" +
    "带 member 时返回该成员在文档里的签名段落原文。className 可用点号路径或类名。" +
    "写 PCB 代码时注意：坐标与尺寸单位是 mil，返回 Promise 的 API 必须 await，枚举不要猜数字。",
  input: {
    className: z
      .string()
      .min(1)
      .describe("类名或访问路径，如 PCB_PrimitiveVia、eda.pcb_PrimitiveVia"),
    member: z.string().optional().describe("成员名，如 create、getAll；缺省返回整个成员表"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ className, member }, ctx) => {
    const entry = getEntry(className, member, ctx.env);
    if (!entry) {
      throw new ToolError("NOT_FOUND", `没有找到 ${className}${member ? `.${member}` : ""}`, {
        hint: "先用 api_search 找准确的类名与成员名。",
      });
    }
    return entry;
  },
});

export const apiFormatDocTool = defineTool({
  name: "api_format_doc",
  description:
    "读取 EasyEDA 文件源格式说明（project / schematic / pcb 及各自的 index）。" +
    "用于直接解析或修改工程源文件；只想调用编辑器 API 时用 api_search / api_get。" +
    "格式里未注明单位的坐标按 0.01 inch（10mil）理解。",
  input: {
    type: z.enum(["project", "schematic", "pcb"]).describe("格式分类"),
    name: z
      .string()
      .optional()
      .describe("篇名，如 index、primitive、wire、component；缺省读该分类的 index"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ type, name }, ctx) => {
    const doc = getFormatDoc(type, name, ctx.env);
    if (!doc) {
      throw new ToolError("NOT_FOUND", `没有找到格式文档 ${type}${name ? `/${name}` : ""}`, {
        hint: "可用的分类是 project、schematic、pcb。",
      });
    }
    return doc;
  },
});

export const apiDocsTools: ToolDef[] = [apiSearchTool, apiGetTool, apiFormatDocTool];

/** 索引入口信息（给 info / 诊断类工具用）。 */
export function apiIndexSummary(env: NodeJS.ProcessEnv = process.env): {
  version: number;
  source: string;
  sha: string;
  counts: Record<ApiEntryKind, number>;
} {
  const index = loadApiIndex(env);
  return {
    version: index.version,
    source: index.source.repo,
    sha: index.source.sha,
    counts: index.counts,
  };
}
