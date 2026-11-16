import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "vite-plus/test";
import { z } from "zod";

import { main } from "../src/main.ts";
import { createMemoryIo } from "../src/core/io.ts";
import { allTools } from "../src/mcp/registry.ts";
import { okResult, truncateUtf8 } from "../src/mcp/result.ts";
import { createServer } from "../src/mcp/server.ts";
import { ToolError, defineTool } from "../src/mcp/types.ts";

async function connect(tools = allTools()) {
  const server = createServer({ tools });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join("");
}

test("工具名唯一且都有说明", () => {
  const tools = allTools();
  expect(tools.length).toBeGreaterThan(0);
  expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  for (const tool of tools) {
    expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(tool.description.length).toBeGreaterThan(10);
  }
});

test("MCP 握手后能列出并调用 lceda_info", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("lceda_info");
  const result = await client.callTool({ name: "lceda_info", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(JSON.parse(textOf(result))).toMatchObject({ name: "lceda-connect" });
  await client.close();
});

test("ToolError 以 isError 结果返回而不是协议错误", async () => {
  const failing = defineTool({
    name: "always_fail",
    description: "测试用：总是失败的工具",
    input: { x: z.number() },
    handler: () => {
      throw new ToolError("NOPE", "故意失败");
    },
  });
  const client = await connect([failing]);
  const result = await client.callTool({ name: "always_fail", arguments: { x: 1 } });
  expect(result.isError).toBe(true);
  expect(JSON.parse(textOf(result))).toMatchObject({ error: "NOPE", message: "故意失败" });
  await client.close();
});

test("skill_docs 不带参数时返回技能列表", async () => {
  const client = await connect();
  const result = await client.callTool({ name: "skill_docs", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(JSON.parse(textOf(result))).toHaveProperty("skills");
  await client.close();
});

test("结果超过上限时按 UTF-8 字符边界截断", () => {
  const { text, truncated } = truncateUtf8("汉字汉字", 7);
  expect(truncated).toBe(true);
  expect(text).toBe("汉字");
  const big = okResult("x".repeat(100), 10);
  expect(big._meta).toMatchObject({ truncated: true, originalBytes: 100 });
});

test("lceda-connect mcp tools 列出工具", async () => {
  const io = createMemoryIo();
  const code = await main({ argv: ["mcp", "tools"], io });
  expect(code).toBe(0);
  expect(io.lines.join("\n")).toContain("lceda_info");
});
