import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { createMemoryIo } from "../src/core/io.ts";
import { runEpro2Command } from "../src/epro2/cli.ts";
import { epro2Tools } from "../src/epro2/mcpTools.ts";
import { ZipError, readZip } from "../src/epro2/zip.ts";
import { buildStoredZip, writeProject } from "./fixtures/epro2/makeFixture.ts";

function tempProject(options: Parameters<typeof writeProject>[1] = {}): {
  dir: string;
  path: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-epro2-cli-"));
  const projectPath = path.join(dir, "TestProj.epro2");
  writeProject(projectPath, options);
  return {
    dir,
    path: projectPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = epro2Tools.find((item) => item.name === name);
  expect(tool, name).toBeTruthy();
  return await tool!.run(args, { cfg: {} as never, env: {} });
}

test("MCP epro2 工具注册完整，inspect 与 crosscheck 可调用", async () => {
  const project = tempProject();
  try {
    expect(epro2Tools.map((tool) => tool.name).sort()).toEqual([
      "epro2_crosscheck",
      "epro2_diff",
      "epro2_inspect",
      "epro2_pcb_geometry",
      "epro2_pcb_netlist",
      "epro2_report",
      "epro2_schematic_nets",
    ]);
    const inspected = await callTool("epro2_inspect", { file: project.path });
    expect(inspected).toMatchObject({ project: "TestProj", pages: [{}] });

    const checked = await callTool("epro2_crosscheck", { file: project.path });
    expect(checked).toMatchObject({
      stats: { compared: 2, mismatch: 0, pcb_rows: 2 },
    });
    for (const tool of epro2Tools) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.input).toBeTruthy();
    }
  } finally {
    project.cleanup();
  }
});

test("加密 ZIP 在目录解析阶段明确报错", () => {
  const zip = buildStoredZip([{ name: "a.epru", data: Buffer.from(""), flags: 1 }]);
  expect(() => readZip(zip)).toThrow(ZipError);
  try {
    readZip(zip);
  } catch (error) {
    expect(String(error)).toContain("加密");
  }
});

test("CLI 帮助与未知子命令", async () => {
  const io = createMemoryIo();
  expect(await runEpro2Command([], io, {})).toBe(0);
  expect(io.lines.join("\n")).toContain("epro2 analyze");
  const bad = createMemoryIo();
  expect(await runEpro2Command(["nope"], bad, {})).toBe(1);
  expect(bad.errors.join("\n")).toContain("不认识的 epro2 子命令");
  const missing = createMemoryIo();
  expect(await runEpro2Command(["analyze"], missing, {})).toBe(2);
  expect(missing.errors.join("\n")).toContain("需要给出 .epro2");
});

test("CLI analyze --json 写产物并输出摘要", async () => {
  const project = tempProject();
  try {
    const outDir = path.join(project.dir, "out");
    const io = createMemoryIo();
    const code = await runEpro2Command(
      ["analyze", project.path, "--out", outDir, "--json"],
      io,
      {},
    );
    expect(code).toBe(0);
    const summary = JSON.parse(io.lines.join("\n")) as {
      project: string;
      pcb: { netlistRows: number };
      consistency: { compared: number };
      files: string[];
    };
    expect(summary.project).toBe("TestProj");
    expect(summary.pcb.netlistRows).toBe(2);
    expect(summary.consistency.compared).toBe(2);
    expect(summary.files.every((file) => fs.existsSync(file))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "report.md"))).toBe(true);
  } finally {
    project.cleanup();
  }
});

test("CLI diff --json 写差异产物", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-epro2-cli-"));
  try {
    const oldPath = path.join(dir, "old.epro2");
    const newPath = path.join(dir, "new.epro2");
    writeProject(oldPath, { netForPad2: "VCC" });
    writeProject(newPath, { netForPad2: "VCC2" });
    const outDir = path.join(dir, "diff");
    const io = createMemoryIo();
    const code = await runEpro2Command(
      ["diff", oldPath, newPath, "--out", outDir, "--json"],
      io,
      {},
    );
    expect(code).toBe(0);
    const result = JSON.parse(io.lines.join("\n")) as {
      netlist: { changed: number };
      elements: { changed: number };
      files: string[];
    };
    expect(result.netlist.changed).toBe(1);
    expect(result.elements.changed).toBe(1);
    for (const file of ["diff.json", "diff.md"]) {
      expect(fs.existsSync(path.join(outDir, file))).toBe(true);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
