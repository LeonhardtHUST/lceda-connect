import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vite-plus/test";

import { loadConfig } from "../src/core/config.ts";
import { createMemoryIo } from "../src/core/io.ts";
import { runEprj3Command } from "../src/eprj3/cli.ts";
import { eprj3Tools } from "../src/eprj3/mcpTools.ts";
import { pcbNetlist, sheetNetlist } from "../src/eprj3/netlist.ts";
import { inspectEprj3Project, loadEprj3Project } from "../src/eprj3/project.ts";
import {
  formatRecord,
  isDocHeadLine,
  normalizeRecordId,
  parseRecord,
  reduceRecords,
  splitDocumentLines,
  type Eprj3Record,
} from "../src/eprj3/records.ts";
import { listEprj3Scripts, runEprj3Script } from "../src/eprj3/sidecar.ts";
import { validateEprj3Project } from "../src/eprj3/validate.ts";

// 记录层与格式门的回归样本：blink 来自 easyeda-eprj3-skill 仓库（MIT），
// 覆盖原理图（符号 / 器件 / 页）、PCB（器件 / 板框 / PAD_NET）与墓碑删除。
// esp32-s31 只在源仓库存在时才跑（10 MB 的真实工程，不在本仓库留副本）。

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "eprj3", "blink");
const SOURCE_EXAMPLES = "D:\\Projects\\GitHub\\easyeda-eprj3-skill\\examples";
const ESP32 = path.join(SOURCE_EXAMPLES, "esp32-s31");
const EPRJ3_EXAMPLE = path.join(SOURCE_EXAMPLES, "eprj3-example");
const ENV = process.env;
const CTX = { cfg: loadConfig({ ...process.env, USERPROFILE: "C:\\Users\\tester" }, {}), env: ENV };

function line(type: string, id: string | null, ticket: number | null, body: unknown): string {
  const head: Record<string, unknown> = { type };
  if (id !== null) head.id = id;
  if (ticket !== null) head.ticket = ticket;
  const payload = body === null ? "" : JSON.stringify(body);
  return `${JSON.stringify(head)}||${payload}|`;
}

function record(
  type: string,
  id: string | null,
  ticket: number | null,
  body: unknown,
): Eprj3Record {
  const parsed = parseRecord(line(type, id, ticket, body));
  if (parsed === null) throw new Error("测试构造的记录不合法");
  return parsed;
}

function docHead(docType: string, uuid: string, client = "0123456789abcdef"): string {
  return `${JSON.stringify({ type: "DOCHEAD", ticket: 1 })}||${JSON.stringify({
    docType,
    client,
    uuid,
    updateTime: 1700000000000,
    version: "1",
    editVersion: "2.3.0",
    user: {},
  })}|`;
}

function writeLines(file: string, lines: readonly string[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

const IDS = {
  owner: "0123456789abcdef0123456789abcdef",
  board: "1111111111111111",
  schematic: "2222222222222222",
  sheet: "3333333333333333",
  pcb: "4444444444444444",
  symbol: "5555555555555555",
  device: "6666666666666666",
  devicePcb: "7777777777777777",
};

interface ProjectOptions {
  /** 往 PCB 主文档塞一条指向不存在元件的存活 PAD_NET。 */
  liveBadPadNet?: boolean;
  /** 往页文档塞一条会报错的 Symbol 属性，再用墓碑把它删除。 */
  tombstonedBadRef?: boolean;
  /** 给页文档追加一条空体 META（非法）。 */
  emptyMeta?: boolean;
}

/** 在 os.tmpdir() 里造一个最小可校验工程（不碰仓库内夹具）。 */
function makeMinimalProject(options: ProjectOptions = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "eprj3-test-"));
  const name = "demo";
  const index = {
    name,
    owner_uuid: IDS.owner,
    creator_uuid: IDS.owner,
    modifier_uuid: IDS.owner,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    format: "folder",
    profile: {
      boards: { [IDS.board]: { uuid: IDS.board, title: "Board1", zIndex: 1 } },
      schematics: {
        [IDS.schematic]: { uuid: IDS.schematic, name: "S1", board: IDS.board },
      },
      sheets: {
        [IDS.sheet]: {
          uuid: IDS.sheet,
          title: "P1",
          schematic_uuid: IDS.schematic,
          zIndex: 1,
        },
      },
      pcbs: {
        [IDS.pcb]: { uuid: IDS.pcb, title: "PCB1", board: IDS.board },
      },
      panels: {},
      owner: { uuid: IDS.owner },
      blockSymbols: {},
      simSchematics: {},
      simulations: {},
    },
  };
  writeFileSync(path.join(root, `${name}.eprj3`), JSON.stringify(index, null, 2), "utf8");

  writeLines(path.join(root, "sch", "S1", "S1.ecfg"), [
    docHead("SCH", IDS.schematic),
    line("META", "META", 1, { title: "S1", schematic: IDS.schematic, zIndex: 1 }),
  ]);
  writeFileSync(path.join(root, "sch", "S1", "S1.evar"), "", "utf8");

  const sheetLines = [
    docHead("SYMBOL", IDS.symbol),
    line("META", "META", 1, { docType: 2, title: "R", uuid: IDS.symbol }),
    line("PIN", "e1", 2, { partId: "p1", x: 0, y: 0, length: 10, rotation: 0 }),
    line("ATTR", "a1", 3, { parentId: "e1", key: "Pin Number", value: "1" }),
    docHead("DEVICE", IDS.device),
    line("META", "META", 1, { docType: 10, title: "R", uuid: IDS.device }),
    docHead("SCH_PAGE", IDS.sheet),
    line("META", "META", 1, { title: "P1", schematic: IDS.schematic, zIndex: 1 }),
    line("COMPONENT", "c1", 10, {
      partId: "p1",
      x: 100,
      y: 100,
      rotation: 0,
      isMirror: false,
      attrs: {
        DeviceName: JSON.stringify({ uuid: IDS.device, name: "R", source: "" }),
      },
      zIndex: 1,
    }),
    line("ATTR", "a2", 11, { parentId: "c1", key: "Symbol", value: IDS.symbol }),
    line("ATTR", "a3", 12, { parentId: "c1", key: "NO_CONNECT", value: "yes" }),
    // 引脚元素 id（真机有 16-hex 随机原子）不该被当成悬空 parentId。
    line("ATTR", "a4", 13, { parentId: "c1-e1", key: "NO_CONNECT", value: "no" }),
    line("WIRE", "w1", 14, { zIndex: 1 }),
    line("LINE", "l1", 15, {
      lineGroup: "missing-wire",
      startX: 0,
      startY: 0,
      endX: 10,
      endY: 0,
    }),
  ];
  if (options.tombstonedBadRef === true) {
    sheetLines.push(
      line("ATTR", "a9", 20, { parentId: "c1", key: "Symbol", value: "deadbeefdeadbeef" }),
      line("ATTR", "a9", 99, null),
    );
  }
  if (options.emptyMeta === true) {
    sheetLines.push(line("META", "META", 99, null));
  }
  writeLines(path.join(root, "sch", "S1", "P1.esch2"), sheetLines);

  const pcbLines = [
    docHead("DEVICE", IDS.devicePcb),
    line("META", "META", 1, { docType: 10, title: "R", uuid: IDS.devicePcb }),
    docHead("PCB", IDS.pcb),
    line("META", "META", 1, { title: "PCB1", pcb: IDS.pcb, zIndex: 1 }),
    line("LAYER", "l1", 2, { layerId: 11, layerType: "OUTLINE", layerName: "Board Outline" }),
    line("LAYER", "l2", 3, { layerId: 1, layerType: "TOP", layerName: "Top Layer" }),
    line("NET", '["NET",""]', 4, {}),
    // 真机板框可以是一串画在 OUTLINE 图层上的 POLY，而不是单个 BOARD_OUTLINE。
    line("POLY", "p1", 5, {
      layerId: 11,
      polyType: "NORMAL",
      path: [0, 0, "L", 100, 0, 100, 100, 0, 100],
    }),
    line("COMPONENT", "c2", 6, {
      x: 10,
      y: 10,
      angle: 0,
      attrs: { DeviceName: JSON.stringify({ uuid: IDS.devicePcb, name: "R" }) },
    }),
    // 墓碑 PAD_NET 指向已删除的元件：归约后不该报错。
    line("PAD_NET", '["PAD_NET","deadbeef","1","e1"]', 7, null),
  ];
  if (options.liveBadPadNet === true) {
    pcbLines.push(
      line("PAD_NET", '["PAD_NET","deadbeef","1","e1"]', 8, {
        padNet: "NO_SUCH_NET",
      }),
    );
  }
  writeLines(path.join(root, "pcb", "PCB1.epcb2"), pcbLines);
  return root;
}

// ---------------------------------------------------------------- 记录解析

test("parseRecord 只切第一个 ||，载荷 JSON 里的 || 原样保留", () => {
  const parsed = parseRecord('{"type":"TEXT","ticket":3,"id":"x"}||{"value":"a||b"}|');
  expect(parsed).not.toBeNull();
  expect(parsed?.type).toBe("TEXT");
  expect(parsed?.ticket).toBe(3);
  expect(parsed?.body).toEqual({ value: "a||b" });
  expect(parsed?.tombstone).toBe(false);
});

test("parseRecord 支持末行没有终止符 |，空体是墓碑", () => {
  const noPipe = parseRecord('{"type":"LINE","ticket":2,"id":"l1"}||{"startX":0,"endX":10}');
  expect(noPipe?.body).toEqual({ startX: 0, endX: 10 });
  const tombstone = parseRecord('{"type":"LINE","ticket":3,"id":"l1"}|||');
  expect(tombstone?.tombstone).toBe(true);
  expect(tombstone?.body).toEqual({});
});

test("parseRecord 拒绝没有 ||、外层坏 JSON、没有 type 的行", () => {
  expect(parseRecord('{"type":"A","id":"x"}')).toBeNull();
  expect(parseRecord("not-json||{}|")).toBeNull();
  expect(parseRecord('{"id":"x"}||{}|')).toBeNull();
});

test("DOCHEAD 带 ticket 与不带 ticket 都识别，且没有 id", () => {
  const bare = '{"type":"DOCHEAD"}||{"docType":"SYMBOL","uuid":"abc","client":"c1"}|';
  const ticketed =
    '{"type":"DOCHEAD","ticket":7}||{"docType":"SCH_PAGE","uuid":"u1","client":"c2"}|';
  expect(isDocHeadLine(bare)).toBe(true);
  expect(isDocHeadLine(ticketed)).toBe(true);
  expect(isDocHeadLine('{"type":"TEXT"}||{}|')).toBe(false);
  expect(parseRecord(bare)?.id).toBeNull();
  expect(parseRecord(bare)?.ticket).toBeNull();
  expect(parseRecord(ticketed)?.ticket).toBe(7);
});

test("splitDocumentLines 按 DOCHEAD 分段并统计孤儿行与坏行", () => {
  const split = splitDocumentLines([
    '{"type":"TEXT","ticket":1,"id":"orphan"}||{}|',
    '{"type":"DOCHEAD"}||{"docType":"SYMBOL","uuid":"s1","client":"c"}|',
    '{"type":"META","ticket":1,"id":"META"}||{"docType":2}|',
    "这不是 JSON",
    '{"type":"DOCHEAD"}||{"docType":"SCH_PAGE","uuid":"p1","client":"c"}|',
    '{"type":"WIRE","ticket":2,"id":"e1"}||{}|',
  ]);
  expect(split.orphans).toBe(1);
  expect(split.sections).toHaveLength(2);
  expect(split.sections[0]?.docType).toBe("SYMBOL");
  expect(split.sections[0]?.uuid).toBe("s1");
  expect(split.sections[0]?.unparsed).toBe(1);
  expect(split.sections[1]?.records.map((item) => item.type)).toEqual(["WIRE"]);
});

test("normalizeRecordId 归一化 JSON 数组 id，普通 id 原样保留", () => {
  expect(normalizeRecordId('["NET",""]')).toBe('["NET",""]');
  expect(normalizeRecordId('[ "PAD_NET" , "c1" ]')).toBe('["PAD_NET","c1"]');
  expect(normalizeRecordId("e1")).toBe("e1");
  expect(normalizeRecordId(null)).toBe("");
});

test("formatRecord 空体输出 |||，非空体可以 round-trip", () => {
  expect(formatRecord({ type: "ATTR", ticket: 1, id: "x" }, null)).toBe(
    '{"type":"ATTR","ticket":1,"id":"x"}|||',
  );
  const formatted = formatRecord({ type: "TEXT", ticket: 2, id: "x" }, { value: "a||b" });
  expect(formatted).toBe('{"type":"TEXT","ticket":2,"id":"x"}||{"value":"a||b"}|');
  expect(parseRecord(formatted)?.body).toEqual({ value: "a||b" });
});

// ------------------------------------------------------------------ 归约

test("reduceRecords 取 ticket 最大的记录", () => {
  const reduced = reduceRecords([
    {
      uuid: "u1",
      client: "aaa",
      records: [
        record("TEXT", "e1", 3, { value: "old" }),
        record("TEXT", "e1", 5, { value: "new" }),
        record("TEXT", "e2", 4, { value: "keep" }),
      ],
    },
  ]);
  expect(reduced).toHaveLength(1);
  expect(reduced[0]?.records.map((item) => item.body.value)).toEqual(["new", "keep"]);
  expect(reduced[0]?.dropped).toBe(1);
});

test("reduceRecords 平票比 DOCHEAD client，字典序大者胜", () => {
  const reduced = reduceRecords([
    { uuid: "u1", client: "aaa", records: [record("TEXT", "e1", 5, { which: "small" })] },
    { uuid: "u1", client: "zzz", records: [record("TEXT", "e1", 5, { which: "big" })] },
  ]);
  expect(reduced[0]?.records[0]?.body.which).toBe("big");
});

test("reduceRecords 空体是墓碑；META 空体保留上一条并标记 metaEmpty", () => {
  const reduced = reduceRecords([
    {
      uuid: "u1",
      client: "aaa",
      records: [
        record("TEXT", "e1", 3, { value: "alive" }),
        record("TEXT", "e1", 6, null),
        record("META", "META", 1, { title: "keep" }),
        record("META", "META", 9, null),
      ],
    },
  ]);
  expect(reduced[0]?.records.map((item) => item.type)).toEqual(["META"]);
  expect(reduced[0]?.records[0]?.body).toEqual({ title: "keep" });
  expect(reduced[0]?.tombstones.map((item) => item.id)).toEqual(["e1"]);
  expect(reduced[0]?.metaEmpty).toBe(true);
});

test("空 NET 占位记录即使是空体也不算墓碑", () => {
  const reduced = reduceRecords([
    {
      uuid: "u1",
      client: "aaa",
      records: [record("NET", '["NET",""]', 4, null)],
    },
  ]);
  expect(reduced[0]?.records).toHaveLength(1);
  expect(reduced[0]?.tombstones).toHaveLength(0);
});

// ------------------------------------------------------------------ 工程

test("inspectEprj3Project：profile、文档清单、类型计数与墓碑数", () => {
  const info = inspectEprj3Project(FIXTURE);
  expect(info.name).toBe("blink");
  expect(info.profile).toMatchObject({ boards: 1, schematics: 1, sheets: 1, pcbs: 1, panels: 0 });
  expect(info.files.map((file) => file.role)).toEqual(["ecfg", "evar", "sheet", "pcb"]);
  expect(info.totals.docs).toBe(35);
  expect(info.totals.records).toBe(922);
  expect(info.totals.tombstones).toBe(26);
  // 26 条墓碑里有一条是 PCB 的空 NET 占位（builder 写成空体），归约后保留。
  expect(info.totals.reducedRecords).toBe(897);
  expect(info.totals.types.PAD_NET).toBe(8);
  const pcb = info.files.find((file) => file.role === "pcb");
  expect(pcb?.docs.at(-1)?.docType).toBe("PCB");
  expect(pcb?.docs.at(-1)?.uuid).toBe("5d15c469efa6e1b1");
});

test("loadEprj3Project：索引名可以不同于目录名", () => {
  const project = loadEprj3Project(FIXTURE);
  expect(path.basename(project.indexFile)).toBe("blink.eprj3");
  expect(project.client).toHaveLength(16);
  expect(project.profile.schematics[IDS.schematic]).toBeUndefined();
});

// ---------------------------------------------------------------- 格式门

test("validateEprj3Project：blink 通过（0 error / 0 warning）", () => {
  const result = validateEprj3Project(FIXTURE);
  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
});

test("validateEprj3Project：最小工程通过，LINE→WIRE 缺失降级为 warning", () => {
  const dir = makeMinimalProject();
  const result = validateEprj3Project(dir);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain("LINE 引用的 WIRE missing-wire");
});

test("validateEprj3Project：墓碑记录不参与引用检查", () => {
  const dir = makeMinimalProject({ tombstonedBadRef: true });
  const result = validateEprj3Project(dir);
  expect(result.errors).toEqual([]);
});

test("validateEprj3Project：存活 PAD_NET 缺元件 / 网名要报错", () => {
  const dir = makeMinimalProject({ liveBadPadNet: true });
  const result = validateEprj3Project(dir);
  expect(result.errors.length).toBeGreaterThanOrEqual(1);
  expect(result.errors.some((message) => message.includes("PAD_NET"))).toBe(true);
});

test("validateEprj3Project：META 空体报错", () => {
  const dir = makeMinimalProject({ emptyMeta: true });
  const result = validateEprj3Project(dir);
  expect(result.errors.some((message) => message.includes("META"))).toBe(true);
});

test("validateEprj3Project：eprj3-example 通过（源仓库存在时才跑）", () => {
  if (!existsSync(EPRJ3_EXAMPLE)) return;
  const result = validateEprj3Project(EPRJ3_EXAMPLE);
  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain("evar");
});

test.skipIf(!existsSync(ESP32))(
  "validateEprj3Project：esp32-s31 修正后只剩可解释的少量 error",
  () => {
    const result = validateEprj3Project(ESP32);
    // 源版 1106 个 error：921 个 LINE→WIRE 已降级为 warning，182 个墓碑 PAD_NET、
    // 2 个 16-hex 引脚 parentId 与板框误报已消除。剩下 1 个是真实的悬挂网名：
    // 删除的 NET "EN" 仍有存活 PAD_NET 引用。
    expect(result.errors.length).toBeLessThanOrEqual(1);
    if (result.errors.length === 1) expect(result.errors[0]).toContain("PAD_NET");
    expect(result.warnings.some((warning) => warning.includes("LINE 引用的 WIRE"))).toBe(true);
  },
  60_000,
);

// ------------------------------------------------------------------ 网表

test("sheetNetlist：blink 的单页网表", () => {
  const netlist = sheetNetlist(path.join(FIXTURE, "sch", "Schematic1", "P1.esch2"));
  expect(netlist.components.map((component) => component.ref)).toContain("R1");
  expect(netlist.nets.map((net) => net.name)).toEqual(["GND", "LED_A", "V_LED", "VCC"]);
  const led = netlist.nets.find((net) => net.name === "LED_A");
  expect(led?.pins.map((pin) => `${pin.ref}.${pin.num}`)).toEqual(["R1.2", "D2.1"]);
  expect(netlist.wireCount).toBe(8);
  expect(netlist.unconnected).toEqual([]);
});

test("pcbNetlist：blink 的 PAD_NET 权威网表", () => {
  const netlist = pcbNetlist(path.join(FIXTURE, "pcb", "PCB1.epcb2"));
  expect(netlist.pads).toHaveLength(8);
  expect(netlist.nets.map((net) => net.name)).toEqual(["GND", "LED_A", "V_LED", "VCC"]);
  const vcc = netlist.nets.find((net) => net.name === "VCC");
  expect(vcc?.pins).toEqual([{ ref: "D1", num: "1" }]);
});

// ---------------------------------------------------------------- CLI / MCP

test("runEprj3Command：inspect / records / validate / netlist", async () => {
  const inspectIo = createMemoryIo();
  expect(await runEprj3Command(["inspect", FIXTURE, "--json"], inspectIo, ENV)).toBe(0);
  const info = JSON.parse(inspectIo.lines.join("\n")) as {
    name: string;
    totals: { records: number };
  };
  expect(info.name).toBe("blink");
  expect(info.totals.records).toBe(922);

  const recordsIo = createMemoryIo();
  expect(
    await runEprj3Command(
      ["records", FIXTURE, "--type", "PAD_NET", "--limit", "2", "--json"],
      recordsIo,
      ENV,
    ),
  ).toBe(0);
  const records = JSON.parse(recordsIo.lines.join("\n")) as {
    totalRecords: number;
    returnedRecords: number;
    truncated: boolean;
  };
  expect(records.totalRecords).toBe(8);
  expect(records.returnedRecords).toBe(2);
  expect(records.truncated).toBe(true);

  const validateIo = createMemoryIo();
  expect(await runEprj3Command(["validate", FIXTURE], validateIo, ENV)).toBe(0);
  expect(validateIo.lines.join("\n")).toContain("OK（0 error，0 warning）");

  const netlistIo = createMemoryIo();
  expect(await runEprj3Command(["netlist", FIXTURE, "--json"], netlistIo, ENV)).toBe(0);
  const netlist = JSON.parse(netlistIo.lines.join("\n")) as {
    perSheet: { netlist: { nets: { name: string }[] } }[];
  };
  expect(netlist.perSheet[0]?.netlist.nets.map((net) => net.name)).toEqual([
    "GND",
    "LED_A",
    "V_LED",
    "VCC",
  ]);

  const helpIo = createMemoryIo();
  expect(await runEprj3Command(["help"], helpIo, ENV)).toBe(0);
  expect(helpIo.lines.join("\n")).toContain("lceda-connect eprj3");
});

test("runEprj3Command：records --file 只读指定容器，--raw 打印原始行", async () => {
  const io = createMemoryIo();
  const code = await runEprj3Command(
    ["records", FIXTURE, "--file", "pcb/PCB1.epcb2", "--type", "PAD_NET", "--raw"],
    io,
    ENV,
  );
  expect(code).toBe(0);
  const text = io.lines.join("\n");
  expect(text).toContain("pcb/PCB1.epcb2");
  expect(text).toContain('{"type":"PAD_NET"');
  expect(text).not.toContain("P1.esch2");
});

test("runEprj3Command：run 把参数转交 sidecar", async () => {
  const io = createMemoryIo();
  const code = await runEprj3Command(
    ["run", "validate", "--json", "--", "--dir", FIXTURE, "--json"],
    io,
    ENV,
  );
  expect(code).toBe(0);
  const result = JSON.parse(io.lines.join("\n")) as {
    exitCode: number;
    json: { errors: string[]; warnings: string[] };
  };
  expect(result.exitCode).toBe(0);
  expect(result.json.errors).toEqual([]);
});

test("runEprj3Command：未放行的 sidecar 脚本返回错误", async () => {
  const io = createMemoryIo();
  expect(await runEprj3Command(["run", "eval", "--"], io, ENV)).toBe(2);
  expect(io.errors.join("\n")).toContain("EPRJ3_SCRIPT_UNKNOWN");
});

test("eprj3Tools 暴露第一批工具，写操作缺 confirm 时拒绝", async () => {
  expect(eprj3Tools.map((tool) => tool.name)).toEqual([
    "eprj3_inspect",
    "eprj3_read_records",
    "eprj3_validate",
    "eprj3_netlist",
    "eprj3_gates",
    "eprj3_build",
    "eprj3_edit",
  ]);
  const byName = (name: string) => {
    const tool = eprj3Tools.find((item) => item.name === name);
    if (tool === undefined) throw new Error(`工具 ${name} 不存在`);
    return tool;
  };
  const inspect = (await byName("eprj3_inspect").run({ dir: FIXTURE }, CTX)) as {
    name: string;
  };
  expect(inspect.name).toBe("blink");

  const records = (await byName("eprj3_read_records").run(
    { dir: FIXTURE, type: "PAD_NET", limit: 1 },
    CTX,
  )) as { returnedRecords: number; truncated: boolean };
  expect(records.returnedRecords).toBe(1);
  expect(records.truncated).toBe(true);

  const validated = (await byName("eprj3_validate").run({ dir: FIXTURE }, CTX)) as {
    ok: boolean;
  };
  expect(validated.ok).toBe(true);

  const netlist = (await byName("eprj3_netlist").run({ dir: FIXTURE }, CTX)) as {
    sheets: unknown[];
  };
  expect(netlist.sheets).toHaveLength(1);

  await expect(
    byName("eprj3_build").run(
      {
        design: path.join(FIXTURE, "blink.eprj3"),
        dir: path.join(tmpdir(), "eprj3-never"),
        dryRun: false,
      },
      CTX,
    ),
  ).rejects.toMatchObject({ code: "CONFIRM_REQUIRED" });
  await expect(
    byName("eprj3_edit").run({ op: "rm-rf", args: [], confirm: true }, CTX),
  ).rejects.toMatchObject({ code: "EPRJ3_EDIT_OP_UNKNOWN" });
  await expect(
    byName("eprj3_gates").run({ dir: FIXTURE, gates: ["intent"] }, CTX),
  ).rejects.toMatchObject({ code: "EPRJ3_GATE_DESIGN_REQUIRED" });
});

// -----------------------------------------------------------------  sidecar

test("sidecar 白名单与实际脚本一致，拒绝带路径的名字", async () => {
  const scripts = listEprj3Scripts(ENV);
  expect(scripts).toContain("validate");
  expect(scripts).toContain("build");
  expect(scripts).not.toContain("eval");
  expect(scripts).not.toContain("make-board");
  await expect(runEprj3Script("../scripts/validate", [], { env: ENV })).rejects.toMatchObject({
    code: "EPRJ3_SCRIPT_UNKNOWN",
  });
  await expect(runEprj3Script("eval", [], { env: ENV })).rejects.toMatchObject({
    code: "EPRJ3_SCRIPT_UNKNOWN",
  });
});

test("sidecar validate：对仓库内 blink 夹具返回 exit 0", async () => {
  const result = await runEprj3Script("validate", ["--dir", FIXTURE, "--json"], { env: ENV });
  expect(result.exitCode).toBe(0);
  expect(result.ok).toBe(true);
  expect(result.json).toMatchObject({ errors: [], warnings: [] });
});

test("sidecar 写操作在 os.tmpdir() 的副本上跑：init 生成可校验工程", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "eprj3-sidecar-"));
  const target = path.join(root, "board");
  const init = await runEprj3Script("init", ["--dir", target, "--name", "demo"], { env: ENV });
  expect(init.exitCode).toBe(0);
  const result = validateEprj3Project(target);
  expect(result.ok).toBe(true);
  const check = await runEprj3Script("validate", ["--dir", target, "--json"], { env: ENV });
  expect(check.exitCode).toBe(0);
});
