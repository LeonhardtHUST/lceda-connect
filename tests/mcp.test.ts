import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListRootsRequestSchema,
  ProgressNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
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

test("每个领域的工具都已注册", () => {
  const names = new Set(allTools().map((t) => t.name));
  for (const expected of [
    "lceda_info",
    "cdp_eval",
    "bridge_execute",
    "lceda_status",
    "api_search",
    "format_validate_record",
    "epro2_report",
    "eprj3_validate",
    "sim_run",
  ]) {
    expect(names.has(expected), expected).toBe(true);
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

test("结构化输出与超限结果资源", async () => {
  const structured = okResult({ value: 1 });
  expect(structured.structuredContent).toEqual({ value: 1 });
  const array = okResult([1, 2]);
  expect(array.structuredContent).toEqual({ items: [1, 2] });

  const home = mkdtempSync(path.join(os.tmpdir(), "lceda-mcp-result-"));
  const oversized = okResult({ value: "x".repeat(100) }, 10, {
    env: { LCEDA_CONNECT_HOME: home },
  });
  expect(oversized.isError).toBeUndefined();
  const payload = JSON.parse(oversized.content[0]?.text ?? "{}") as {
    resultUri: string;
    path: string;
  };
  expect(payload.resultUri).toMatch(/^lceda:\/\/results\//);
  expect(readFileSync(payload.path, "utf8")).toContain('"value"');

  const outputTooLarge = okResult({ value: "x".repeat(100) }, 10, {
    env: { LCEDA_CONNECT_HOME: home },
    outputSchema: true,
  });
  expect(outputTooLarge.isError).toBe(true);
  expect(JSON.parse(outputTooLarge.content[0]?.text ?? "{}")).toMatchObject({
    error: "RESULT_TOO_LARGE",
  });

  const resultTool = defineTool({
    name: "large_result",
    description: "生成一个超限测试结果",
    input: {},
    handler: () => ({ value: "y".repeat(70 * 1024) }),
  });
  const server = createServer({ env: { LCEDA_CONNECT_HOME: home }, tools: [resultTool] });
  const client = new Client({ name: "resource-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: "large_result", arguments: {} });
  const resultContent = (result as { content: Array<{ text?: string }> }).content;
  const resultPayload = JSON.parse(resultContent[0]?.text ?? "{}") as { resultUri: string };
  const resource = await client.readResource({ uri: resultPayload.resultUri });
  const firstContent = resource.contents[0];
  expect(firstContent && "text" in firstContent ? firstContent.text : "").toContain('"value"');
  await client.close();
});

test("toolsets 过滤始终保留 core", () => {
  expect(allTools("offline").map((tool) => tool.name)).toContain("lceda_info");
  expect(allTools("offline").map((tool) => tool.name)).not.toContain("cdp_eval");
  expect(allTools("eda").map((tool) => tool.name)).toContain("eda_read_board");
});

test("ToolContext progress 转发 progressToken，roots 转换 file URI", async () => {
  const progress: unknown[] = [];
  let rootsSeen: string[] = [];
  const tool = defineTool({
    name: "context_probe",
    description: "测试上下文扩展字段",
    input: {},
    handler: async (_args, ctx) => {
      await ctx.progress(1, 2, "working");
      rootsSeen = await ctx.roots();
      return { ok: true };
    },
  });
  const server = createServer({ tools: [tool] });
  const client = new Client(
    { name: "context-test", version: "0.0.0" },
    {
      capabilities: { roots: { listChanged: true } },
    },
  );
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
    progress.push(notification.params);
  });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(process.cwd()).toString() }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({
    name: "context_probe",
    arguments: {},
    _meta: { progressToken: "progress-1" },
  });
  expect(result.isError).toBeFalsy();
  expect(progress).toContainEqual({
    progressToken: "progress-1",
    progress: 1,
    total: 2,
    message: "working",
  });
  expect(rootsSeen).toEqual([path.resolve(process.cwd())]);
  await client.close();
});

test("客户端取消会传播到 ToolContext.signal", async () => {
  let aborted = false;
  const tool = defineTool({
    name: "cancel_probe",
    description: "测试取消信号传播",
    input: {},
    handler: async (_args, ctx) => {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) return resolve();
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      aborted = ctx.signal.aborted;
      return { aborted };
    },
  });
  const server = createServer({ tools: [tool] });
  const client = new Client({ name: "cancel-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const controller = new AbortController();
  const call = client.callTool({ name: "cancel_probe", arguments: {} }, undefined, {
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await expect(call).rejects.toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(aborted).toBe(true);
  await client.close();
});
test("lceda-connect mcp tools 列出工具", async () => {
  const io = createMemoryIo();
  const code = await main({ argv: ["mcp", "tools"], io });
  expect(code).toBe(0);
  expect(io.lines.join("\n")).toContain("lceda_info");
});
