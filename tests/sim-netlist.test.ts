import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { buildPinNetTable, generateNetlist, parseVoltage } from "../src/sim/netlist.ts";
import type { NetlistOptions, NetlistResult } from "../src/sim/netlist.ts";
import type { SimIr, SimIrComponent, SimIrNet } from "../src/sim/types.ts";

type PinSpec = [number | string, string];
type CompSpec = [des: string, prefix: string, pins: PinSpec[], extra?: Record<string, string>];
type NetSpec = [name: string, members: [string, number | string][]];

function makeIr(components: CompSpec[], nets: NetSpec[], project = "test", page = "P1"): SimIr {
  const irComponents: SimIrComponent[] = components.map(([des, prefix, pins, extra]) => ({
    componentType: "part",
    designator: des,
    pinPrefix: prefix,
    deviceTitle: extra?.["title"] ?? "",
    manufacturerPart: extra?.["mpn"] ?? "",
    value: extra?.["value"] ?? "",
    pins: pins.map(([number, name]) => ({ number: String(number), name })),
  }));
  const irNets: SimIrNet[] = nets.map(([name, members]) => {
    const upper = name.toUpperCase();
    const origin =
      upper.startsWith("GND") ||
      upper.startsWith("AGND") ||
      upper.startsWith("DGND") ||
      name.startsWith("+") ||
      name.startsWith("-")
        ? "netflag"
        : "wire";
    return {
      name,
      origin,
      members: members.map(([component, pin]) => ({ component, pin: String(pin) })),
      pinCount: members.length,
    };
  });
  return {
    version: 1,
    source: "test",
    project,
    page: { name: page },
    components: irComponents,
    wires: [],
    lines: [],
    nets: irNets,
    warnings: [],
  };
}

function generate(ir: SimIr, options: NetlistOptions = {}): NetlistResult {
  return generateNetlist(ir, buildPinNetTable(ir), options);
}

function deckLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("*") && line !== ".end");
}

function element(text: string, name: string): string[] | null {
  for (const line of deckLines(text)) {
    const tokens = line.split(/\s+/);
    if ((tokens[0] ?? "").toUpperCase() === name.toUpperCase()) return tokens;
  }
  return null;
}

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-sim-netlist-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeJson(dir: string, name: string, value: unknown): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
  return file;
}

function emptyModelMap(dir: string): string {
  return writeJson(dir, "model_map.json", { version: 2, parts: {}, generics: [] });
}

const LIB = `* test lib
.SUBCKT REG VIN EN GND VOUT FB
R1 VIN VOUT 1
E1 VOUT GND VIN GND 0.5
R2 FB GND 1k
.ENDS REG
`;

function icIr(): SimIr {
  return makeIr(
    [
      [
        "U1",
        "U",
        [
          [1, "VIN"],
          [2, "EN"],
          [3, "GND"],
          [4, "VOUT"],
          [5, "FB"],
        ],
        {
          title: "LDO_X",
          mpn: "REGPART",
        },
      ],
      [
        "V1",
        "V",
        [
          [1, "1"],
          [2, "2"],
        ],
        { value: "5V" },
      ],
    ],
    [
      [
        "5V",
        [
          ["V1", 1],
          ["U1", 1],
        ],
      ],
      [
        "GND",
        [
          ["V1", 2],
          ["U1", 3],
        ],
      ],
      ["EN_NET", [["U1", 2]]],
      ["VOUT_NET", [["U1", 4]]],
      ["FB_NET", [["U1", 5]]],
    ],
  );
}

function writeLib(dir: string, rel = "ext/reg.lib", text = LIB, subckt = "REG"): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  const entry: Record<string, unknown> = {
    match: { mpn: ["REGPART"] },
    type: "subckt",
    file: rel,
    subckt,
  };
  return writeJson(dir, "model_map.json", { version: 2, parts: { REGPART: entry } });
}

// ---------------------------------------------------------------------------
// v2.1 兼容行为
// ---------------------------------------------------------------------------

test("RC 基本网表：值原样落 deck，地映射到 0", () => {
  const temp = tempDir();
  try {
    const ir = makeIr(
      [
        [
          "V1",
          "V",
          [
            [1, "1"],
            [2, "2"],
          ],
          { value: "12V" },
        ],
        [
          "R1",
          "R",
          [
            [1, "1"],
            [2, "2"],
          ],
          { value: "43kΩ" },
        ],
        [
          "C1",
          "C",
          [
            [1, "1"],
            [2, "2"],
          ],
          { value: "10uF" },
        ],
      ],
      [
        [
          "VIN",
          [
            ["V1", 1],
            ["R1", 1],
            ["C1", 1],
          ],
        ],
        [
          "GND",
          [
            ["V1", 2],
            ["R1", 2],
            ["C1", 2],
          ],
        ],
      ],
    );
    const { text, report } = generate(ir, { models: emptyModelMap(temp.dir) });
    expect(element(text, "V1")?.slice(1)).toEqual(["VIN", "0", "DC", "12V", "AC", "0", "0"]);
    expect(element(text, "R1")?.slice(1)).toEqual(["VIN", "0", "43kΩ"]);
    expect(element(text, "C1")?.slice(1)).toEqual(["VIN", "0", "10uF"]);
    expect(text.trimEnd().endsWith(".end")).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.counts?.["included"]).toBe(3);
  } finally {
    temp.cleanup();
  }
});

test("BJT 查不到型号时用泛化模型卡", () => {
  const temp = tempDir();
  try {
    const ir = makeIr(
      [
        [
          "Q1",
          "Q",
          [
            [1, "B"],
            [2, "E"],
            [3, "C"],
          ],
          { title: "NPN", mpn: "UNKNOWN" },
        ],
      ],
      [
        ["B_NET", [["Q1", 1]]],
        ["E_NET", [["Q1", 2]]],
        ["C_NET", [["Q1", 3]]],
      ],
    );
    const { text, report } = generate(ir, { models: emptyModelMap(temp.dir) });
    expect(element(text, "Q1")?.[4]).toBe("MODNPN_GENERIC");
    expect(report.generic[0]?.["designator"]).toBe("Q1");
  } finally {
    temp.cleanup();
  }
});

test("二极管按 MPN 命中离散模型库并带出 .MODEL 卡", () => {
  const temp = tempDir();
  try {
    const ir = makeIr(
      [
        [
          "D1",
          "D",
          [
            [1, "1"],
            [2, "2"],
          ],
          { mpn: "1N4148" },
        ],
      ],
      [
        ["A_NET", [["D1", 1]]],
        ["K_NET", [["D1", 2]]],
      ],
    );
    const { text } = generate(ir, { models: emptyModelMap(temp.dir) });
    expect(element(text, "D1")?.[3]).toBe("1N4148");
    expect(text).toContain(".MODEL D1N4148");
  } finally {
    temp.cleanup();
  }
});

test("keep-open 把排除器件写成注释行", () => {
  const temp = tempDir();
  try {
    const ir = makeIr(
      [
        [
          "J1",
          "J",
          [
            [1, "1"],
            [2, "2"],
          ],
          { title: "HEADER" },
        ],
      ],
      [
        ["A", [["J1", 1]]],
        ["B", [["J1", 2]]],
      ],
    );
    const { text, report } = generate(ir, { models: emptyModelMap(temp.dir), keepOpen: true });
    expect(text.split(/\r?\n/).some((line) => line.includes("* [skipped] J1"))).toBe(true);
    expect(report.excluded).toHaveLength(1);
  } finally {
    temp.cleanup();
  }
});

test("strict 下未映射 IC 报 UNMAPPED_IC，非 strict 只排除", () => {
  const temp = tempDir();
  try {
    const ir = makeIr(
      [
        [
          "U1",
          "U",
          [
            [1, "A"],
            [2, "B"],
          ],
          { title: "MYSTERY_IC" },
        ],
      ],
      [
        ["A", [["U1", 1]]],
        ["B", [["U1", 2]]],
      ],
    );
    const strict = generate(ir, { models: emptyModelMap(temp.dir), strict: true });
    expect(strict.report.errors.some((error) => error.code === "UNMAPPED_IC")).toBe(true);
    expect(deckLines(strict.text).some((line) => line.startsWith("U1"))).toBe(false);

    const loose = generate(ir, { models: emptyModelMap(temp.dir) });
    expect(loose.report.errors).toEqual([]);
    expect(loose.report.excluded[0]?.["level"]).toBe("EXCLUDED");
    expect(String(loose.report.excluded[0]?.["reason"])).toContain("无仿真模型");
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 电源策略
// ---------------------------------------------------------------------------

test("auto 策略按网名补理想源并给出 POWER-AUTO 告警", () => {
  const temp = tempDir();
  try {
    const ir = makeIr(
      [
        [
          "R1",
          "R",
          [
            [1, "1"],
            [2, "2"],
          ],
          { value: "1k" },
        ],
      ],
      [
        ["+12V", [["R1", 1]]],
        ["GND", [["R1", 2]]],
      ],
    );
    const { text, report } = generate(ir, { models: emptyModelMap(temp.dir) });
    expect(element(text, "VPWR_12V")?.slice(2)).toEqual(["0", "12", "DC", "AC", "0", "0"]);
    expect(report.warnings.some((warning) => warning.includes("POWER-AUTO"))).toBe(true);
  } finally {
    temp.cleanup();
  }
});

test("explicit 策略不猜电源，只报孤立电源轨", () => {
  const temp = tempDir();
  try {
    const ir = makeIr(
      [
        [
          "R1",
          "R",
          [
            [1, "1"],
            [2, "2"],
          ],
          { value: "1k" },
        ],
      ],
      [
        ["+12V", [["R1", 1]]],
        ["GND", [["R1", 2]]],
      ],
    );
    const { text, report } = generate(ir, {
      models: emptyModelMap(temp.dir),
      powerPolicy: "explicit",
    });
    expect(deckLines(text).some((line) => line.startsWith("VPWR"))).toBe(false);
    expect(report.warnings.some((warning) => warning.includes("explicit"))).toBe(true);
  } finally {
    temp.cleanup();
  }
});

test("external_supplies 声明的外部供电按 config 出来源", () => {
  const temp = tempDir();
  try {
    const ir = makeIr(
      [
        [
          "R1",
          "R",
          [
            [1, "1"],
            [2, "2"],
          ],
          { value: "1k" },
        ],
      ],
      [
        ["+12V", [["R1", 1]]],
        ["GND", [["R1", 2]]],
      ],
    );
    const { text, report } = generate(ir, {
      models: emptyModelMap(temp.dir),
      powerPolicy: "explicit",
      config: { external_supplies: [{ net: "+12V", voltage: 12 }] },
    });
    expect(deckLines(text).some((line) => line.startsWith("V_EXT"))).toBe(true);
    expect(report.powers.some((power) => power["source"] === "config")).toBe(true);
  } finally {
    temp.cleanup();
  }
});

test("parseVoltage 从网名读出电压（3V3 → 3.3）", () => {
  expect(parseVoltage("+12V")).toBe(12);
  expect(parseVoltage("-15V")).toBe(-15);
  expect(parseVoltage("3V3")).toBeCloseTo(3.3, 9);
  expect(parseVoltage("5V")).toBe(5);
  expect(parseVoltage("VCC")).toBeNull();
  expect(parseVoltage("0V")).toBeNull();
  expect(parseVoltage(null)).toBeNull();
});

// ---------------------------------------------------------------------------
// 地策略
// ---------------------------------------------------------------------------

test("AGND 不静默合并，显式 ground_aliases 才合并", () => {
  const temp = tempDir();
  try {
    const ir = makeIr(
      [
        [
          "V1",
          "V",
          [
            [1, "1"],
            [2, "2"],
          ],
          { value: "5V" },
        ],
        [
          "C1",
          "C",
          [
            [1, "1"],
            [2, "2"],
          ],
          { value: "100n" },
        ],
      ],
      [
        ["AGND", [["C1", 2]]],
        ["GND", [["V1", 2]]],
        [
          "5V",
          [
            ["V1", 1],
            ["C1", 1],
          ],
        ],
      ],
    );
    const first = generate(ir, { models: emptyModelMap(temp.dir) });
    expect(first.report.ground_mapping["AGND"]).toBe("AGND");
    expect(first.report.ground_mapping["GND"]).toBe("0");
    expect(element(first.text, "C1")?.[2]).toBe("AGND");
    expect(first.report.warnings.some((warning) => warning.includes("未合并到节点 0"))).toBe(true);

    const merged = generate(ir, {
      models: emptyModelMap(temp.dir),
      config: { ground_aliases: { "0": ["GND", "AGND"] } },
    });
    expect(merged.report.ground_mapping["AGND"]).toBe("0");
    const tokens = element(merged.text, "C1");
    expect(tokens?.[1]).toBe("N_5V");
    expect(tokens?.[2]).toBe("0");
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 外部模型映射
// ---------------------------------------------------------------------------

test("子电路实例名 X 开头，节点按 subckt_order 顺序", () => {
  const temp = tempDir();
  try {
    writeLib(temp.dir);
    const mapPath = writeJson(temp.dir, "model_map.json", {
      version: 2,
      parts: {
        REGPART: {
          match: { mpn: ["REGPART"] },
          type: "subckt",
          file: "ext/reg.lib",
          subckt: "REG",
          pins: { "1": "VIN", "2": "EN", "3": "GND", "4": "VOUT", "5": "FB" },
          subckt_order: ["VIN", "EN", "GND", "VOUT", "FB"],
          roles: { VOUT: "power_output" },
        },
      },
    });
    const { text, report } = generate(icIr(), { models: mapPath });
    const tokens = element(text, "XU1");
    expect(tokens).toBeTruthy();
    expect(tokens?.slice(1, 6)).toEqual(["N_5V", "EN_NET", "0", "VOUT_NET", "FB_NET"]);
    expect(tokens?.[6]).toBe("REG");
    const model = report.models[0]!;
    expect(model["status"]).toBe("VERIFIED");
    expect(model["pin_mapping"]).toEqual({
      "1": "VIN",
      "2": "EN",
      "3": "GND",
      "4": "VOUT",
      "5": "FB",
    });
    expect(text.split(".include").length - 1).toBe(1);
    expect(report.includes[0]).toContain("reg.lib");
    expect(model["fallback"]).toBe("no");
  } finally {
    temp.cleanup();
  }
});

test("pin mapping 不完整报 MODEL_MAPPING_ERROR，允许 partial 时用 __NC_ 占位", () => {
  const temp = tempDir();
  try {
    writeLib(temp.dir);
    const mapPath = writeJson(temp.dir, "model_map.json", {
      version: 2,
      parts: {
        REGPART: {
          match: { mpn: ["REGPART"] },
          type: "subckt",
          file: "ext/reg.lib",
          subckt: "REG",
          pins: { "1": "VIN", "2": "EN", "3": "GND", "4": "VOUT" },
        },
      },
    });
    const strict = generate(icIr(), { models: mapPath });
    expect(strict.report.errors.some((error) => error.code === "MODEL_MAPPING_ERROR")).toBe(true);
    expect(element(strict.text, "XU1")).toBeNull();

    const partial = generate(icIr(), { models: mapPath, allowPartialModel: true });
    const tokens = element(partial.text, "XU1");
    expect(tokens).toHaveLength(7);
    expect(tokens?.some((token) => token.includes("__NC_"))).toBe(true);
  } finally {
    temp.cleanup();
  }
});

test("缺 pins 时按引脚名自动映射，名字对不上就报错", () => {
  const temp = tempDir();
  try {
    writeLib(temp.dir);
    const mapPath = writeJson(temp.dir, "model_map.json", {
      version: 2,
      parts: {
        REGPART: {
          match: { mpn: ["REGPART"] },
          type: "subckt",
          file: "ext/reg.lib",
          subckt: "REG",
        },
      },
    });
    const auto = generate(icIr(), { models: mapPath });
    expect(element(auto.text, "XU1")).toBeTruthy();
    expect(auto.report.models[0]?.["pin_mapping_auto"]).toBe(true);
    expect(auto.report.models[0]?.["status"]).toBe("VERIFIED");

    const ir = makeIr(
      [
        [
          "U2",
          "U",
          [
            [1, "AA"],
            [2, "BB"],
          ],
          { mpn: "REGPART" },
        ],
      ],
      [
        ["NA", [["U2", 1]]],
        ["NB", [["U2", 2]]],
      ],
    );
    const failed = generate(ir, { models: mapPath });
    expect(failed.report.errors.some((error) => error.code === "MODEL_MAPPING_ERROR")).toBe(true);
  } finally {
    temp.cleanup();
  }
});

test("pins 指向不存在的 subckt 引脚、缺 lib、缺 subckt 都报错", () => {
  const temp = tempDir();
  try {
    writeLib(temp.dir);
    const unknownPin = writeJson(temp.dir, "model_map.json", {
      version: 2,
      parts: {
        REGPART: {
          match: { mpn: ["REGPART"] },
          type: "subckt",
          file: "ext/reg.lib",
          subckt: "REG",
          pins: { "1": "VIN", "2": "EN", "3": "GND", "4": "VOUT", "5": "NOPE" },
        },
      },
    });
    expect(
      generate(icIr(), { models: unknownPin }).report.errors.some((error) =>
        String(error.message).includes("不存在的引脚"),
      ),
    ).toBe(true);

    const missingFile = writeJson(temp.dir, "model_map.json", {
      version: 2,
      parts: {
        REGPART: {
          match: { mpn: ["REGPART"] },
          type: "subckt",
          file: "ext/does_not_exist.lib",
          subckt: "REG",
          pins: { "1": "VIN", "2": "EN", "3": "GND", "4": "VOUT", "5": "FB" },
        },
      },
    });
    expect(
      generate(icIr(), { models: missingFile }).report.errors.some(
        (error) => error.code === "MODEL_FILE_MISSING",
      ),
    ).toBe(true);

    const missingSubckt = writeJson(temp.dir, "model_map.json", {
      version: 2,
      parts: {
        REGPART: {
          match: { mpn: ["REGPART"] },
          type: "subckt",
          file: "ext/reg.lib",
          subckt: "NOT_THERE",
          pins: { "1": "VIN", "2": "EN", "3": "GND", "4": "VOUT", "5": "FB" },
        },
      },
    });
    expect(
      generate(icIr(), { models: missingSubckt }).report.errors.some((error) =>
        String(error.message).includes("找不到 .SUBCKT"),
      ),
    ).toBe(true);
  } finally {
    temp.cleanup();
  }
});

test("designator 优先级高于 MPN", () => {
  const temp = tempDir();
  try {
    const file = path.join(temp.dir, "a.lib");
    fs.writeFileSync(
      file,
      ".SUBCKT AAA A B\nR1 A B 1\n.ENDS\n.SUBCKT BBB A B\nR1 A B 2\n.ENDS\n",
      "utf8",
    );
    const mapPath = writeJson(temp.dir, "model_map.json", {
      version: 2,
      parts: {
        BY_MPN: {
          match: { mpn: ["SAMEPART"] },
          type: "subckt",
          file: "a.lib",
          subckt: "AAA",
          pins: { "1": "A", "2": "B" },
        },
        BY_DES: {
          match: { designator: ["U7"] },
          type: "subckt",
          file: "a.lib",
          subckt: "BBB",
          pins: { "1": "A", "2": "B" },
        },
      },
    });
    const ir = makeIr(
      [
        [
          "U7",
          "U",
          [
            [1, "A"],
            [2, "B"],
          ],
          { mpn: "SAMEPART" },
        ],
      ],
      [
        ["NA", [["U7", 1]]],
        ["NB", [["U7", 2]]],
      ],
    );
    const { text, report } = generate(ir, { models: mapPath });
    expect(element(text, "XU7")?.at(-1)).toBe("BBB");
    expect(report.models[0]?.["matched_by"]).toBe("designator");
  } finally {
    temp.cleanup();
  }
});

test("include 路径含空格时加引号，.lib section 用 .lib 行", () => {
  const temp = tempDir();
  try {
    const libDir = path.join(temp.dir, "dir with space");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, "my lib.lib"), LIB, "utf8");
    const spaced = writeJson(temp.dir, "model_map.json", {
      version: 2,
      parts: {
        REGPART: {
          match: { mpn: ["REGPART"] },
          type: "subckt",
          file: "dir with space/my lib.lib",
          subckt: "REG",
          pins: { "1": "VIN", "2": "EN", "3": "GND", "4": "VOUT", "5": "FB" },
        },
      },
    });
    const { text } = generate(icIr(), { models: spaced });
    const include = deckLines(text).find((line) => line.startsWith(".include"));
    expect(include).toBeTruthy();
    expect(include).toContain('dir with space/my lib.lib"');
    expect(include?.split('"').length).toBe(3);

    const sectDir = path.join(temp.dir, "sect");
    fs.mkdirSync(sectDir, { recursive: true });
    fs.writeFileSync(path.join(sectDir, "tt.lib"), ".LIB TT\n" + LIB + ".ENDL TT\n", "utf8");
    const section = writeJson(temp.dir, "model_map.json", {
      version: 2,
      parts: {
        REGPART: {
          match: { mpn: ["REGPART"] },
          type: "subckt",
          file: "sect/tt.lib",
          lib_section: "TT",
          subckt: "REG",
          pins: { "1": "VIN", "2": "EN", "3": "GND", "4": "VOUT", "5": "FB" },
        },
      },
    });
    const sectioned = generate(icIr(), { models: section });
    const libLine = deckLines(sectioned.text).find((line) => line.startsWith(".lib "));
    expect(libLine?.trimEnd().endsWith(" TT")).toBe(true);
    expect(deckLines(sectioned.text).some((line) => line.startsWith(".include"))).toBe(false);
  } finally {
    temp.cleanup();
  }
});

test("power_output 引脚驱动的电源轨不再自动补源", () => {
  const temp = tempDir();
  try {
    writeLib(temp.dir);
    const mapPath = writeJson(temp.dir, "model_map.json", {
      version: 2,
      parts: {
        REGPART: {
          match: { mpn: ["REGPART"] },
          type: "subckt",
          file: "ext/reg.lib",
          subckt: "REG",
          pins: { "1": "VIN", "2": "EN", "3": "GND", "4": "VOUT", "5": "FB" },
          roles: { VOUT: "power_output" },
        },
      },
    });
    const ir = makeIr(
      [
        [
          "U1",
          "U",
          [
            [1, "VIN"],
            [2, "EN"],
            [3, "GND"],
            [4, "VOUT"],
            [5, "FB"],
          ],
          {
            mpn: "REGPART",
          },
        ],
      ],
      [
        ["+5V", [["U1", 4]]],
        ["GND", [["U1", 3]]],
        ["VIN_NET", [["U1", 1]]],
        ["EN_NET", [["U1", 2]]],
        ["FB_NET", [["U1", 5]]],
      ],
    );
    const { text, report } = generate(ir, { models: mapPath, powerPolicy: "auto" });
    expect(deckLines(text).some((line) => line.startsWith("VPWR"))).toBe(false);
    expect(report.warnings.some((warning) => warning.includes("power_output 驱动"))).toBe(true);
  } finally {
    temp.cleanup();
  }
});

test("0Ω 电阻按 1mΩ 落地并告警", () => {
  const temp = tempDir();
  try {
    const ir = makeIr(
      [
        [
          "R1",
          "R",
          [
            [1, "1"],
            [2, "2"],
          ],
          { value: "0" },
        ],
        [
          "R2",
          "R",
          [
            [1, "1"],
            [2, "2"],
          ],
          { value: "{R_VAL}" },
        ],
      ],
      [
        [
          "A",
          [
            ["R1", 1],
            ["R2", 1],
          ],
        ],
        [
          "GND",
          [
            ["R1", 2],
            ["R2", 2],
          ],
        ],
      ],
    );
    const { text, report } = generate(ir, { models: emptyModelMap(temp.dir) });
    expect(element(text, "R1")?.at(-1)).toBe("1m");
    expect(element(text, "R2")?.at(-1)).toBe("{R_VAL}");
    expect(report.warnings.some((warning) => warning.includes("0Ω 电阻按 1mΩ"))).toBe(true);
  } finally {
    temp.cleanup();
  }
});

test("MOSFET 引脚名不全时按惯序 1=G 2=S 3=D 并告警", () => {
  const temp = tempDir();
  try {
    const ir = makeIr(
      [
        [
          "M1",
          "M",
          [
            [1, "1"],
            [2, "2"],
            [3, "3"],
          ],
          { title: "NMOS" },
        ],
      ],
      [
        ["G_NET", [["M1", 1]]],
        ["S_NET", [["M1", 2]]],
        ["D_NET", [["M1", 3]]],
      ],
    );
    const { text, report } = generate(ir, { models: emptyModelMap(temp.dir) });
    const tokens = element(text, "M1");
    expect(tokens?.slice(1, 6)).toEqual(["D_NET", "G_NET", "S_NET", "0", "MODNMOS_GENERIC"]);
    expect(report.warnings.some((warning) => warning.includes("惯序"))).toBe(true);
  } finally {
    temp.cleanup();
  }
});
