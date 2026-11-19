import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { expect, test } from "vite-plus/test";

import { runApiCommand } from "../src/apidocs/cli.ts";
import {
  getEntry,
  getFormatDoc,
  loadApiIndex,
  search,
  type ApiEntryDetail,
  type ApiMemberText,
} from "../src/apidocs/index.ts";
import { apiDocsTools, apiIndexSummary } from "../src/apidocs/mcpTools.ts";
import { bridgeTools } from "../src/bridge/mcpTools.ts";
import { assetPath } from "../src/core/assets.ts";
import { loadConfig } from "../src/core/config.ts";
import { createMemoryIo } from "../src/core/io.ts";
import { ToolError } from "../src/mcp/types.ts";
import { allTools, toolsForEnv } from "../src/mcp/registry.ts";
import { createServer } from "../src/mcp/server.ts";
import { main } from "../src/main.ts";

test("可选文档缺失与自备资料：CLI、MCP 清单及 lceda_info 使用同一环境", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lceda-api-"));
  const env = { ...process.env, LCEDA_CONNECT_ASSETS: root };
  try {
    expect(allTools("api").some((tool) => tool.name === "api_search")).toBe(true);
    for (const present of [false, true]) {
      if (present) {
        mkdirSync(path.join(root, "api-docs", "references"), { recursive: true });
        writeFileSync(
          path.join(root, "api-docs", "index.json"),
          JSON.stringify({
            version: 1,
            source: { repo: "user-provided", sha: "local", generatedAt: "" },
            counts: { class: 1, interface: 0, enum: 0, type: 0 },
            entries: [
              {
                name: "Custom",
                kind: "class",
                file: "references/Custom.md",
                summary: "Custom",
                members: [{ name: "create", kind: "method", signature: "create()" }],
              },
            ],
          }),
        );
        writeFileSync(
          path.join(root, "api-docs", "references", "Custom.md"),
          "### create\nUser-provided original documentation",
        );
      }
      const io = createMemoryIo();
      expect(await runApiCommand(["search", "Custom", "--json"], io, env)).toBe(present ? 0 : 1);
      if (present) {
        expect(io.lines.join("\n")).toContain("Custom");
        expect((getEntry("Custom", "create", env) as ApiMemberText).text).toContain(
          "User-provided",
        );
      } else {
        expect(io.errors.join("\n")).toContain("可选资料");
        expect(io.errors.join("\n")).toContain("https://prodocs.lceda.cn/cn/api/");
      }
      for (const selection of [undefined, "api", "offline"]) {
        const expected = toolsForEnv(env, selection).map((tool) => tool.name);
        expect(expected.includes("api_search")).toBe(present);
        const cliIo = createMemoryIo();
        const argv = ["mcp", "tools", ...(selection ? ["--toolsets", selection] : [])];
        expect(await main({ argv, io: cliIo, env })).toBe(0);
        expect(cliIo.lines.join("\n").includes("api_search")).toBe(present);
        const server = createServer({ env, toolsets: selection });
        const client = new Client({ name: "optional-docs-test", version: "0" });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await server.connect(st);
        await client.connect(ct);
        try {
          const names = (await client.listTools()).tools.map((tool) => tool.name);
          expect(names).toEqual(expected);
          const info = (await client.callTool({ name: "lceda_info", arguments: {} }))
            .structuredContent as { tools: string[]; toolsets: Record<string, string[]> };
          expect(info?.tools).toEqual(expected);
          expect(Object.hasOwn(info?.toolsets ?? {}, "api")).toBe(present);
        } finally {
          await client.close();
          await server.close();
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 测试用已生成的 assets/api-docs/index.json 与原文，不依赖网络。

const ENV = process.env;
const CTX = { cfg: loadConfig({ ...process.env, USERPROFILE: "C:\\Users\\tester" }, {}), env: ENV };

test("索引可加载，条目数量与来源 sha 正确，体积在预算内", () => {
  const index = loadApiIndex(ENV);
  expect(index.version).toBe(1);
  expect(index.counts).toEqual({ class: 131, interface: 176, enum: 78, type: 35 });
  expect(index.entries).toHaveLength(420);
  expect(index.source.sha).toBe("002a39d6dc55ad138e784c788b5c220b5c191c70");
  expect(index.source.repo).toContain("easyeda");

  const size = statSync(assetPath("api-docs", "index.json")).size;
  expect(size).toBeLessThan(1.5 * 1024 * 1024);

  const summary = apiIndexSummary(ENV);
  expect(summary.counts.class).toBe(131);
});

test("索引条目保留了类访问路径、成员签名与枚举值", () => {
  const index = loadApiIndex(ENV);
  const via = index.entries.find((entry) => entry.name === "PCB_PrimitiveVia");
  expect(via?.kind).toBe("class");
  expect(via?.callPath).toBe("eda.pcb_PrimitiveVia");
  expect(via?.summary).toContain("via primitive");
  const create = via?.members.find((member) => member.name === "create");
  expect(create?.kind).toBe("method");
  expect(create?.signature).toContain("function create(");
  expect(create?.signature).toContain("Promise<IPCB_PrimitiveVia | undefined>");
  expect(create?.summary).toBe("Create Via");

  const layer = index.entries.find((entry) => entry.name === "EPCB_LayerId");
  expect(layer?.kind).toBe("enum");
  const top = layer?.members.find((member) => member.name === "TOP");
  expect(top?.value).toBe("1");
  expect(top?.summary).toContain("顶层");

  const align = index.entries.find((entry) => entry.name === "Align");
  expect(align?.kind).toBe("type");
  expect(align?.members).toEqual([]);

  // 转义的 `\_` 必须还原成下划线，否则按名字查不到
  expect(index.entries.some((entry) => entry.name.includes("\\"))).toBe(false);
});

test("search 打分排序：名称精确 > 前缀 > 包含 > 摘要", () => {
  const hits = search("PCB_Primitive", {}, ENV);
  expect(hits[0]?.name).toBe("PCB_Primitive");
  expect(hits[0]?.score).toBe(1000);
  expect(hits[1]?.name).toBe("PCB_PrimitiveArc");
  expect(hits[1]?.score).toBe(700);
  // 前缀匹配段全部排在「仅包含」之前
  const prefixCount = hits.filter((hit) => hit.name.startsWith("PCB_Primitive")).length;
  expect(prefixCount).toBeGreaterThan(10);
  expect(hits[prefixCount]?.name.startsWith("PCB_Primitive")).toBe(false);
  // 前缀段之后只可能是成员名命中（如 EDA.pcb_Primitive）或包含命中
  expect(hits.slice(prefixCount).every((hit) => hit.score <= 500)).toBe(true);
  expect(
    hits
      .slice(prefixCount)
      .some((hit) => hit.score === 400 && hit.name.toLowerCase().includes("pcb_primitive")),
  ).toBe(true);

  // 摘要命中排在最后，且分数更低
  const via = search("via primitive class", {}, ENV);
  expect(via.length).toBeGreaterThan(0);
  expect(via[0]?.summary.toLowerCase()).toContain("via primitive");
});

test("search 支持点号写法、eda. 前缀、kind 过滤、limit 与中文", () => {
  const dotted = search("pcb_PrimitiveVia.create", {}, ENV);
  expect(dotted[0]?.name).toBe("PCB_PrimitiveVia");
  expect(dotted[0]?.member?.name).toBe("create");
  expect(dotted[0]?.member?.signature).toContain("function create(");

  const prefixed = search("eda.pcb_PrimitiveVia.create", {}, ENV);
  expect(prefixed[0]?.name).toBe("PCB_PrimitiveVia");

  const enumsOnly = search("PCB_Primitive", { kind: "enum" }, ENV);
  expect(enumsOnly.length).toBeGreaterThan(0);
  expect(enumsOnly.every((hit) => hit.kind === "enum")).toBe(true);

  expect(search("primitive", { limit: 5 }, ENV)).toHaveLength(5);
  expect(search("", {}, ENV)).toEqual([]);

  const chinese = search("焊盘", {}, ENV);
  expect(chinese.length).toBeGreaterThan(0);
  expect(chinese.some((hit) => (hit.member?.summary ?? hit.summary).includes("焊盘"))).toBe(true);
});

test("getEntry 返回成员表、callPath 与成员签名原文", () => {
  const entry = getEntry("PCB_PrimitiveVia", undefined, ENV);
  expect(entry).not.toBeNull();
  const detail = entry as ApiEntryDetail;
  expect(detail.callPath).toBe("eda.pcb_PrimitiveVia");
  expect(detail.file).toBe("references/classes/PCB_PrimitiveVia.md");
  expect(detail.members.map((member) => member.name)).toContain("getAll");

  // 支持 eda. 前缀与大小写不敏感
  expect((getEntry("eda.pcb_PrimitiveVia", undefined, ENV) as ApiEntryDetail).name).toBe(
    "PCB_PrimitiveVia",
  );
  expect((getEntry("pcb_primitivevia", undefined, ENV) as ApiEntryDetail).name).toBe(
    "PCB_PrimitiveVia",
  );

  const member = getEntry("PCB_PrimitiveVia", "create", ENV) as ApiMemberText;
  expect(member.className).toBe("PCB_PrimitiveVia");
  expect(member.member).toBe("create");
  expect(member.kind).toBe("method");
  expect(member.text).toContain("Create Via");
  expect(member.text).toContain("function create(");

  const enumMember = getEntry("EPCB_LayerId", "BOARD_OUTLINE", ENV) as ApiMemberText;
  expect(enumMember.text).toBe("BOARD_OUTLINE = 11 — 板框层");

  expect(getEntry("PCB_PrimitiveVia", "不存在的成员", ENV)).toBeNull();
  expect(getEntry("根本没有这个类", undefined, ENV)).toBeNull();
});

test("getFormatDoc 读取 format 文档并拒绝越界路径", () => {
  const doc = getFormatDoc("pcb", "primitive", ENV);
  expect(doc?.file).toBe("format/pcb/primitive.md");
  expect(doc?.text).toContain("Basic Primitive Format");
  expect(doc?.text).toContain("NET");

  const indexDoc = getFormatDoc("schematic", undefined, ENV);
  expect(indexDoc?.text).toContain("Schematic");

  expect(getFormatDoc("pcb", "no-such-doc", ENV)).toBeNull();
  expect(getFormatDoc("..", undefined, ENV)).toBeNull();
  expect(getFormatDoc("pcb", "../index", ENV)).toBeNull();
});

test("MCP 工具名与关键规则写进描述", () => {
  expect(bridgeTools.map((tool) => tool.name)).toEqual([
    "bridge_status",
    "bridge_windows",
    "bridge_select_window",
    "bridge_execute",
  ]);
  expect(apiDocsTools.map((tool) => tool.name)).toEqual([
    "api_search",
    "api_get",
    "api_format_doc",
  ]);

  const executeTool = bridgeTools.find((tool) => tool.name === "bridge_execute");
  expect(executeTool?.description).toContain("async function(eda)");
  expect(executeTool?.description).toContain("mil");
  expect(executeTool?.description).toContain("await");
  expect(executeTool?.description).toContain("枚举");
  expect(executeTool?.annotations?.destructiveHint).toBe(true);
  // 执行任意代码必须显式 confirm
  const input = executeTool?.input as Record<string, unknown>;
  expect(Object.keys(input)).toContain("confirm");

  const searchTool = apiDocsTools.find((tool) => tool.name === "api_search");
  expect(searchTool?.description).toContain("mil");
  expect(searchTool?.description).toContain("await");
});

test("api_search / api_get 的 handler 可跑通，缺条目报 NOT_FOUND", async () => {
  const searchTool = apiDocsTools.find((tool) => tool.name === "api_search");
  const getTool = apiDocsTools.find((tool) => tool.name === "api_get");
  expect(searchTool).toBeDefined();
  expect(getTool).toBeDefined();

  const found = (await searchTool!.run({ query: "过孔" }, CTX)) as {
    count: number;
    results: { name: string }[];
  };
  expect(found.count).toBeGreaterThan(0);
  expect(found.results.length).toBeGreaterThan(0);

  const entry = await getTool!.run({ className: "PCB_PrimitiveVia", member: "create" }, CTX);
  expect((entry as ApiMemberText).text).toContain("function create(");

  await expect(getTool!.run({ className: "没有这个类" }, CTX)).rejects.toBeInstanceOf(ToolError);
});

test("runApiCommand 的 search / get / 未知动作", async () => {
  const searchIo = createMemoryIo();
  expect(await runApiCommand(["search", "焊盘", "--limit", "3", "--json"], searchIo, ENV)).toBe(0);
  const parsed = JSON.parse(searchIo.lines.join("\n")) as { query: string; count: number };
  expect(parsed.query).toBe("焊盘");
  expect(parsed.count).toBeGreaterThan(0);
  expect(parsed.count).toBeLessThanOrEqual(3);

  const getIo = createMemoryIo();
  expect(await runApiCommand(["get", "PCB_PrimitiveVia", "create"], getIo, ENV)).toBe(0);
  expect(getIo.lines.join("\n")).toContain("function create(");

  const missingIo = createMemoryIo();
  expect(await runApiCommand(["get", "没有这个类"], missingIo, ENV)).toBe(1);
  expect(missingIo.errors.join("\n")).toContain("没有找到");

  const helpIo = createMemoryIo();
  expect(await runApiCommand(["help"], helpIo, ENV)).toBe(0);
  expect(helpIo.lines.join("\n")).toContain("api search");

  const badIo = createMemoryIo();
  expect(await runApiCommand(["nope"], badIo, ENV)).toBe(1);
  expect(badIo.errors.join("\n")).toContain("不认识的命令");
});
