import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import {
  Stackup,
  StackupError,
  estimateGeometryTrace,
  estimateNetTrace,
  estimateVias,
  microstripZ0,
  striplineZ0,
  traceParams,
  viaParasitics,
} from "../src/sim/stackup.ts";
import {
  TouchstoneError,
  impedance1Port,
  parseTouchstone,
  touchstoneLoss,
  touchstoneMetrics,
} from "../src/sim/touchstone.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "sim");

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-sim-si-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeStackup(
  dir: string,
  options: { copper?: boolean; er?: number | null; h?: number } = {},
): string {
  const layers = [
    { name: "Top", type: "signal", copper_um: options.copper === false ? null : 35 },
    { name: "Inner1", type: "plane", copper_um: options.copper === false ? null : 35 },
  ];
  const dielectric: Record<string, unknown> = {
    between: ["Top", "Inner1"],
    thickness_mm: options.h ?? 0.18,
  };
  if (options.er !== null) dielectric["er"] = options.er ?? 4.2;
  const file = path.join(dir, "stackup.json");
  fs.writeFileSync(file, JSON.stringify({ layers, dielectrics: [dielectric] }), "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// 叠层：缺失要报，绝不默认 FR4
// ---------------------------------------------------------------------------

test("缺铜厚时 validate 报缺失，requireComplete 抛 STACKUP_INCOMPLETE", () => {
  const temp = tempDir();
  try {
    const stackup = Stackup.fromFile(writeStackup(temp.dir, { copper: false }));
    expect(stackup.validate().some((item) => item.includes("copper thickness"))).toBe(true);
    expect(() => stackup.requireComplete()).toThrow(StackupError);
    try {
      stackup.requireComplete();
    } catch (error) {
      expect((error as StackupError).code).toBe("STACKUP_INCOMPLETE");
    }
  } finally {
    temp.cleanup();
  }
});

test("没有 εr 时报缺失，不默认 4.5", () => {
  const temp = tempDir();
  try {
    const stackup = Stackup.fromFile(writeStackup(temp.dir, { er: null }));
    expect(stackup.validate().some((item) => item.includes("er missing"))).toBe(true);
  } finally {
    temp.cleanup();
  }
});

test("微带线 Z0 与 TD 量级正确（45.08 mm ≈ 266 ps）", () => {
  const temp = tempDir();
  try {
    const stackup = Stackup.fromFile(writeStackup(temp.dir));
    const trace = traceParams(stackup, "Top", 0.2, 45.08);
    expect(trace.model).toBe("microstrip");
    expect(trace.z0_ohm).toBeGreaterThan(50);
    expect(trace.z0_ohm).toBeLessThan(70);
    expect(trace.td_ps).toBeGreaterThan(250);
    expect(trace.td_ps).toBeLessThan(290);
    expect(trace.model_fidelity).toBe("ANALYTIC_ESTIMATE");
  } finally {
    temp.cleanup();
  }
});

test("内层选带状线模型", () => {
  const temp = tempDir();
  try {
    const file = path.join(temp.dir, "s.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        layers: [
          { name: "Top", type: "signal", copper_um: 35 },
          { name: "In1", type: "signal", copper_um: 35 },
          { name: "Bot", type: "signal", copper_um: 35 },
        ],
        dielectrics: [
          { between: ["Top", "In1"], thickness_mm: 0.2, er: 4.2 },
          { between: ["In1", "Bot"], thickness_mm: 0.2, er: 4.2 },
        ],
      }),
      "utf8",
    );
    const stackup = Stackup.fromFile(file);
    const trace = traceParams(stackup, "In1", 0.15, 10);
    expect(trace.model).toBe("stripline");
    expect(trace.z0_ohm).toBeGreaterThan(20);
  } finally {
    temp.cleanup();
  }
});

test("微带/带状线公式对参数非法给出明确错误", () => {
  expect(() => microstripZ0(0, 0.2, 0, 4.2)).toThrow(/线宽\/介质厚度必须 > 0/);
  expect(() => microstripZ0(0.2, 0.2, 0, 0.5)).toThrow(/εr/);
  expect(() => striplineZ0(0.2, 0, 0, 4.2)).toThrow(/线宽\/板厚必须 > 0/);
  const [, epsEff] = microstripZ0(0.2, 0.18, 0.035, 4.2);
  expect(epsEff).toBeGreaterThan(1);
});

// ---------------------------------------------------------------------------
// 走线 / 过孔估算
// ---------------------------------------------------------------------------

test("走线宽度缺失时报 TRACE_WIDTH_MISSING，给默认宽度则告警并继续", () => {
  const temp = tempDir();
  try {
    const stackup = Stackup.fromFile(writeStackup(temp.dir));
    const geoNet = {
      segments: [{ layer: "Top", width_mm: 0, length_mm: 10 }],
    };
    expect(() => estimateNetTrace("CLK", geoNet, stackup)).toThrow(/走线宽度为 0\/缺失/);
    const [segments, warnings] = estimateNetTrace("CLK", geoNet, stackup, {
      defaultWidthMm: 0.2,
    });
    expect(segments).toHaveLength(1);
    expect(warnings[0]).toContain("走线宽度缺失");
    expect(segments[0]!.z0_ohm).toBeGreaterThan(0);
    expect(segments[0]!.model_fidelity).toBe("ANALYTIC_ESTIMATE");
  } finally {
    temp.cleanup();
  }
});

test("走线按最宽估计，用户 override 改标 USER_OVERRIDE", () => {
  const temp = tempDir();
  try {
    const stackup = Stackup.fromFile(writeStackup(temp.dir));
    const geoNet = {
      segments: [{ layer: "Top", width_mm: [0.2, 0.3], length_mm: 10, from: "U1.1", to: "U2.1" }],
    };
    const [segments, warnings] = estimateNetTrace("CLK", geoNet, stackup, {
      overrides: { Top: { z0: 55, td_ps_per_mm: 6.5 } },
    });
    expect(warnings.some((warning) => warning.includes("混有多种线宽"))).toBe(true);
    expect(segments[0]!["z0_ohm"]).toBe(55);
    expect(segments[0]!["td_ps_per_mm"]).toBe(6.5);
    expect(segments[0]!["td_ps"]).toBeCloseTo(65, 6);
    expect(segments[0]!["model_fidelity"]).toBe("USER_OVERRIDE");
  } finally {
    temp.cleanup();
  }
});

test("整个几何副本带上 Z0/TD 与叠层，不改原对象", () => {
  const temp = tempDir();
  try {
    const stackup = Stackup.fromFile(writeStackup(temp.dir));
    const geo = {
      nets: {
        CLK: { segments: [{ layer: "Top", width_mm: 0.2, length_mm: 5 }] },
      },
      warnings: ["原警告"],
    };
    const result = estimateGeometryTrace(geo, stackup);
    expect((result["nets"] as Record<string, unknown>)["CLK"]).toBeTruthy();
    expect(result["stackup"]).toBeTruthy();
    expect((result["warnings"] as string[])[0]).toBe("原警告");
    expect((geo.nets.CLK.segments[0] as Record<string, unknown>)["z0_ohm"]).toBeUndefined();
  } finally {
    temp.cleanup();
  }
});

test("过孔寄生 R/L/C 量级合理，缺长度/εr 时明确报错", () => {
  const temp = tempDir();
  try {
    const stackup = Stackup.fromFile(writeStackup(temp.dir));
    const parasitics = viaParasitics({ id: "V1", drill_mm: 0.3, pad_mm: 0.6 }, stackup, {
      boardThicknessMm: 1.6,
    });
    expect(parasitics.l_nh).toBeGreaterThan(0.8);
    expect(parasitics.l_nh).toBeLessThan(2.0);
    expect(parasitics.c_pf).toBeGreaterThan(0.1);
    expect(parasitics.c_pf).toBeLessThan(1.5);
    expect(parasitics.r_ohm).toBeLessThan(0.01);
    expect(parasitics.model_fidelity).toBe("ENGINEERING_ESTIMATE");
    expect(() => viaParasitics({ id: "V2" }, null)).toThrow(/VIA_LENGTH_UNKNOWN|过孔长度未知/);

    const [vias, warnings] = estimateVias(
      { vias: [{ id: "V3", drill_mm: 0.3, pad_mm: 0.6, nodes: ["N1", "N2"] }] },
      stackup,
      1.6,
    );
    expect(vias[0]?.["nodes"]).toEqual(["N1", "N2"]);
    expect(warnings).toHaveLength(0);
    const [missing] = estimateVias({ vias: [{ id: "V4" }] }, null, null);
    expect(missing).toHaveLength(0);
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Touchstone
// ---------------------------------------------------------------------------

test("RI 与 DB/MHz 两种写法解析结果等价", () => {
  const ri = parseTouchstone(path.join(FIXTURES, "touchstone", "fixture_lc_lpf.s2p"));
  const db = parseTouchstone(path.join(FIXTURES, "touchstone", "fixture_lc_lpf_db_mhz.s2p"));
  expect(ri.num_ports).toBe(2);
  expect(ri.frequencies.length).toBe(db.frequencies.length);
  for (let index = 0; index < ri.frequencies.length; index += 1) {
    expect(ri.frequencies[index]! / db.frequencies[index]!).toBeCloseTo(1, 9);
  }
  const riDb = ri.db(1, 0);
  const dbDb = db.db(1, 0);
  for (let index = 0; index < riDb.length; index += 1) {
    expect(Math.abs(riDb[index]! - dbDb[index]!)).toBeLessThan(1e-3);
  }
});

test("1 端口：|Z| 与回损", () => {
  const touchstone = parseTouchstone(path.join(FIXTURES, "touchstone", "fixture_bead_1port.s1p"));
  expect(touchstone.num_ports).toBe(1);
  const metrics = touchstoneMetrics(touchstone);
  expect((metrics["|z|_ohm"] as number[])[0]!).toBeGreaterThan(0);
  expect(Number(metrics["return_loss_db"])).toBeGreaterThan(0);
  const impedances = impedance1Port(touchstone);
  expect(impedances).toHaveLength(touchstone.frequencies.length);
  const loss = touchstoneLoss(touchstone);
  expect(loss.insertion_loss_db).toBeNull();
});

test("2 端口：插损、回损、-3 dB 带宽与谐振", () => {
  const touchstone = parseTouchstone(path.join(FIXTURES, "touchstone", "fixture_lc_lpf.s2p"));
  const metrics = touchstoneMetrics(touchstone);
  expect(Number(metrics["insertion_loss_db"])).toBeLessThan(0.5);
  const bandwidth = metrics["bandwidth_3db"] as { bandwidth: number };
  expect(bandwidth.bandwidth).toBeGreaterThan(10e6);
  expect((metrics["resonances"] as unknown[]).length).toBeGreaterThan(0);
  expect(metrics["is_reciprocal"]).toBe(true);
  const loss = touchstoneLoss(touchstone);
  expect(loss.insertion_loss_db).toBeCloseTo(Number(metrics["insertion_loss_db"]), 6);
  expect(loss.return_loss_db).toBeCloseTo(Number(metrics["return_loss_db"]), 6);
});

test("非 .sNp、Y 参数、缺文件都明确报错", () => {
  const temp = tempDir();
  try {
    const txt = path.join(temp.dir, "x.txt");
    fs.writeFileSync(txt, "# Hz S RI R 50\n1e6 1 0\n", "utf8");
    expect(() => parseTouchstone(txt)).toThrow(TouchstoneError);
    try {
      parseTouchstone(txt);
    } catch (error) {
      expect((error as TouchstoneError).code).toBe("TOUCHSTONE_NOT_SPARAM");
    }

    const yParam = path.join(temp.dir, "y.s2p");
    fs.writeFileSync(yParam, "# Hz Y RI R 50\n1e6 1 0 0 0 0 0 0 0\n", "utf8");
    expect(() => parseTouchstone(yParam)).toThrow(/只支持 S 参数/);

    const missing = path.join(temp.dir, "nope.s2p");
    try {
      parseTouchstone(missing);
    } catch (error) {
      expect((error as TouchstoneError).code).toBe("TOUCHSTONE_FILE_MISSING");
    }

    const badCount = path.join(temp.dir, "bad.s2p");
    fs.writeFileSync(badCount, "# Hz S RI R 50\n1e6 1 0\n", "utf8");
    expect(() => parseTouchstone(badCount)).toThrow(/整数倍/);
  } finally {
    temp.cleanup();
  }
});
