import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import type { SchematicIr } from "../src/epro2/contract.ts";

import {
  DEFAULTS,
  Namer,
  displayNode,
  loadSimConfig,
  quotePath,
  spiceIdent,
  spiceNode,
} from "../src/sim/config.ts";
import { DeckError, buildDeck, cleanNetlist, hasControlBlock } from "../src/sim/deck.ts";
import { GroundMap, isGroundLike } from "../src/sim/ground.ts";
import { fromSchematicIr, loadSimIr, normalizeIr, validateIr } from "../src/sim/ir.ts";
import {
  buildManifest,
  fidelityLines,
  fileHash,
  manifestSummaryLines,
} from "../src/sim/manifest.ts";
import { MetricError, computeMetrics } from "../src/sim/metrics.ts";
import { parseEng, tdFromLength, formatSignificant, fmt } from "../src/sim/parasitics.ts";
import { parseRawAscii, parseRawBuffer, parseRawFile, plotsToCsv } from "../src/sim/raw.ts";
import type { NetlistReport, RawPlot, SimIr } from "../src/sim/types.ts";

function tempDir(prefix = "lceda-sim-"): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function writeTemp(dir: string, name: string, text: string): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// config：命名与路径
// ---------------------------------------------------------------------------

test("spiceNode 把 $ 虚拟节点与数字开头网络改成 ngspice 安全名", () => {
  expect(spiceNode("0")).toBe("0");
  expect(spiceNode("$SRC")).toBe("__SRC");
  expect(spiceNode("$")).toBe("__V");
  expect(spiceNode("__AUTO_CLK_B1")).toBe("__AUTO_CLK_B1");
  expect(spiceNode("3V3")).toBe("N_3V3");
  expect(spiceNode("AVDD_1.8V")).toBe("AVDD_1.8V");
  expect(spiceNode("A B")).toBe("A_B");
  expect(spiceNode("")).toBe("N_unnamed");
  expect(spiceNode(null)).toBeNull();
  expect(displayNode("__CLK")).toBe("$CLK");
});

test("spiceIdent 清掉撇号、补齐首字母；Namer 大小写不敏感去重", () => {
  expect(spiceIdent("C2'")).toBe("C2_");
  expect(spiceIdent("123")).toBe("X123");
  expect(spiceIdent("")).toBe("X");
  const namer = new Namer();
  expect(namer.take("R1")).toBe("R1");
  expect(namer.take("r1")).toBe("r1_2");
  expect(namer.call("VPWR", "12V")).toBe("VPWR_12V");
});

test("quotePath 用正斜杠、能相对化、空格加引号", () => {
  const quoted = quotePath("dir with space/my lib.lib");
  expect(quoted.startsWith('"')).toBe(true);
  expect(quoted.endsWith('"')).toBe(true);
  expect(quoted).toContain("dir with space/my lib.lib");
  expect(quoted.includes("\\")).toBe(false);
  const relative = quotePath(
    path.join("D:", "proj", "deck", "ext", "reg.lib"),
    path.join("D:", "proj", "deck"),
  );
  expect(relative).toBe('"ext/reg.lib"');
});

test("loadSimConfig 深合并 DEFAULTS 并把相对模型路径解析成绝对路径", () => {
  const temp = tempDir();
  try {
    writeTemp(temp.dir, "model_map.json", JSON.stringify({ version: 2, parts: {} }));
    const configPath = writeTemp(
      temp.dir,
      "sim.json",
      JSON.stringify({ power_policy: "explicit", models: "model_map.json", metrics: [] }),
    );
    const config = loadSimConfig(configPath);
    expect(config.power_policy).toBe("explicit");
    expect(config.strict).toBe(DEFAULTS.strict);
    expect(config._path).toBe(path.resolve(configPath));
    expect(config._dir).toBe(temp.dir);
    expect(config.models).toBe(path.join(temp.dir, "model_map.json"));
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// ground：地映射策略
// ---------------------------------------------------------------------------

test("默认只有 GND/GROUND/0 映射到节点 0，AGND 等保持独立", () => {
  const ground = new GroundMap();
  expect(ground.map("GND")[0]).toBe("0");
  expect(ground.map("GROUND")[0]).toBe("0");
  expect(ground.map("0")[0]).toBe("0");
  expect(ground.isZero("gnd")).toBe(true);
  for (const name of ["AGND", "DGND", "PGND", "CHASSIS", "EARTH", "AGND1", "VSS", "GND1"]) {
    expect(ground.map(name)[0], name).toBeNull();
    expect(ground.isZero(name), name).toBe(false);
  }
  expect(isGroundLike("GND1")).toBe(true);
});

test("显式合并带标记，冲突报 GROUND_MAPPING_CONFLICT", () => {
  const merged = new GroundMap({ "0": ["GND", "AGND", "DGND"] });
  expect(merged.isZero("AGND")).toBe(true);
  expect(merged.isExplicitMergeToZero("AGND")).toBe(true);
  const [lines, mapping] = merged.report(["GND", "AGND", "DGND"]);
  expect(mapping["AGND"]).toBe("0");
  expect(lines.slice(1).some((line) => line.includes("explicit merge"))).toBe(true);

  const conflicting = new GroundMap({ "0": ["AGND"], AGND_REF: ["AGND"] });
  expect(conflicting.errors[0]?.code).toBe("GROUND_MAPPING_CONFLICT");
});

test("report 总是打印 Ground mapping 段（不静默）", () => {
  const ground = new GroundMap();
  const [lines, mapping] = ground.report(["GND", "AGND", "DGND", "VCC"]);
  expect(lines[0]).toBe("Ground mapping:");
  expect(mapping).toEqual({ GND: "0", AGND: "AGND", DGND: "DGND" });
  expect(ground.warnUnmerged(["GND", "AGND"])).toEqual(["AGND"]);
});

// ---------------------------------------------------------------------------
// deck：清洗与 .control 注入
// ---------------------------------------------------------------------------

test("cleanNetlist 去 Ω、去原有分析行、去 LCEDA 跟踪注释", () => {
  const raw = "* x\nR1 a 0 43kΩ\n.tran 1u 1m\n.ac dec 10 1 1meg\n*BeginTrace\n*EndTrace\n.end\n";
  const cleaned = cleanNetlist(raw);
  expect(cleaned).toContain("R1 a 0 43k");
  expect(cleaned.includes(".tran")).toBe(false);
  expect(cleaned.includes(".ac dec")).toBe(false);
  expect(cleaned.includes("BeginTrace")).toBe(false);
});

test("buildDeck 四种模式默认参数与 .end 锚定", () => {
  const raw = "* x\nR1 a 0 1k\n.end\n";
  for (const [mode, expectText] of [
    ["op", "op\nprint all"],
    ["tran", "tran 5u 25m"],
    ["ac", "ac dec 100 10 100meg"],
    ["dc", "dc V1 0 12 0.1"],
  ] as const) {
    const deck = buildDeck(raw, mode, mode === "dc" ? "V1 0 12 0.1" : null);
    expect(deck).toContain(expectText);
    expect(deck.split(".control").length - 1).toBe(1);
    expect(deck.trimEnd().endsWith(".end")).toBe(true);
  }
  expect(hasControlBlock("R1 a 0 1k\n.control\nop\n.endc\n.end\n")).toBe(true);
  expect(hasControlBlock(raw)).toBe(false);
});

test("buildDeck 不会误命中 .ENDS，custom 模式读控制块文件", () => {
  const raw = "* x\n.SUBCKT FOO A B\nR1 A B 1\n.ENDS FOO\nX1 a b FOO\n.end\n";
  const deck = buildDeck(raw, "op");
  expect(deck).toContain(".ENDS FOO");
  expect(deck.indexOf(".control")).toBeGreaterThan(deck.indexOf(".ENDS FOO"));

  const temp = tempDir();
  try {
    const control = writeTemp(temp.dir, "ctrl.txt", "op\nprint v(a)\n");
    const custom = buildDeck("R1 a 0 1k\n.end\n", "custom", control);
    expect(custom).toContain("print v(a)");
  } finally {
    temp.cleanup();
  }
  expect(() => buildDeck("R1 a 0 1k\n.end\n", "sweep")).toThrow(DeckError);
});

// ---------------------------------------------------------------------------
// raw：ASCII / 二进制 / 复数轴
// ---------------------------------------------------------------------------

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

const ASCII_AC = `Title: ac
Plotname: AC Analysis
Flags: complex
No. Variables: 2
No. Points: 2
Variables:
\t0\tfrequency\tfrequency
\t1\tv(out)\tvoltage
Values:
0\t1.000000000000000e+03,0.000000000000000e+00
\t1.000000000000000e+00,0.000000000000000e+00
1\t1.000000000000000e+06,0.000000000000000e+00
\t5.000000000000000e-01,-5.000000000000000e-01
`;

test("ASCII raw：实数与复数（X 轴也是成对）", () => {
  const [tran] = parseRawAscii(ASCII_TRAN);
  expect(tran?.plotname).toBe("Transient Analysis");
  expect(tran?.vars).toEqual(["time", "v(out)"]);
  expect(tran?.n_points).toBe(3);
  expect(tran?.points[1]).toEqual([0.000001, 0.5]);

  const [ac] = parseRawAscii(ASCII_AC);
  expect(ac?.flags).toContain("complex");
  expect(ac?.points[0]).toEqual([
    [1000, 0],
    [1, 0],
  ]);
  expect(ac?.points[1]).toEqual([
    [1000000, 0],
    [0.5, -0.5],
  ]);
});

test("多 plot ASCII 顺序解析", () => {
  const plots = parseRawAscii(ASCII_TRAN + "\n" + ASCII_AC);
  expect(plots.map((plot) => plot.plotname)).toEqual(["Transient Analysis", "AC Analysis"]);
});

test("二进制 raw：little-endian double", () => {
  const header =
    "Title: op\nPlotname: Operating Point\nFlags: real\nNo. Variables: 2\nNo. Points: 2\n" +
    "Variables:\n\t0\ttime\ttime\n\t1\tv(a)\tvoltage\nBinary:\n";
  const body = Buffer.alloc(2 * 2 * 8);
  const values = [0, 1, 1, 2];
  values.forEach((value, index) => body.writeDoubleLE(value, index * 8));
  const data = Buffer.concat([Buffer.from(header, "latin1"), body]);
  const plots = parseRawBuffer(data);
  expect(plots).toHaveLength(1);
  expect(plots[0]?.points).toEqual([
    [0, 1],
    [1, 2],
  ]);
});

test("raw 落盘解析与 CSV 导出", () => {
  const temp = tempDir();
  try {
    const rawPath = writeTemp(temp.dir, "tran.raw", ASCII_TRAN);
    const plots = parseRawFile(rawPath);
    expect(plots).toHaveLength(1);
    const missing = path.join(temp.dir, "empty.raw");
    fs.writeFileSync(missing, "Title: x\n", "utf8");
    expect(() => parseRawFile(missing)).toThrow(/RAW_NO_PLOTS|没有从 raw/);
    const csvPath = path.join(temp.dir, "tran.csv");
    plotsToCsv(plots, csvPath);
    const csv = fs.readFileSync(csvPath, "utf8");
    expect(csv.startsWith("# Transient Analysis")).toBe(true);
    expect(csv).toContain("time,v(out)");
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// metrics：指标提取
// ---------------------------------------------------------------------------

function mkPlot(times: number[], values: number[], name = "v(a)", flags = "real"): RawPlot {
  return {
    plotname: "Test",
    flags,
    vars: ["time", name],
    points: times.map((time, index) => [time, values[index] ?? 0]),
    n_points: times.length,
    title: "",
    n_vars: 2,
  };
}

function stepWithOvershoot(): RawPlot {
  const times: number[] = [];
  const values: number[] = [];
  let t = 0;
  while (t < 10.0001) {
    times.push(Number(t.toFixed(6)));
    if (t < 2) values.push(0);
    else if (t < 2.5) values.push((t - 2) / 0.5);
    else if (t < 3) values.push(1 + (0.2 * (t - 2.5)) / 0.5);
    else if (t < 3.5) values.push(1.2 - (0.2 * (t - 3)) / 0.5);
    else values.push(1);
    t += 0.01;
  }
  return mkPlot(times, values);
}

test("tran_stats 给过冲与上升时间", () => {
  const result = computeMetrics(
    [stepWithOvershoot()],
    [{ name: "s", metric: "tran_stats", node: "A", v_low: 0, v_high: 1 }],
  );
  const stats = result.metrics["s"]!;
  expect(result.errors).toHaveLength(0);
  expect(stats["max"]).toBeCloseTo(1.2, 6);
  expect(stats["min"]).toBeCloseTo(0, 6);
  expect(stats["peak_to_peak"]).toBeCloseTo(1.2, 6);
  expect(stats["overshoot_pct"]).toBeCloseTo(20, 1);
  expect(stats["rise_time"]).toBeCloseTo(0.4, 1);
});

test("DC 电源轨报纹波而不是过冲", () => {
  const times = Array.from({ length: 1000 }, (_, index) => index * 1e-6);
  const values = times.map((_, index) => 5 + 0.001 * Math.sin(index / 10));
  const result = computeMetrics(
    [mkPlot(times, values, "v(avdd)")],
    [{ name: "avdd", metric: "tran_stats", node: "AVDD" }],
  );
  const stats = result.metrics["avdd"]!;
  expect(stats["signal_kind"]).toBe("rail");
  expect(stats["overshoot_pct"]).toBeUndefined();
  expect(Number(stats["ripple_pct"])).toBeCloseTo(0.04, 1);
});

test("threshold_crossings 识别振铃", () => {
  const times: number[] = [];
  const values: number[] = [];
  let t = 0;
  while (t < 1.5) {
    if (t < 1) values.push(0);
    else if (t < 1.002) values.push(1);
    else if (t < 1.004) values.push(0);
    else if (t < 1.1) values.push(1);
    else values.push(t % 0.1 < 0.001 ? 0 : 1);
    times.push(Number(t.toFixed(6)));
    t += 0.0005;
  }
  const result = computeMetrics(
    [mkPlot(times, values, "v(clk)")],
    [{ name: "c", metric: "threshold_crossings", node: "CLK", threshold: 0.5 }],
  );
  const metric = result.metrics["c"]!;
  expect(metric["ringing"]).toBe(true);
  expect(Number(metric["max_crossings_in_edge"])).toBeGreaterThanOrEqual(3);
  expect(Number(metric["crossings_per_edge"])).toBeGreaterThan(1);
});

test("time_delta 算 skew", () => {
  const times = Array.from({ length: 2000 }, (_, index) => index * 1e-12);
  const a = times.map((time) => (time < 500e-12 ? 0 : 1));
  const b = times.map((time) => (time < 620e-12 ? 0 : 1));
  const plot: RawPlot = {
    plotname: "T",
    flags: "real",
    vars: ["time", "v(a)", "v(b)"],
    points: times.map((time, index) => [time, a[index] ?? 0, b[index] ?? 0]),
    n_points: times.length,
    title: "",
    n_vars: 3,
  };
  const result = computeMetrics(
    [plot],
    [{ name: "skew", metric: "time_delta", a: "A@0.5", b: "B@0.5" }],
  );
  expect(result.errors).toHaveLength(0);
  expect(Number(result.metrics["skew"]!["skew"])).toBeCloseTo(120e-12, 15);
});

test("impedance 从复数 AC 取模并按 amplitude 归一", () => {
  const plot: RawPlot = {
    plotname: "AC",
    flags: "complex",
    vars: ["frequency", "v(avdd)"],
    points: [
      [
        [1e3, 0],
        [0.1, 0],
      ],
      [
        [1e5, 0],
        [0.2, 0],
      ],
      [
        [1e7, 0],
        [0.05, 0.05],
      ],
    ],
    n_points: 3,
    title: "",
    n_vars: 2,
  };
  const first = computeMetrics(
    [plot],
    [{ name: "z", metric: "impedance", node: "AVDD", amplitude: 1, at: [1e5] }],
    "ac",
  );
  const metric = first.metrics["z"]!;
  expect(Number(metric["max_impedance"])).toBeCloseTo(0.2, 9);
  expect(Number(metric["peak_frequency"])).toBeCloseTo(1e5, 3);
  expect(Number(metric["z_at_100000"])).toBeCloseTo(0.2, 6);

  const divided = computeMetrics(
    [plot],
    [{ name: "z", metric: "impedance", node: "AVDD", amplitude: 2 }],
    "ac",
  );
  expect(Number(divided.metrics["z"]!["max_impedance"])).toBeCloseTo(0.1, 9);
});

test("fft_harmonics 找到基波，二次/三次谐波远低于基波", () => {
  const f0 = 1000;
  const times = Array.from({ length: 2000 }, (_, index) => index * 1e-5);
  const values = times.map((time) => Math.sin(2 * Math.PI * f0 * time));
  const result = computeMetrics(
    [mkPlot(times, values)],
    [{ name: "h", metric: "fft_harmonics", node: "A", f0, n: 3 }],
  );
  const harmonics = result.metrics["h"]!["harmonics"] as {
    magnitude: number;
    relative_db: number;
  }[];
  expect(harmonics[0]!.magnitude).toBeGreaterThan(0.5);
  expect(harmonics[1]!.relative_db).toBeLessThan(-30);
  expect(harmonics[2]!.relative_db).toBeLessThan(-30);
});

test("找不到节点时记为指标错误而不是崩掉", () => {
  const result = computeMetrics(
    [mkPlot([0, 1], [0, 1])],
    [{ name: "x", metric: "tran_stats", node: "NOPE" }],
  );
  expect(result.metrics["x"]!["error"]).toBe("METRIC_NODE_NOT_FOUND");
  expect(result.errors).toHaveLength(1);
  expect(() => computeMetrics([], undefined)).not.toThrow();
  expect(() => computeMetrics([mkPlot([0], [0])], [{ metric: "tran_stats" }])).not.toThrow();
});

test("MetricError 带 code", () => {
  const error = new MetricError("METRIC_EMPTY", "x");
  expect(error.code).toBe("METRIC_EMPTY");
  expect(error).toBeInstanceOf(Error);
});

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

test("manifest 字段与 fidelity 段落", () => {
  const report: NetlistReport = {
    version: "2.6.0",
    included: [],
    excluded: [
      { designator: "U9", title: "MYSTERY", mpn: "", reason: "无模型", level: "EXCLUDED" },
    ],
    generic: [],
    powers: [],
    dangling_nets: [],
    warnings: [],
    errors: [],
    models: [],
    behavioral: [],
    ibis: [],
    overrides: [],
    ground_mapping: { GND: "0" },
    net_segments: [],
    virtual_nodes: [],
    power_policy: "auto",
    strict: false,
    fidelity: {
      blocks: {
        "R1 (R)": { level: 0, what: "R", designator: "R1" },
        "U1 (x)": { level: 3, what: "x", designator: "U1" },
      },
      overall_level: 3,
    },
    includes: [],
  };
  const lines = fidelityLines(report);
  expect(lines[0]).toBe("Simulation fidelity:");
  expect(lines.some((line) => line.includes("overall: Level 3"))).toBe(true);
  const manifest = buildManifest(report, { mode: "tran" }, { project: "p", ngspice: "ngspice-47" });
  expect(manifest.skill_version).toBe("2.6.0");
  expect(manifest.excluded_components[0]?.["designator"]).toBe("U9");
  expect(manifest.ground_mapping).toEqual({ GND: "0" });
  expect(manifestSummaryLines(manifest)[0]).toContain("ngspice-47");
});

test("fileHash 对同一内容稳定，缺文件返回 null", () => {
  const temp = tempDir();
  try {
    const file = writeTemp(temp.dir, "a.txt", "hello");
    expect(fileHash(file)).toHaveLength(64);
    expect(fileHash(file)).toBe(fileHash(file));
    expect(fileHash(path.join(temp.dir, "missing.txt"))).toBeNull();
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// IR
// ---------------------------------------------------------------------------

test("IR 从 .epro2 原理图产物补齐字段（epro2 是上游）", () => {
  const schematic = {
    project: "demo",
    page: { uuid: "pg1", name: "P1", docType: "SCH_PAGE" },
    components: [
      {
        id: "c1",
        componentType: "part",
        designator: "U1",
        deviceUuid: "d1",
        deviceTitle: "Regulator",
        manufacturerPart: "REG1",
        value: "3.3V ",
        x: 100.004,
        y: 200.006,
        rotation: 90,
        mirror: false,
        pins: [
          { number: "1", name: "VIN", x: 80, y: 200 },
          { number: "2", name: "GND", x: 120, y: 200 },
        ],
        attrs: { Name: "Regulator" },
      },
      {
        id: "n1",
        componentType: "netflag",
        designator: null,
        deviceTitle: "GND",
        manufacturerPart: null,
        value: null,
        x: 120,
        y: 200,
        rotation: 0,
        mirror: false,
        pins: [{ number: "1", name: "1", x: 120, y: 200 }],
        attrs: {},
        net: "GND",
      },
    ],
    wires: [{ id: "w1", line: [80.001, 200, 120.0001, 200], net: "VCC" }],
    nets: [
      {
        name: "GND",
        named: true,
        conflicts: [],
        pins: [
          { designator: "U1", pinNumber: "2", pinName: "GND", componentType: "part" },
          { designator: null, pinNumber: "1", pinName: "1", componentType: "netflag" },
        ],
      },
      {
        name: "VCC",
        named: true,
        conflicts: [],
        pins: [{ designator: "U1", pinNumber: "1", pinName: "VIN", componentType: "part" }],
      },
    ],
    warnings: ["一个页面警告"],
  };
  const ir = fromSchematicIr(schematic as unknown as SchematicIr);
  expect(ir.source).toBe("analysis");
  expect(ir.project).toBe("demo");
  expect(ir.components[0]?.pinPrefix).toBe("U");
  expect(ir.components[0]?.value).toBe("3.3V");
  expect(ir.components[0]?.x).toBe(100);
  expect(ir.wires[0]?.line).toEqual([80, 200, 120, 200]);
  expect(ir.nets[0]?.origin).toBe("netflag");
  expect(ir.nets[0]?.members).toEqual([{ component: "U1", pin: "2", pinName: "GND" }]);
  expect(ir.nets[1]?.origin).toBe("wire");
  expect(ir.warnings).toContain("一个页面警告");
});

test("loadSimIr 读夹具并做归一化，validateIr 给出提示", () => {
  const fixture = path.join(HERE, "fixtures", "sim", "wolf_lite_pdn", "ir.json");
  const ir = loadSimIr(fixture);
  expect(ir.components.length).toBeGreaterThan(0);
  expect(ir.nets.length).toBeGreaterThan(0);
  expect(ir.components.every((comp) => typeof comp.pinPrefix === "string")).toBe(true);
  const warnings = validateIr(ir);
  expect(warnings.some((warning) => warning.includes("导线"))).toBe(true);
  const normalized = normalizeIr(ir);
  expect(normalized).toBe(ir);
});

test("新 IR 的默认字段与 pinNet 表", () => {
  const ir: SimIr = {
    version: 1,
    source: "test",
    project: null,
    page: {},
    components: [],
    wires: [],
    lines: [],
    nets: [
      {
        name: "A",
        members: [
          { component: "R1", pin: "1" },
          { component: "R1", pin: "2" },
        ],
      },
    ],
    warnings: [],
  };
  expect(validateIr(ir)[0]).toContain("没有任何 part 元件");
});

// ---------------------------------------------------------------------------
// parasitics 数值文本
// ---------------------------------------------------------------------------

test("parseEng 支持 SPICE 后缀，单位名忽略，歧义尾缀报错", () => {
  expect(parseEng("180p")).toBeCloseTo(1.8e-10, 15);
  expect(parseEng("2.2meg")).toBeCloseTo(2.2e6, 6);
  expect(parseEng("1kohm")).toBeCloseTo(1000, 9);
  expect(parseEng("10µ")).toBeCloseTo(1e-5, 15);
  expect(parseEng(5)).toBe(5);
  expect(() => parseEng("4k7")).toThrow(/无法解析/);
  expect(() => parseEng("1zz")).toThrow(/尾缀/);
});

test("tdFromLength 单位换算精确，越界参数被拦", () => {
  const [td, derivation] = tdFromLength(45.08, 6);
  expect(td * 1e12).toBeCloseTo(270.48, 9);
  expect(derivation[2]).toContain("270.5 ps");
  expect(() => tdFromLength(0, 6)).toThrow(/length_mm 必须 > 0/);
  expect(() => tdFromLength(1, 0)).toThrow(/velocity_ps_per_mm 必须 > 0/);
  expect(() => tdFromLength(1, 100)).toThrow(/不合理/);
});

test("fmt 与 Python .6g 对齐", () => {
  expect(fmt(1e-10)).toBe("1e-10");
  expect(fmt(0)).toBe("0");
  expect(fmt(123456789)).toBe("1.23457e+08");
  expect(fmt(0.5)).toBe("0.5");
  expect(formatSignificant(20, 1)).toBe("2e+01");
});
