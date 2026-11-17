import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { reportTool } from "../src/epro2/mcpTools.ts";
import { formatTools } from "../src/format/mcpTools.ts";
import { metricsTool } from "../src/sim/mcpTools.ts";
import { ToolError } from "../src/mcp/types.ts";

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

test("offline MCP error codes are namespaced", () => {
  expect(new ToolError("SIM_RAW_PARSE_BAD_HEADER", "bad").code).toBe("SIM_RAW_PARSE_BAD_HEADER");
});
