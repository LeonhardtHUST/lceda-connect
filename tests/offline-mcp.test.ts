import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { eprj3GatesTool } from "../src/eprj3/mcpTools.ts";
import { reportTool } from "../src/epro2/mcpTools.ts";
import { formatTools } from "../src/format/mcpTools.ts";
import { metricsTool } from "../src/sim/mcpTools.ts";
import { errorResult } from "../src/mcp/result.ts";
import { ToolError } from "../src/mcp/types.ts";

const BLINK = path.join(import.meta.dirname, "fixtures", "eprj3", "blink");

const cfg = {} as never;
const env = {};
const denied = async (): Promise<string> => {
  throw new ToolError("PATH_NOT_ALLOWED", "写路径越界");
};

test("offline MCP write paths reject traversal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-mcp-"));
  const raw = path.join(dir, "x.raw");
  fs.writeFileSync(
    raw,
    "Title: t\nPlotname: Transient Analysis\nFlags: real\nNo. Variables: 2\nNo. Points: 1\nVariables:\n\t0\ttime\n\t1\tv(out)\nValues:\n0\t0\n\t1\n",
    "utf8",
  );
  await expect(
    metricsTool.run(
      { raw, metrics: [{ metric: "tran_stats", node: "v(out)" }], csv: "../escape.csv" },
      { cfg, env, resolveWritePath: denied },
    ),
  ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  await expect(
    reportTool.run(
      { file: "missing.epro2", outDir: "../escape" },
      { cfg, env, resolveWritePath: denied },
    ),
  ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("offline MCP annotations and format descriptions", () => {
  expect(metricsTool.annotations).toMatchObject({ readOnlyHint: false });
  expect(reportTool.annotations).toMatchObject({ destructiveHint: true });
  for (const tool of formatTools) expect(tool.description.length).toBeLessThanOrEqual(300);
});

test("eprj3_gates 每跑完一个门报告一次进度", async () => {
  const calls: [number, number | undefined, string | undefined][] = [];
  const result = (await eprj3GatesTool.run(
    { dir: BLINK, gates: ["lint", "drc"] },
    {
      cfg,
      env,
      progress: async (done, total, message) => {
        calls.push([done, total, message]);
      },
    },
  )) as { results: unknown[] };
  expect(result.results).toHaveLength(2);
  expect(calls).toEqual([
    [1, 2, "lint"],
    [2, 2, "drc"],
  ]);
}, 60_000);

test("请求已取消时 eprj3_gates 返回 CANCELLED 而不是 INTERNAL", async () => {
  const controller = new AbortController();
  controller.abort();
  const error = await eprj3GatesTool
    .run({ dir: BLINK, gates: ["lint"] }, { cfg, env, signal: controller.signal })
    .then(
      () => undefined,
      (reason: unknown) => reason,
    );
  expect(error).toBeDefined();
  const result = errorResult(error);
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({ error: "CANCELLED" });
});

test("offline MCP error codes are namespaced", () => {
  expect(new ToolError("SIM_RAW_PARSE_BAD_HEADER", "bad").code).toBe("SIM_RAW_PARSE_BAD_HEADER");
});
