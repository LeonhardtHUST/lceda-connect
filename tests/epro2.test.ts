import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import {
  analyzeSummary,
  checkConsistency,
  collect,
  findFloating,
  runSingle,
} from "../src/epro2/analyze.ts";
import type { Artifacts, PcbRow, SchematicIr } from "../src/epro2/contract.ts";
import { ProjectError, openProject } from "../src/epro2/container.ts";
import { compare } from "../src/epro2/diff.ts";
import { decodeMemberName } from "../src/epro2/gbk.ts";
import { buildDevices, buildSymbols, placementOf } from "../src/epro2/library.ts";
import {
  buildGeometry,
  buildNetlist,
  componentMeta,
  formatNetlistCsv,
  polyPoints,
  rotate,
} from "../src/epro2/pcb.ts";
import { docElements, makeRecordKey, parseRecords } from "../src/epro2/records.ts";
import { buildNets, pageToIr, pinKey } from "../src/epro2/schematic.ts";
import {
  GBK_EPRU_NAME,
  doc,
  rec,
  writeGbkProject,
  writeProject,
  type FixtureOptions,
} from "./fixtures/epro2/makeFixture.ts";

interface TempProject {
  dir: string;
  path: string;
}

function makeTmp(options: FixtureOptions = {}): TempProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-epro2-test-"));
  const projectPath = path.join(dir, "TestProj.epro2");
  writeProject(projectPath, options);
  return { dir, path: projectPath };
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function parseFixture(projectPath: string) {
  const proj = openProject(projectPath);
  return { proj, docs: parseRecords(proj.epruText) };
}

function symbolsOf(docs: ReturnType<typeof parseRecords>) {
  return buildSymbols(docs);
}

function devicesOf(docs: ReturnType<typeof parseRecords>) {
  return buildDevices(docs);
}

function makeIr(components: SchematicIr["components"], wires: SchematicIr["wires"]): SchematicIr {
  return {
    project: null,
    page: { uuid: "p", name: "P", docType: "SCH_PAGE" },
    components,
    wires,
    nets: [],
    warnings: [],
  };
}

function emptyArtifacts(rows: PcbRow[], pinNet: Map<string, string>): Artifacts {
  return {
    meta: {
      project: "T",
      source: "T.epro2",
      epru: "T.epru",
      record_lines: 0,
      record_unparsed: 0,
      project_meta: {},
      documents: [],
      library: { symbols: 0, devices: 0, footprints: 0 },
      pages: [],
      pages_analyzed: [],
      pages_analyzed_uuids: [],
    },
    pages_ir: [],
    pin_net: pinNet,
    ambiguous: new Map(),
    multi_page_designators: {},
    pcb_rows: rows,
    pcb_warnings: [],
    geometry: {
      unit: "mil",
      outline: null,
      outlines: [],
      layers: [],
      stackup: [],
      traces: [],
      segments: [],
      vias: [],
      pads: [],
      warnings: [],
    },
  };
}

// ─── 容器 ──────────────────────────────────────────────────────────

test("成员名、标题与 .epru 识别", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const proj = openProject(projectPath);
    expect(proj.title).toBe("TestProj");
    expect(proj.members.map((member) => member.name)).toContain("project2.json");
    expect(proj.epruName.endsWith(".epru")).toBe(true);
  } finally {
    cleanup(dir);
  }
});

test("GBK 成员名还原", () => {
  const { dir } = makeTmp();
  try {
    expect(decodeMemberName(GBK_EPRU_NAME, false)).toBe("工程文件.epru");
    // 源仓库用例的形态：先按 cp437 解出字符串，再走一次还原。
    expect(decodeMemberName("╣ñ│╠╬─╝■.epru")).toBe("工程文件.epru");
    const gbkPath = path.join(dir, "Gbk.epro2");
    writeGbkProject(gbkPath);
    const proj = openProject(gbkPath);
    expect(proj.epruName).toBe("工程文件.epru");
  } finally {
    cleanup(dir);
  }
});

test("非 ZIP 文件抛 ProjectError", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-epro2-test-"));
  try {
    const bad = path.join(dir, "bad.epro2");
    fs.writeFileSync(bad, "not a zip");
    expect(() => openProject(bad)).toThrow(ProjectError);
  } finally {
    cleanup(dir);
  }
});

test("文件不存在抛 ProjectError", () => {
  expect(() => openProject(path.join(os.tmpdir(), "definitely-missing.epro2"))).toThrow(
    ProjectError,
  );
});

// ─── 记录流 ────────────────────────────────────────────────────────

test("文档类型齐全", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const { docs } = parseFixture(projectPath);
    const types = docs.map((item) => item.docType);
    for (const expected of ["SYMBOL", "DEVICE", "FOOTPRINT", "SCH_PAGE", "PCB"]) {
      expect(types).toContain(expected);
    }
  } finally {
    cleanup(dir);
  }
});

test("ticket 归约取最新记录", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const { docs } = parseFixture(projectPath);
    const pcb = docs.find((item) => item.docType === "PCB");
    expect(pcb).toBeTruthy();
    const key = makeRecordKey("PAD_NET", '["PAD_NET", "pc1", "2", "pd2"]');
    const entry = pcb?.elems.get(key);
    expect(entry).toBeTruthy();
    expect(entry!.ticket).toBe(20);
    expect((entry!.payload as { padNet?: string }).padNet).toBe("VCC");
  } finally {
    cleanup(dir);
  }
});

// ─── PCB 权威网表 ──────────────────────────────────────────────────

function fixtureRows(projectPath: string): PcbRow[] {
  const docs = parseRecords(openProject(projectPath).epruText);
  return buildNetlist(docs, symbolsOf(docs), devicesOf(docs)).rows;
}

test("PAD_NET 最新 ticket 生效", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const byPad = new Map(fixtureRows(projectPath).map((row) => [row.pad, row.net]));
    expect(byPad.get("1")).toBe("GND");
    expect(byPad.get("2")).toBe("VCC");
  } finally {
    cleanup(dir);
  }
});

test("无位号残留元件被剔除", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const rows = fixtureRows(projectPath);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.designator === "R1")).toBe(true);
    expect(rows.map((row) => row.net)).not.toContain("GHOST");
  } finally {
    cleanup(dir);
  }
});

test("焊盘号映射到符号引脚号", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const rows = new Map(fixtureRows(projectPath).map((row) => [row.pad, row]));
    expect(rows.get("1")?.pinNumber).toBe("1");
    expect(rows.get("2")?.pinNumber).toBe("2");
  } finally {
    cleanup(dir);
  }
});

test("CSV 表头与行数", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const text = formatNetlistCsv(fixtureRows(projectPath));
    expect(text.startsWith("位号,焊盘号,引脚号,引脚名,网络")).toBe(true);
    expect(text.trimEnd().split("\n")).toHaveLength(3);
  } finally {
    cleanup(dir);
  }
});

// ─── 原理图 ────────────────────────────────────────────────────────

function fixtureIr(projectPath: string): SchematicIr {
  const docs = parseRecords(openProject(projectPath).epruText);
  const page = docs.find((item) => item.docType === "SCH_PAGE");
  expect(page).toBeTruthy();
  const ir = pageToIr(page!, symbolsOf(docs), devicesOf(docs), "TestProj");
  buildNets(ir);
  return ir;
}

test("R1 引脚坐标", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const ir = fixtureIr(projectPath);
    const r1 = ir.components.find((comp) => comp.designator === "R1");
    expect(r1).toBeTruthy();
    const coords = (r1?.pins ?? []).map((pin) => [pin.x, pin.y]).sort((a, b) => a[0]! - b[0]!);
    expect(coords).toEqual([
      [80, -200],
      [120, -200],
    ]);
  } finally {
    cleanup(dir);
  }
});

test("rotation=90 + isMirror 的引脚坐标", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const ir = fixtureIr(projectPath);
    const u3 = ir.components.find((comp) => comp.designator === "U3");
    expect(u3?.rotation).toBe(90);
    expect(u3?.mirror).toBe(true);
    const coords = (u3?.pins ?? [])
      .map((pin) => [pin.number, pin.x, pin.y])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(coords).toEqual([
      ["1", 410, -330],
      ["2", 410, -270],
      ["3", 380, -300],
    ]);
  } finally {
    cleanup(dir);
  }
});

test("rotation=180 的引脚坐标", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const ir = fixtureIr(projectPath);
    const u4 = ir.components.find((comp) => comp.designator === "U4");
    expect(u4?.rotation).toBe(180);
    expect(u4?.mirror).toBe(false);
    const coords = (u4?.pins ?? [])
      .map((pin) => [pin.number, pin.x, pin.y])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(coords).toEqual([
      ["1", 630, -410],
      ["2", 570, -410],
      ["3", 600, -380],
    ]);
  } finally {
    cleanup(dir);
  }
});

test("导线与网络标识生成网络", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const ir = fixtureIr(projectPath);
    const names = new Map(ir.nets.map((net) => [net.name, net]));
    expect(names.has("GND")).toBe(true);
    expect(names.has("VCC")).toBe(true);
    const gndPins = new Set(
      names.get("GND")?.pins.map((pin) => pinKey(pin.designator, pin.pinNumber)),
    );
    expect(gndPins.has(pinKey("R1", "1"))).toBe(true);
    const vccPins = new Set(
      names.get("VCC")?.pins.map((pin) => pinKey(pin.designator, pin.pinNumber)),
    );
    expect(vccPins.has(pinKey("R1", "2"))).toBe(true);
  } finally {
    cleanup(dir);
  }
});

// ─── 几何 ──────────────────────────────────────────────────────────

test("板框、走线、过孔与叠层", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const docs = parseRecords(openProject(projectPath).epruText);
    const geo = buildGeometry(docs);
    expect(geo.outline?.width_mm).toBeCloseTo(25.4, 2);
    expect(geo.outline?.height_mm).toBeCloseTo(12.7, 2);
    expect(geo.traces).toHaveLength(1);
    expect(geo.traces[0]?.length_mm).toBeCloseTo(25.4, 2);
    expect(geo.vias).toHaveLength(1);
    expect((geo.stackup[0]!.raw as { er?: number }).er).toBe(4.4);
  } finally {
    cleanup(dir);
  }
});

test("逐段走线保留端点", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const docs = parseRecords(openProject(projectPath).epruText);
    const geo = buildGeometry(docs);
    expect(geo.segment_count).toBe(1);
    const seg = geo.segments[0];
    expect([seg?.net, seg?.layer_id]).toEqual(["VCC", 1]);
    expect([seg?.x1, seg?.y1, seg?.x2, seg?.y2]).toEqual([0, 0, 1000, 0]);
    expect(seg?.width).toBe(10);
  } finally {
    cleanup(dir);
  }
});

test("焊盘绝对坐标、网络与层", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    const docs = parseRecords(openProject(projectPath).epruText);
    const geo = buildGeometry(docs);
    const pads = new Map(geo.pads.map((pad) => [`${pad.component}/${pad.pin}`, pad]));
    expect([...pads.keys()].sort()).toEqual(["R1/1", "R1/2"]);
    expect([pads.get("R1/1")?.x, pads.get("R1/1")?.y]).toEqual([-30, 0]);
    expect([pads.get("R1/2")?.x, pads.get("R1/2")?.y]).toEqual([30, 0]);
    expect(pads.get("R1/1")?.net).toBe("GND");
    expect(pads.get("R1/2")?.net).toBe("VCC");
    expect(pads.get("R1/1")?.layer_id).toBe(1);
  } finally {
    cleanup(dir);
  }
});

test("焊盘旋转 90 度", () => {
  const [x, y] = rotate(30, 0, 90);
  expect(x).toBeCloseTo(0, 9);
  expect(y).toBeCloseTo(30, 9);
});

// ─── 板框路径 ──────────────────────────────────────────────────────

test("R 形式末尾的 rotation / radius 不算点", () => {
  const points = polyPoints({ path: ["R", 2000, 0, 500, 500, 0, 0] });
  expect(points).toHaveLength(4);
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  expect([Math.min(...xs), Math.max(...xs)]).toEqual([2000, 2500]);
  expect([Math.min(...ys), Math.max(...ys)]).toEqual([0, 500]);
});

test("负宽高按包围盒算", () => {
  const points = polyPoints({ path: ["R", 1000, 500, -1000, -500, 0, 0] });
  const xs = points.map((point) => point[0]).sort((a, b) => a - b);
  const ys = points.map((point) => point[1]).sort((a, b) => a - b);
  expect([xs[0], xs.at(-1)]).toEqual([0, 1000]);
  expect([ys[0], ys.at(-1)]).toEqual([0, 500]);
});

// ─── 多 PCB / 损坏包 ───────────────────────────────────────────────

test("多 PCB 文档的几何跨文档累加", () => {
  const { dir, path: projectPath } = makeTmp({ twoPcb: true });
  try {
    const docs = parseRecords(openProject(projectPath).epruText);
    const geo = buildGeometry(docs);
    expect(geo.vias).toHaveLength(2);
    expect(new Set(Object.keys(geo.via_hole_histogram ?? {}))).toEqual(new Set(["11.811", "20.0"]));
    expect(geo.via_hole_histogram?.["11.811"]).toBe(1);
    expect(geo.via_hole_histogram?.["20.0"]).toBe(1);
    expect(geo.copper_layers_declared).toBe(2);
    expect(geo.copper_layers_used).toBe(2);
    const nets = new Map(geo.traces.map((trace) => [trace.net, trace]));
    expect([...nets.keys()].sort()).toEqual(["GND", "VCC"]);
    expect(nets.get("GND")?.length_mm).toBeCloseTo(12.7, 2);
    expect(geo.outlines).toHaveLength(2);
    expect(geo.outline?.boards).toBe(2);
    expect(geo.outlines[0]?.width_mm).toBeCloseTo(25.4, 2);
    expect(geo.outlines[1]?.width_mm).toBeCloseTo(12.7, 2);
    expect(geo.outline?.width_mm).toBeCloseTo(63.5, 2);
    expect(geo.outline?.height_mm).toBeCloseTo(12.7, 2);
    expect(geo.warnings.some((warning) => warning.includes("多板"))).toBe(true);
  } finally {
    cleanup(dir);
  }
});

test("中央目录可读但成员 CRC 损坏时抛 ProjectError", () => {
  const { dir, path: good } = makeTmp();
  try {
    const blob = fs.readFileSync(good);
    const index = blob.indexOf(Buffer.from("PK\x01\x02"));
    expect(index).toBeGreaterThan(0);
    blob[index + 16] = 0xde;
    blob[index + 17] = 0xad;
    blob[index + 18] = 0xbe;
    blob[index + 19] = 0xef;
    const bad = path.join(dir, "bad-body.epro2");
    fs.writeFileSync(bad, blob);
    expect(() => openProject(bad)).toThrow(ProjectError);
    try {
      openProject(bad);
    } catch (error) {
      expect(String(error)).toContain("ZIP");
    }
  } finally {
    cleanup(dir);
  }
});

// ─── 两版差异 ──────────────────────────────────────────────────────

test("网络重命名会被识别", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-epro2-test-"));
  try {
    const oldPath = path.join(dir, "old.epro2");
    const newPath = path.join(dir, "new.epro2");
    writeProject(oldPath, { netForPad2: "VCC" });
    writeProject(newPath, { netForPad2: "VCC2" });
    const result = compare(oldPath, newPath);
    expect(result.netlist.changed).toHaveLength(1);
    expect(result.netlist.changed[0]?.before).toBe("VCC");
    expect(result.netlist.changed[0]?.after).toBe("VCC2");
  } finally {
    cleanup(dir);
  }
});

test("max 字段变化不是噪声", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-epro2-test-"));
  try {
    const oldPath = path.join(dir, "old.epro2");
    const newPath = path.join(dir, "new.epro2");
    writeProject(oldPath, { padMax: 60 });
    writeProject(newPath, { padMax: 80 });
    const result = compare(oldPath, newPath);
    expect(result.elements.changed).toHaveLength(1);
    expect(result.elements.changed[0]!.type).toBe("PAD");
    expect((result.elements.changed[0]!.before as { max?: number }).max).toBe(60);
    expect((result.elements.changed[0]!.after as { max?: number }).max).toBe(80);
    expect(result.elements.noise_filtered).toBe(0);
  } finally {
    cleanup(dir);
  }
});

test("同一工程没有差异", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-epro2-test-"));
  try {
    const a = path.join(dir, "a.epro2");
    const b = path.join(dir, "b.epro2");
    writeProject(a);
    writeProject(b);
    const result = compare(a, b);
    expect(result.netlist.changed).toEqual([]);
    expect(result.elements.changed).toEqual([]);
  } finally {
    cleanup(dir);
  }
});

test("符号引脚号互换会在网表 diff 里被捕到", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-epro2-test-"));
  try {
    const oldPath = path.join(dir, "old.epro2");
    const newPath = path.join(dir, "new.epro2");
    writeProject(oldPath);
    writeProject(newPath, { swapPins: true });
    const result = compare(oldPath, newPath);
    const keys = new Set(
      result.netlist.changed.map((change) => `${change.designator}/${change.pad}`),
    );
    expect(keys).toEqual(new Set(["R1/1", "R1/2"]));
    const byPad = new Map(result.netlist.changed.map((change) => [change.pad, change]));
    expect(byPad.get("1")?.before).toBe("GND");
    expect(byPad.get("1")?.after).toBe("GND");
    expect(byPad.get("1")?.fields).toContain("pinName");
    expect(byPad.get("1")?.pin_before.name).toBe("1");
    expect(byPad.get("1")?.pin_after.name).toBe("2");
    expect(byPad.get("2")?.pin_before.name).toBe("2");
    expect(byPad.get("2")?.pin_after.name).toBe("1");
  } finally {
    cleanup(dir);
  }
});

// ─── 摆放归一 ──────────────────────────────────────────────────────

test("placementOf 归一 isMirror / mirror", () => {
  const p = placementOf({ x: 1, y: 2, rotation: 90, isMirror: true });
  expect([p.x, p.y, p.rotation]).toEqual([1, 2, 90]);
  expect(p.mirror).toBe(true);
  expect(placementOf({ mirror: true }).mirror).toBe(true);
  expect(placementOf({ x: 0, y: 0 }).mirror).toBe(false);
  expect(placementOf(null).mirror).toBe(false);
});

// ─── 连通性语义 ────────────────────────────────────────────────────

test("引脚落在导线内部必须连通", () => {
  const ir = makeIr(
    [
      {
        id: "c1",
        componentType: "part",
        designator: "R1",
        deviceUuid: null,
        deviceTitle: null,
        manufacturerPart: null,
        value: null,
        x: 0,
        y: 0,
        rotation: 0,
        mirror: false,
        attrs: {},
        pins: [{ number: "1", name: "1", x: 0, y: 0 }],
      },
      {
        id: "c2",
        componentType: "part",
        designator: "R2",
        deviceUuid: null,
        deviceTitle: null,
        manufacturerPart: null,
        value: null,
        x: 0,
        y: 0,
        rotation: 0,
        mirror: false,
        attrs: {},
        pins: [{ number: "1", name: "1", x: 300, y: 0 }],
      },
    ],
    [{ id: "w1", line: [0, 0, 400, 0], net: "MID" }],
  );
  const pinNet = buildNets(ir);
  expect(pinNet.get(pinKey("R1", "1"))).toBe("MID");
  expect(pinNet.get(pinKey("R2", "1"))).toBe("MID");
});

test("容差外的平行引线不误短接", () => {
  const ir = makeIr(
    [
      {
        id: "c1",
        componentType: "part",
        designator: "R1",
        deviceUuid: null,
        deviceTitle: null,
        manufacturerPart: null,
        value: null,
        x: 0,
        y: 0,
        rotation: 0,
        mirror: false,
        attrs: {},
        pins: [{ number: "1", name: "1", x: 100, y: 0.2 }],
      },
    ],
    [{ id: "w1", line: [0, 0, 400, 0], net: "MID" }],
  );
  const pinNet = buildNets(ir);
  expect(pinNet.get(pinKey("R1", "1"))?.startsWith("N$")).toBe(true);
});

// ─── 性能 ──────────────────────────────────────────────────────────

test("1000 引脚 × 2000 线段在 5 秒内完成", () => {
  const pinCount = 1000;
  const segCount = 2000;
  const components: SchematicIr["components"] = [];
  for (let i = 0; i < pinCount; i += 1) {
    components.push({
      id: `c${i}`,
      componentType: "part",
      designator: `U${i}`,
      deviceUuid: null,
      deviceTitle: null,
      manufacturerPart: null,
      value: null,
      x: 0,
      y: 0,
      rotation: 0,
      mirror: false,
      attrs: {},
      pins: [{ number: "1", name: "1", x: (i % 50) * 200, y: Math.floor(i / 50) * 200 }],
    });
  }
  const wires: SchematicIr["wires"] = [];
  for (let j = 0; j < segCount; j += 1) {
    const x1 = (j % 50) * 200;
    const y1 = Math.floor(j / 50) * 100;
    wires.push({ id: `w${j}`, line: [x1, y1, x1 + 150, y1], net: `N${j % 10}` });
  }
  const ir = makeIr(components, wires);
  const start = performance.now();
  buildNets(ir);
  const elapsed = (performance.now() - start) / 1000;
  expect(elapsed).toBeLessThan(5);
  expect(ir.nets.some((net) => net.pins.length > 1)).toBe(true);
});

// ─── 报告内部边界 ──────────────────────────────────────────────────

test("原点上的元件保留 0 坐标", () => {
  const text = `${[
    doc("PCB", "pb1", "PCB"),
    rec("COMPONENT", "c1", 1, { x: 0, y: 0, centerX: 999, centerY: 999, angle: 0, rotation: 90 }),
  ].join("\n")}\n`;
  const docs = parseRecords(text);
  const { byType } = docElements(docs[0]!);
  const meta = componentMeta(byType).get("c1");
  expect(meta?.x).toBe(0);
  expect(meta?.y).toBe(0);
  expect(meta?.angle).toBe(0);
});

test("重复引脚键排除比对并计数", () => {
  const rows: PcbRow[] = [
    {
      designator: "R1",
      component: "c1",
      pad: "1",
      pinNumber: "1",
      pinName: "1",
      net: "GND",
      ticket: 1,
    },
    {
      designator: "R1",
      component: "c1",
      pad: "2",
      pinNumber: "1",
      pinName: "1",
      net: "VCC",
      ticket: 1,
    },
  ];
  const artifacts = emptyArtifacts(rows, new Map([[pinKey("R1", "1"), "GND"]]));
  const { mismatches, stats } = checkConsistency(artifacts);
  expect(stats.duplicate_pin_keys).toBe(1);
  expect(stats.duplicate_pin_conflicts).toBe(1);
  expect(stats.compared).toBe(0);
  expect(mismatches).toEqual([]);
});

test("findFloating 标记截断", () => {
  const pages: SchematicIr[] = [
    {
      project: null,
      page: { uuid: "p1", name: "P1", docType: "SCH_PAGE" },
      components: [],
      wires: [],
      nets: Array.from({ length: 45 }, (_, index) => ({
        name: `N${index}`,
        named: true,
        conflicts: [],
        pins: [],
      })),
      warnings: [],
    },
  ];
  const first = findFloating(pages, 40);
  expect(first.floating).toHaveLength(40);
  expect(first.truncated).toBe(true);
  const second = findFloating(pages, 100);
  expect(second.floating).toHaveLength(45);
  expect(second.truncated).toBe(false);
});

// ─── 端到端 ────────────────────────────────────────────────────────

test("全量产物写出且报告一致", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-epro2-test-"));
  try {
    const projectPath = path.join(dir, "TestProj.epro2");
    writeProject(projectPath);
    const out = path.join(dir, "out");
    const run = runSingle(projectPath, out);
    for (const name of [
      "meta.json",
      "nets.json",
      "pcb_netlist.csv",
      "pcb_geometry.json",
      "report.md",
      "schematic_P1.json",
    ]) {
      expect(fs.existsSync(path.join(out, name)), name).toBe(true);
    }
    const report = fs.readFileSync(path.join(out, "report.md"), "utf8");
    expect(report).toContain("## 二、网表一致性");
    expect(report).toContain("不一致 0");
    expect(report).not.toContain("ERROR");
    const csv = fs.readFileSync(path.join(out, "pcb_netlist.csv"));
    expect(csv[0]).toBe(0xef);
    expect(csv[1]).toBe(0xbb);
    expect(csv[2]).toBe(0xbf);
    const summary = analyzeSummary(run) as { pcb: { netlistRows: number } };
    expect(summary.pcb.netlistRows).toBe(2);
  } finally {
    cleanup(dir);
  }
});

test("未知页抛 ProjectError", () => {
  const { dir, path: projectPath } = makeTmp();
  try {
    expect(() => collect(projectPath, "NotExist")).toThrow(ProjectError);
  } finally {
    cleanup(dir);
  }
});

test("同名页按 uuid 报告未解析", () => {
  const { dir, path: projectPath } = makeTmp({ duplicatePage: true });
  try {
    const out = path.join(dir, "out");
    const run = runSingle(projectPath, out, "pg1");
    expect(run.artifacts.meta.pages_analyzed).toEqual(["P1"]);
    const report = fs.readFileSync(path.join(out, "report.md"), "utf8");
    expect(report).toContain("未解析的页**：P1（pg2）");
    expect(report).toContain("有 1 个原理图页未被解析");
  } finally {
    cleanup(dir);
  }
});
