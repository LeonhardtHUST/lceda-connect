import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { assetPath } from "../src/core/assets.ts";
import { loadConfig } from "../src/core/config.ts";
import { createMemoryIo } from "../src/core/io.ts";
import { runFormatCommand } from "../src/format/cli.ts";
import { formatTools } from "../src/format/mcpTools.ts";
import {
  getDocument,
  getExample,
  getFormatLog,
  getPrimitive,
  listTypes,
} from "../src/format/knowledge.ts";
import {
  clearFormatCaches,
  isKnownDocType,
  isRegisteredPair,
  knownDocTypes,
  loadRegistry,
  loadSchema,
  resolveSchemaKey,
} from "../src/format/registry.ts";
import {
  parseRecordLine,
  validateFormat,
  validateLine,
  validateOuter,
  type RecordValidation,
} from "../src/format/record.ts";
import { validateSchema, type ValidationIssue } from "../src/format/schemaValidator.ts";
import { ToolError } from "../src/mcp/types.ts";

// 测试只读本地 assets/format，不连编辑器、不联网。
// 示例行来自源仓库 examples/ 的真实写盘数据；relaxations 覆盖 schema 与真机矛盾的两处。

const ENV = process.env;
const CTX = { cfg: loadConfig({ ...process.env, USERPROFILE: "C:\\Users\\tester" }, {}), env: ENV };

const EXAMPLE_ROOT = assetPath("format", "examples");

/** 一份合法的 VIA 载荷（groupId 为字符串、带 zIndex），用于常规校验。 */
const VIA_OK = {
  partitionId: "",
  groupId: "1",
  netName: "123",
  ruleName: "",
  centerX: 450,
  centerY: 855,
  holeDiameter: 12.0078,
  viaDiameter: 24.0158,
  viaType: "NORMAL",
  topSolderExpansion: null,
  bottomSolderExpansion: null,
  zIndex: -1,
  locked: false,
  unusedInnerLayers: [],
  propagationDelay: 0,
};

/** 3.0 实际写盘的 VIA：没有 zIndex，未分组时 groupId 是数字 0。 */
const VIA_REAL: Record<string, unknown> = { ...VIA_OK, groupId: 0 };
delete VIA_REAL.zIndex;

/** 这些示例文件的格式行应全部通过校验（33+ 行，覆盖 12 个文档域）。 */
const EXAMPLE_FILES = [
  "PCB/t-pcb-via.md",
  "PCB/t-pcb-line.md",
  "PCB/t-pcb-pad.md",
  "PCB/t-canvas.md",
  "PCB/tm-pcb.md",
  "PCB/t-pcb-poly.md",
  "PCB/t-pcb-string.md",
  "PCB/t-net.md",
  "SCH_PAGE/t-sch-line.md",
  "SCH_PAGE/t-wire.md",
  "SCH_PAGE/t-sch-poly.md",
  "SCH_PAGE/t-sch-pin.md",
  "SCH_PAGE/t-part.md",
  "SCH_PAGE/tm-sheet.md",
  "SYMBOL/t-bus.md",
  "SYMBOL/t-sch-canvas.md",
  "FOOTPRINT/t-pcb-fill.md",
  "FOOTPRINT/tm-footprint.md",
  "FOOTPRINT/tm-pcb-component.md",
  "PANEL/t-panel-poly.md",
  "PANEL_LIB/t-panel-string.md",
  "CONFIG/t-universal.md",
  "BOARD/tm-board.md",
  "DEVICE/tm-device.md",
  "BLOB/tm-blob.md",
  "SCH/t-rule-wire.md",
  "SCH/t-differential-pair.md",
  "SIMULATION/t-sch-line.md",
  "SIMULATION_SCH/t-net-class.md",
];

function exampleText(rel: string): string {
  return readFileSync(path.join(EXAMPLE_ROOT, rel), "utf8");
}

function exampleLines(rel: string): string[] {
  return exampleText(rel)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("||"));
}

function firstExampleLine(rel: string): string {
  const line = exampleLines(rel)[0];
  if (!line) throw new Error(`示例文件没有格式行：${rel}`);
  return line;
}

function fieldNames(issues: readonly ValidationIssue[]): string[] {
  return issues.map((item) => item.field);
}

test("registry 来自 validate.js：198 个 schema、15 个文档类型、658 条类型映射", () => {
  const registry = loadRegistry(ENV);
  expect(registry.version).toBe(1);
  expect(registry.counts.schemas).toBe(198);
  expect(registry.counts.docTypes).toBe(15);
  expect(registry.counts.typeMap).toBe(658);
  expect(registry.counts.docTypeMap).toBeGreaterThan(250);
  expect(registry.source.repo).toContain("easyeda");
  expect(registry.source.sha).toBe("4fcab1747d47b2ae01d7f93a485859970c5cf933");

  expect(knownDocTypes(ENV)).toHaveLength(15);
  expect(isKnownDocType("PCB", ENV)).toBe(true);
  expect(isKnownDocType("pcb", ENV)).toBe(true);
  expect(isKnownDocType("NOPE", ENV)).toBe(false);

  expect(registry.typeToSchema["t-pcb-via"]).toBe("t-pcb-via.json");
  expect(registry.docTypeMap["pcb_line"]).toBe("t-pcb-line");
  expect(registry.typeMap["pcb_line"]).toBe("t-pcb-line");
  expect(loadSchema("t-pcb-via", ENV)?.required).toContain("viaDiameter");
  expect(loadSchema("没有这个 schema", ENV)).toBeNull();
  expect(isRegisteredPair("LINE", "PCB", ENV)).toBe(true);
  expect(isRegisteredPair("LINE", "BLOB", ENV)).toBe(false);
});

test("resolveSchemaKey 的 docType 前缀、裸名优先级与 schema key 直写", () => {
  expect(resolveSchemaKey("LINE", "PCB", ENV)).toBe("t-pcb-line");
  expect(resolveSchemaKey("line", "PCB", ENV)).toBe("t-pcb-line");
  expect(resolveSchemaKey("PCB_LINE", undefined, ENV)).toBe("t-pcb-line");
  expect(resolveSchemaKey("pcb_line", undefined, ENV)).toBe("t-pcb-line");
  expect(resolveSchemaKey("LINE", undefined, ENV)).toBe("t-sch-line");
  expect(resolveSchemaKey("LINE", "SYMBOL", ENV)).toBe("t-sch-line");
  expect(resolveSchemaKey("META", "PCB", ENV)).toBe("tm-pcb");
  expect(resolveSchemaKey("META", "FOOTPRINT", ENV)).toBe("tm-footprint");
  expect(resolveSchemaKey("META", undefined, ENV)).toBe("tm-sheet");
  expect(resolveSchemaKey("CANVAS", "PCB", ENV)).toBe("t-canvas");
  expect(resolveSchemaKey("CANVAS", "SCH_PAGE", ENV)).toBe("t-sch-canvas");
  expect(resolveSchemaKey("DOCHEAD", undefined, ENV)).toBe("t-doc-head");
  expect(resolveSchemaKey("VIA", undefined, ENV)).toBe("t-pcb-via");
  expect(resolveSchemaKey("t-pcb-via", undefined, ENV)).toBe("t-pcb-via");
  expect(resolveSchemaKey("t-pcb-via", "SCH_PAGE", ENV)).toBe("t-pcb-via");
});

test("校验器：type / required / enum / minimum / maximum", () => {
  const typeIssues = validateSchema({ type: "string" }, 3);
  expect(typeIssues).toHaveLength(1);
  expect(typeIssues[0]?.field).toBe("root");
  expect(typeIssues[0]?.keyword).toBe("type");

  const requiredIssues = validateSchema(
    { type: "object", required: ["name", "width"] },
    { width: 1 },
  );
  expect(fieldNames(requiredIssues)).toEqual(["name"]);

  const enumIssues = validateSchema(
    { type: "object", properties: { viaType: { type: "string", enum: ["NORMAL", "BLIND"] } } },
    { viaType: "SUTURE" },
  );
  expect(enumIssues[0]?.field).toBe("viaType");
  expect(enumIssues[0]?.keyword).toBe("enum");
  expect(enumIssues[0]?.message).toContain("SUTURE");

  const numberIssues = validateSchema({ type: "number", minimum: 0, maximum: 10 }, 12);
  expect(numberIssues[0]?.keyword).toBe("maximum");
  const belowIssues = validateSchema({ type: "number", minimum: 0, maximum: 10 }, -1);
  expect(belowIssues[0]?.keyword).toBe("minimum");

  // default 是标注，不参与校验
  expect(
    validateSchema({ type: "object", properties: { x: { type: "string", default: "d" } } }, {}),
  ).toEqual([]);
});

test("校验器：items / pattern / anyOf / 多类型与嵌套路径", () => {
  const itemIssues = validateSchema({ type: "array", items: { type: "number" } }, [1, "x"]);
  expect(itemIssues).toHaveLength(1);
  expect(itemIssues[0]?.field).toBe("root[1]");

  const patternIssues = validateSchema({ type: "string", pattern: "^[0-9a-f]{16}$" }, "XYZ");
  expect(patternIssues[0]?.keyword).toBe("pattern");

  const nullable = validateSchema({ type: ["number", "null"] }, null);
  expect(nullable).toEqual([]);
  const wrongNullable = validateSchema({ type: ["number", "null"] }, "x");
  expect(wrongNullable).toHaveLength(1);

  const nested = validateSchema(
    {
      type: "object",
      properties: {
        pad: {
          type: "object",
          required: ["padType"],
          properties: { padType: { type: "string" } },
        },
      },
    },
    { pad: {} },
  );
  expect(nested[0]?.field).toBe("pad.padType");

  const anyOfSchema = {
    type: "object",
    anyOf: [
      { type: "object", properties: { padType: { enum: ["ELLIPSE"] } }, required: ["width"] },
      { type: "object", properties: { padType: { enum: ["RECT"] } }, required: ["radius"] },
    ],
  };
  expect(validateSchema(anyOfSchema, { padType: "RECT", radius: 0 })).toEqual([]);
  const anyOfIssues = validateSchema(anyOfSchema, { padType: "RECT" });
  expect(anyOfIssues).toHaveLength(1);
  expect(anyOfIssues[0]?.keyword).toBe("anyOf");

  // 真实 schema：焊盘定义是 anyOf 四选一；RECT 必须带 radius
  const padSchema = loadSchema("t-pad-def", ENV);
  expect(padSchema).not.toBeNull();
  expect(
    validateSchema(padSchema, { padType: "RECT", width: 10, height: 10, radius: 0 }),
  ).toHaveLength(0);
  expect(validateSchema(padSchema, { padType: "RECT", width: 10, height: 10 })[0]?.keyword).toBe(
    "anyOf",
  );
  expect(validateSchema(padSchema, { padType: "RECT" }).length).toBeGreaterThan(0);
});

test("examples/ 的真实示例行 ≥20 条全部通过校验", () => {
  const checked: { file: string; type: string }[] = [];
  for (const rel of EXAMPLE_FILES) {
    const domain = rel.split("/")[0] ?? "";
    const lines = exampleLines(rel);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const result = validateLine(line, domain);
      expect(result.errors, `${rel} 的示例行不合法：${JSON.stringify(result.errors)}`).toEqual([]);
      expect(result.valid).toBe(true);
      checked.push({ file: rel, type: result.type });
    }
  }
  expect(checked.length).toBeGreaterThanOrEqual(20);
  expect(new Set(checked.map((item) => item.file)).size).toBeGreaterThanOrEqual(20);
});

test("构造错误数据能报出对应字段", () => {
  const badVia = validateFormat(
    "VIA",
    {
      ...VIA_OK,
      centerX: "abc",
      viaType: "SUTURE2",
      unusedInnerLayers: [1, "x"],
    },
    "PCB",
  );
  expect(badVia.valid).toBe(false);
  expect(fieldNames(badVia.errors)).toEqual(
    expect.arrayContaining(["centerX", "viaType", "unusedInnerLayers[1]"]),
  );

  const line = firstExampleLine("PCB/t-pcb-pad.md");
  const withoutTicket = line.replace(/,"ticket":\d+/, "");
  const missingTicket = validateLine(withoutTicket, "PCB");
  expect(missingTicket.valid).toBe(false);
  expect(fieldNames(missingTicket.errors)).toContain("ticket");

  const wrongOuter = line.replace(/"type":"[^"]+"/, '"type":123');
  const badType = validateLine(wrongOuter, "PCB");
  expect(badType.valid).toBe(false);
  expect(fieldNames(badType.errors)).toContain("type");

  const badPayload = line.replace(/\|\|\{.*/, "||{oops");
  const badJson = validateLine(badPayload, "PCB");
  expect(badJson.valid).toBe(false);
  expect(fieldNames(badJson.errors)).toContain("line");
});

test("relaxations：VIA 缺 zIndex、groupId 写数字 0 降级为 warning", () => {
  const relaxed = validateFormat("VIA", VIA_REAL, "PCB");
  expect(relaxed.valid).toBe(true);
  expect(relaxed.errors).toEqual([]);
  expect(fieldNames(relaxed.warnings)).toEqual(["zIndex", "groupId"]);
  expect(relaxed.warnings[0]?.severity).toBe("WARNING");
  expect(relaxed.warnings[0]?.message).toContain("已放宽");
  expect(relaxed.warnings[1]?.message).toContain("groupId");

  // 成组时 groupId 是字符串，正常通过且没有 warning
  const grouped = validateFormat("VIA", VIA_OK, "PCB");
  expect(grouped.valid).toBe(true);
  expect(grouped.warnings).toEqual([]);

  // 数字 7 不是「未分组」的 0，仍然报错
  const wrong = validateFormat("VIA", { ...VIA_REAL, groupId: 7 }, "PCB");
  expect(wrong.valid).toBe(false);
  expect(fieldNames(wrong.errors)).toContain("groupId");
});

test("记录层：parse / 空体 / META 空串 / DELETE_DOC / 外层规则", () => {
  const line = firstExampleLine("PCB/t-pcb-via.md");
  const parsed = parseRecordLine(`${line}|`);
  expect(parsed.outer.type).toBe("VIA");
  expect(parsed.emptyPayload).toBe(false);
  const noTerminator = parseRecordLine(line);
  expect(noTerminator.payload).toEqual(parsed.payload);

  const instanceAttr = validateLine('{"type":"INSTANCE_ATTR","id":"abc","ticket":1}|||', undefined);
  expect(instanceAttr.valid).toBe(true);
  expect(instanceAttr.warnings[0]?.keyword).toBe("empty-payload");

  const metaEmpty = validateLine('{"type":"META","id":"META","ticket":1}|||', "PCB");
  expect(metaEmpty.valid).toBe(false);
  expect(metaEmpty.errors[0]?.keyword).toBe("delete-meta");

  const deleteDoc = validateLine('{"type":"DELETE_DOC","ticket":2}||{"isDelete":true}|', undefined);
  expect(deleteDoc.valid).toBe(true);
  expect(deleteDoc.schema).toBe("delete_doc");

  const deleteDocEmpty = validateLine('{"type":"DELETE_DOC","ticket":2}|||', undefined);
  expect(deleteDocEmpty.valid).toBe(false);
  expect(deleteDocEmpty.errors[0]?.keyword).toBe("delete-doc-payload");

  expect(validateOuter({ type: "DOCHEAD", ticket: 1 })).toEqual([]);
  expect(validateOuter({ type: "VIA" }).map((item) => item.field)).toEqual(["id", "ticket"]);
  expect(validateOuter({ type: "VIA", id: "a", ticket: -1 }).map((item) => item.field)).toEqual([
    "ticket",
  ]);
  expect(validateOuter({ type: 3, id: "a", ticket: 1 })[0]?.field).toBe("type");

  expect(validateLine("没有分隔符").errors[0]?.keyword).toBe("LINE_FORMAT");
  expect(validateLine('{"type":"VIA","id":"a","ticket":1}||{oops').errors[0]?.keyword).toBe(
    "PAYLOAD_JSON",
  );
});

test("docType 决定同名图元的 schema：LINE 在 PCB 是走线、在 SCH_PAGE 是导线", () => {
  const line = firstExampleLine("PCB/t-pcb-line.md");
  const asPcb = validateLine(line, "PCB");
  expect(asPcb.valid).toBe(true);
  expect(asPcb.schema).toBe("t-pcb-line");

  const asSch = validateLine(line, undefined);
  expect(asSch.schema).toBe("t-sch-line");
  expect(asSch.valid).toBe(false);

  const unknownDoc = validateLine(line, "NOPE");
  expect(unknownDoc.valid).toBe(false);
  expect(fieldNames(unknownDoc.errors)).toContain("docType");
});

test("知识检索：中文名、类型名、schema key 与文档域过滤", () => {
  const via = listTypes({ query: "过孔" }, ENV);
  expect(via.some((item) => item.className === "TPcbVia")).toBe(true);
  expect(via.some((item) => item.className === "EViaType")).toBe(true);

  const pcbOnly = listTypes({ query: "过孔", docType: "PCB" }, ENV);
  expect(pcbOnly.some((item) => item.className === "TPcbVia")).toBe(true);
  expect(pcbOnly.some((item) => item.className === "EViaType")).toBe(false);
  expect(pcbOnly.every((item) => item.docTypes.includes("PCB"))).toBe(true);

  const pad = listTypes({ query: "焊盘" }, ENV);
  expect(pad.some((item) => item.className === "TPcbPad")).toBe(true);

  const byClass = listTypes({ query: "TPcbVia" }, ENV);
  expect(byClass[0]?.className).toBe("TPcbVia");
  expect(byClass[0]?.schema).toBe("t-pcb-via");

  expect(listTypes({ query: "绝对不存在的类型" }, ENV)).toEqual([]);
  expect(listTypes({ limit: 3 }, ENV)).toHaveLength(3);
});

test("getPrimitive / getExample / getFormatLog / getDocument", () => {
  const via = getPrimitive("VIA", undefined, ENV);
  expect(via?.className).toBe("TPcbVia");
  expect(via?.chinese).toBe("过孔");
  expect(via?.docTypes).toEqual(expect.arrayContaining(["FOOTPRINT", "PCB"]));
  expect(via?.schemaFile?.key).toBe("t-pcb-via");
  expect(via?.schemaFile?.file).toBe("schemas/t-pcb-via.json");
  expect(via?.text).toContain("# TPcbVia");
  expect(via?.text).toContain("zIndex");
  expect(via?.exampleFile?.lines.length).toBeGreaterThan(0);
  expect(via?.exampleFile?.lines[0]).toContain('"type":"VIA"');

  // 跨文档类型：LINE 在 PCB 下取走线，在默认解析下取导线
  const pcbLine = getPrimitive("LINE", "PCB", ENV);
  expect(pcbLine?.className).toBe("TPcbLine");
  expect(pcbLine?.text).toContain("netName");
  expect(getPrimitive("LINE", undefined, ENV)?.className).toBe("TSchLine");
  expect(getPrimitive("PCB_VIA", undefined, ENV)?.className).toBe("TPcbVia");
  expect(getPrimitive("t-pcb-via", undefined, ENV)?.className).toBe("TPcbVia");
  expect(getPrimitive("不存在的类型", undefined, ENV)).toBeNull();

  const example = getExample("TPcbVia", "PCB", ENV);
  expect(example?.file).toContain("examples/");
  expect(example?.lines.length).toBeGreaterThan(0);
  expect(example?.text).toContain("示例 1");
  expect(getExample("EAlign", undefined, ENV)?.lines).toEqual([]);

  const log = getFormatLog(ENV);
  expect(log?.file).toBe("FORMATLOG.md");
  expect(log?.text).toContain("V3 → V4");
  expect(log?.text).toContain("字典序大者胜");

  expect(getDocument("PCB", ENV)?.text).toContain("图元索引");
  expect(getDocument("NOPE", ENV)).toBeNull();
});

test("MCP 工具：名称、硬规则与 handler", async () => {
  expect(formatTools.map((tool) => tool.name)).toEqual([
    "format_list_types",
    "format_get_primitive",
    "format_validate_record",
    "format_example",
    "format_changelog",
  ]);
  for (const tool of formatTools) {
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.description).toContain("docType");
  }
  const validateTool = formatTools[2]!;
  expect(validateTool.description).toContain("ticket");
  expect(validateTool.description).toContain("client");
  expect(validateTool.description).toContain("META");
  expect(validateTool.description).toContain("空串");
  expect(validateTool.description).toContain("DOCHEAD");

  const line = firstExampleLine("PCB/t-pcb-via.md");
  const byLine = (await validateTool.run({ line }, CTX)) as RecordValidation;
  expect(byLine.valid).toBe(true);
  expect(byLine.schema).toBe("t-pcb-via");

  const byData = (await validateTool.run(
    { type: "VIA", data: JSON.stringify(VIA_REAL), docType: "PCB" },
    CTX,
  )) as RecordValidation;
  expect(byData.valid).toBe(true);
  expect(byData.warnings).toHaveLength(2);

  await expect(
    validateTool.run({ type: "VIA", data: "{不是 JSON", docType: "PCB" }, CTX),
  ).rejects.toBeInstanceOf(ToolError);

  const primitiveTool = formatTools[1]!;
  const primitive = (await primitiveTool.run({ type: "PCB_LINE" }, CTX)) as {
    className: string;
    schemaFile: { key: string } | null;
  };
  expect(primitive.className).toBe("TPcbLine");
  expect(primitive.schemaFile?.key).toBe("t-pcb-line");
  await expect(primitiveTool.run({ type: "没有这个类型" }, CTX)).rejects.toBeInstanceOf(ToolError);

  const listTool = formatTools[0]!;
  const listed = (await listTool.run({ query: "过孔" }, CTX)) as {
    results: { className: string }[];
  };
  expect(listed.results.some((item) => item.className === "TPcbVia")).toBe(true);

  const exampleTool = formatTools[3]!;
  const example = (await exampleTool.run({ type: "TPcbVia" }, CTX)) as { lines: string[] };
  expect(example.lines.length).toBeGreaterThan(0);

  const changelogTool = formatTools[4]!;
  const changelog = (await changelogTool.run({}, CTX)) as { text: string };
  expect(changelog.text).toContain("V3 → V4");
});

test("CLI：types / show / validate / example 与 validate.js 的调用方式", async () => {
  clearFormatCaches();

  const typesIo = createMemoryIo();
  expect(await runFormatCommand(["types", "过孔", "--json"], typesIo, ENV)).toBe(0);
  const listed = JSON.parse(typesIo.lines.join("\n")) as {
    count: number;
    results: { className: string }[];
  };
  expect(listed.count).toBeGreaterThan(0);
  expect(listed.results.some((item) => item.className === "TPcbVia")).toBe(true);

  const showIo = createMemoryIo();
  expect(await runFormatCommand(["show", "PCB_LINE", "--json"], showIo, ENV)).toBe(0);
  const shown = JSON.parse(showIo.lines.join("\n")) as { className: string; text: string };
  expect(shown.className).toBe("TPcbLine");
  expect(shown.text).toContain("netName");

  // 整行写法（可带行尾 |）；裸类型名 LINE 要配 --doc 才是 PCB 走线
  const line = firstExampleLine("PCB/t-pcb-line.md");
  const lineIo = createMemoryIo();
  expect(await runFormatCommand(["validate", `${line}|`, "--doc", "PCB"], lineIo, ENV)).toBe(0);
  expect(lineIo.lines.join("\n")).toContain("✓ 合法");

  // <type> <内层 JSON> 写法，兼容 validate.js；--doc 与前缀名等价
  const payload = line.slice(line.indexOf("||") + 2);
  const payloadIo = createMemoryIo();
  expect(await runFormatCommand(["validate", "PCB_LINE", payload, "--json"], payloadIo, ENV)).toBe(
    0,
  );
  const payloadResult = JSON.parse(payloadIo.lines.join("\n")) as RecordValidation;
  expect(payloadResult.valid).toBe(true);
  expect(payloadResult.schema).toBe("t-pcb-line");

  const docIo = createMemoryIo();
  expect(await runFormatCommand(["validate", "--doc", "PCB", "LINE", payload], docIo, ENV)).toBe(0);
  expect(docIo.lines.join("\n")).toContain("schema=t-pcb-line");

  const badIo = createMemoryIo();
  expect(await runFormatCommand(["validate", "VIA", "{}"], badIo, ENV)).toBe(1);
  expect(badIo.lines.join("\n")).toContain("缺少必需字段");

  const badJsonIo = createMemoryIo();
  expect(await runFormatCommand(["validate", "VIA", "{oops"], badJsonIo, ENV)).toBe(1);
  expect(badJsonIo.errors.join("\n")).toContain("不是合法 JSON");

  const unknownDocIo = createMemoryIo();
  expect(await runFormatCommand(["types", "--doc", "NOPE"], unknownDocIo, ENV)).toBe(1);
  expect(unknownDocIo.errors.join("\n")).toContain("未知的文档类型");

  const exampleIo = createMemoryIo();
  expect(await runFormatCommand(["example", "TPcbVia", "--json"], exampleIo, ENV)).toBe(0);
  const example = JSON.parse(exampleIo.lines.join("\n")) as { lines: string[] };
  expect(example.lines.length).toBeGreaterThan(0);

  const helpIo = createMemoryIo();
  expect(await runFormatCommand(["help"], helpIo, ENV)).toBe(0);
  expect(helpIo.lines.join("\n")).toContain("lceda-connect format");

  const unknownIo = createMemoryIo();
  expect(await runFormatCommand(["nope"], unknownIo, ENV)).toBe(1);
  expect(unknownIo.errors.join("\n")).toContain("不认识的命令");
});
