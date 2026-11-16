import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { createMemoryIo } from "../src/core/io.ts";
import { ToolError } from "../src/mcp/types.ts";
import { runSimCommand } from "../src/sim/cli.ts";
import { simTools } from "../src/sim/mcpTools.ts";
import { writeProject } from "./fixtures/epro2/makeFixture.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "sim");

const ASCII_TRAN = `Title: tran
Plotname: Transient Analysis
Flags: real
No. Variables: 2
No. Points: 3
Variables:
\t0\ttime\ttime
\t1\tv(out)\tvoltage
Values:
0\t0.000000000000000e+00
\t0.000000000000000e+00
1\t1.000000000000000e-06
\t5.000000000000000e-01
2\t2.000000000000000e-06
\t1.000000000000000e+00
`;

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-sim-cli-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeTemp(dir: string, name: string, text: string): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
}

const SIMPLE_IR = {
  version: 1,
  source: "test",
  project: "cli-demo",
  page: { name: "P1" },
  components: [
    {
      componentType: "part",
      designator: "V1",
      pinPrefix: "V",
      deviceTitle: "电压源",
      manufacturerPart: "",
      value: "5V",
      pins: [
        { number: "1", name: "1" },
        { number: "2", name: "2" },
      ],
    },
    {
      componentType: "part",
      designator: "R1",
      pinPrefix: "R",
      deviceTitle: "R_0603",
      manufacturerPart: "",
      value: "10k",
      pins: [
        { number: "1", name: "1" },
        { number: "2", name: "2" },
      ],
    },
  ],
  wires: [],
  lines: [],
  nets: [
    {
      name: "VIN",
      origin: "wire",
      members: [
        { component: "V1", pin: "1" },
        { component: "R1", pin: "1" },
      ],
      pinCount: 2,
    },
    {
      name: "GND",
      origin: "netflag",
      members: [
        { component: "V1", pin: "2" },
        { component: "R1", pin: "2" },
      ],
      pinCount: 2,
    },
  ],
  warnings: [],
};

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = simTools.find((item) => item.name === name);
  expect(tool, name).toBeTruthy();
  return await tool!.run(args, { cfg: {} as never, env: process.env });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("sim 帮助与未知子命令", async () => {
  const io = createMemoryIo();
  expect(await runSimCommand([], io, {})).toBe(0);
  const help = io.lines.join("\n");
  expect(help).toContain("sim netlist");
  expect(help).toContain("sim run");
  expect(help).toContain("--mode");

  const bad = createMemoryIo();
  expect(await runSimCommand(["nope"], bad, {})).toBe(1);
  expect(bad.errors.join("\n")).toContain("不认识的 sim 子命令");

  const usage = createMemoryIo();
  expect(await runSimCommand(["run", "a.cir"], usage, {})).toBe(2);
  expect(usage.errors.join("\n")).toContain("--mode");
});

test("CLI netlist 从 IR 生成网表与报告", async () => {
  const temp = tempDir();
  try {
    const irPath = writeTemp(temp.dir, "ir.json", JSON.stringify(SIMPLE_IR));
    const outDir = path.join(temp.dir, "out");
    const io = createMemoryIo();
    const code = await runSimCommand(["netlist", irPath, "--ir", "--out", outDir], io, {});
    expect(code).toBe(0);
    const deck = fs.readFileSync(path.join(outDir, "schematic.cir"), "utf8");
    expect(deck).toContain("R1 VIN 0 10k");
    expect(deck).toContain("V1 VIN 0 DC 5V AC 0 0");
    const report = JSON.parse(fs.readFileSync(path.join(outDir, "netlist_report.json"), "utf8"));
    expect(report.counts.included).toBe(2);
    expect(io.lines.join("\n")).toContain("产物");
  } finally {
    temp.cleanup();
  }
});

test("CLI netlist 直接吃 .epro2 工程", async () => {
  const temp = tempDir();
  try {
    const projectPath = path.join(temp.dir, "TestProj.epro2");
    writeProject(projectPath);
    const outDir = path.join(temp.dir, "out");
    const io = createMemoryIo();
    const code = await runSimCommand(["netlist", projectPath, "--out", outDir, "--json"], io, {});
    expect(code).toBe(0);
    const summary = JSON.parse(io.lines.join("\n"));
    expect(summary.project).toBe("TestProj");
    expect(summary.page).toBe("P1");
    expect(summary.deck.endsWith("schematic.cir")).toBe(true);
    const deck = fs.readFileSync(summary.deck, "utf8");
    // R1 引脚 1 落地、引脚 2 接 VCC；U3/U4 是 TRI_3PIN，没有模型 → 排除。
    expect(deck).toContain("R1 0 VCC 10k");
    expect(deck).toContain(".end");
    expect(summary.counts.included).toBe(1);
    expect(summary.counts.excluded).toBe(2);
  } finally {
    temp.cleanup();
  }
});

test("CLI raw 支持 --list 与 --csv", async () => {
  const temp = tempDir();
  try {
    const rawPath = writeTemp(temp.dir, "tran.raw", ASCII_TRAN);
    const list = createMemoryIo();
    expect(await runSimCommand(["raw", rawPath, "--list"], list, {})).toBe(0);
    expect(list.lines.join("\n")).toContain("Transient Analysis");

    const csvIo = createMemoryIo();
    expect(await runSimCommand(["raw", rawPath, "--csv", "--json"], csvIo, {})).toBe(0);
    const summary = JSON.parse(csvIo.lines.find((line) => line.startsWith("[")) ?? "[]");
    expect(summary[0].plotname).toBe("Transient Analysis");
    expect(fs.existsSync(path.join(temp.dir, "tran.csv"))).toBe(true);
  } finally {
    temp.cleanup();
  }
});

test("CLI stackup 与 touchstone 输出摘要", async () => {
  const temp = tempDir();
  try {
    const stackupPath = writeTemp(
      temp.dir,
      "stackup.json",
      JSON.stringify({
        layers: [
          { name: "Top", type: "signal", copper_um: 35 },
          { name: "Inner1", type: "plane", copper_um: 35 },
        ],
        dielectrics: [{ between: ["Top", "Inner1"], thickness_mm: 0.18, er: 4.2 }],
      }),
    );
    const stackupIo = createMemoryIo();
    expect(
      await runSimCommand(["stackup", stackupPath, "Top", "0.2", "45.08"], stackupIo, {}),
    ).toBe(0);
    expect(stackupIo.lines.join("\n")).toContain("Z0 =");

    const touchstoneIo = createMemoryIo();
    expect(
      await runSimCommand(
        ["touchstone", path.join(FIXTURES, "touchstone", "fixture_lc_lpf.s2p")],
        touchstoneIo,
        {},
      ),
    ).toBe(0);
    expect(touchstoneIo.lines.join("\n")).toContain("插损");
  } finally {
    temp.cleanup();
  }
});

test("CLI probe 给出两端可用性", async () => {
  const io = createMemoryIo();
  const code = await runSimCommand(["probe", "--json"], io, process.env);
  expect(code === 0 || code === 1).toBe(true);
  const result = JSON.parse(io.lines.join("\n"));
  expect(typeof result.ngspice.available).toBe("boolean");
  expect(typeof result.python.available).toBe("boolean");
  expect(result.sidecar.scripts).toBeGreaterThan(40);
});

// ---------------------------------------------------------------------------
// MCP 工具
// ---------------------------------------------------------------------------

test("simTools 注册完整且描述是中文", () => {
  expect(simTools.map((tool) => tool.name).sort()).toEqual([
    "sim_metrics",
    "sim_netlist",
    "sim_probe",
    "sim_run",
    "sim_sidecar",
    "sim_stackup",
    "sim_touchstone",
  ]);
  for (const tool of simTools) {
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.input).toBeTruthy();
  }
});

test("sim_netlist 校验输入并落盘产物", async () => {
  const temp = tempDir();
  try {
    await expect(callTool("sim_netlist", { outDir: temp.dir })).rejects.toMatchObject({
      code: "SIM_INPUT_REQUIRED",
    });
    const irPath = writeTemp(temp.dir, "ir.json", JSON.stringify(SIMPLE_IR));
    const outDir = path.join(temp.dir, "out");
    const result = (await callTool("sim_netlist", { ir: irPath, outDir })) as Record<
      string,
      unknown
    >;
    expect(result.project).toBe("cli-demo");
    expect(result.counts).toMatchObject({ included: 2 });
    expect(fs.existsSync(path.join(outDir, "schematic.cir"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "netlist_report.json"))).toBe(true);
  } finally {
    temp.cleanup();
  }
});

test("sim_metrics 从 raw 算指标", async () => {
  const temp = tempDir();
  try {
    const rawPath = writeTemp(temp.dir, "tran.raw", ASCII_TRAN);
    const result = (await callTool("sim_metrics", {
      raw: rawPath,
      metrics: [{ name: "out", metric: "tran_stats", node: "OUT", v_low: 0, v_high: 1 }],
      mode: "tran",
    })) as Record<string, unknown>;
    expect(result.plots).toHaveLength(1);
    const metrics = result.metrics as Record<string, Record<string, unknown>>;
    expect(Number(metrics["out"]!["max"])).toBeCloseTo(1, 6);
    expect(result.errors).toEqual([]);
  } finally {
    temp.cleanup();
  }
});

test("sim_stackup 与 sim_touchstone 返回估计/摘要", async () => {
  const stackup = (await callTool("sim_stackup", {
    layers: [
      { name: "Top", type: "signal", copper_um: 35 },
      { name: "Inner1", type: "plane", copper_um: 35 },
    ],
    dielectrics: [{ between: ["Top", "Inner1"], thickness_mm: 0.18, er: 4.2 }],
    layer: "Top",
    widthMm: 0.2,
    lengthMm: 45.08,
    via: { id: "V1", drill_mm: 0.3, pad_mm: 0.6, length_mm: 1.6 },
  })) as Record<string, unknown>;
  const trace = stackup["trace"] as Record<string, unknown>;
  expect(Number(trace["z0_ohm"])).toBeGreaterThan(40);
  expect((stackup["via"] as Record<string, unknown>)["model_fidelity"]).toBe(
    "ENGINEERING_ESTIMATE",
  );

  const touchstone = (await callTool("sim_touchstone", {
    file: path.join(FIXTURES, "touchstone", "fixture_lc_lpf.s2p"),
  })) as Record<string, unknown>;
  const summary = touchstone.summary as Record<string, unknown>;
  expect(summary["num_ports"]).toBe(2);
  const metrics = touchstone.metrics as Record<string, unknown>;
  expect(Number(metrics["insertion_loss_db"])).toBeLessThan(0.5);
});

test("sim_sidecar 必须先 confirm，脚本名限定在 sidecar 目录", async () => {
  await expect(callTool("sim_sidecar", { script: "rf_network.py" })).rejects.toMatchObject({
    code: "CONFIRM_REQUIRED",
  });
  await expect(
    callTool("sim_sidecar", { script: "../evil.py", confirm: true }),
  ).rejects.toBeInstanceOf(ToolError);
  try {
    await callTool("sim_sidecar", { script: "nope.py", confirm: true });
    throw new Error("应当报错");
  } catch (thrown) {
    expect((thrown as ToolError).code).toBe("SIM_SIDECAR_SCRIPT_UNKNOWN");
  }
  expect(simTools.find((tool) => tool.name === "sim_sidecar")?.description).toContain(
    "confirm:true",
  );
});
