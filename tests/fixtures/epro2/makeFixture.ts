/**
 * 合成 .epro2 测试工程。
 *
 * 与源仓库 tests/make_fixture.py 对齐：同一份记录 DSL、同样的变体开关。
 * ZIP 写入用这里自带的最小 stored 写入器，不依赖第三方库；GBK 成员名用
 * 原始字节直接写，模拟 EDA 的真实产物。
 */
import { writeFileSync } from "node:fs";

export interface FixtureOptions {
  netForPad2?: string;
  swapPins?: boolean;
  twoPcb?: boolean;
  duplicatePage?: boolean;
  padMax?: number | null;
  epruName?: string;
}

export function rec(rtype: string, rid: unknown, ticket: number, payload: unknown): string {
  // 与 Python json.dumps 的默认分隔符一致：数组 id 里带空格，element id 的
  // 归约键才会和源仓库测试里的字面量完全一样。
  const head = pyJson({ type: rtype, id: rid, ticket });
  const body = payload !== null && payload !== undefined ? pyJson(payload) : "";
  return `${head}||${body}|`;
}

function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${JSON.stringify(key)}: ${pyJson(item)}`,
    );
    return `{${pairs.join(", ")}}`;
  }
  return "null";
}

export function doc(docType: string, uuid: string, title: string, editVersion = 1): string {
  return rec("DOCHEAD", uuid, 1, {
    docType,
    uuid,
    editVersion,
    title,
  });
}

export function buildEpru(options: FixtureOptions = {}): string {
  const netForPad2 = options.netForPad2 ?? "VCC";
  const { swapPins = false, twoPcb = false, duplicatePage = false } = options;
  const padMax = options.padMax ?? null;
  const lines: string[] = [];
  // swapPins 时把两个引脚的 Pin Number 互换（Pin Name 不动），模拟符号改版。
  const [pin1Number, pin2Number] = swapPins ? ["2", "1"] : ["1", "2"];

  // ---- 符号：电阻 ----
  lines.push(doc("SYMBOL", "s1", "R_0603"));
  lines.push(rec("META", "m1", 1, { title: "R_0603", docType: 2 }));
  lines.push(rec("PIN", "p1", 1, { x: -20, y: 0, rotation: 0, length: 10 }));
  lines.push(rec("PIN", "p2", 1, { x: 20, y: 0, rotation: 180, length: 10 }));
  lines.push(rec("ATTR", "a1", 1, { parentId: "p1", key: "Pin Number", value: pin1Number }));
  lines.push(rec("ATTR", "a2", 1, { parentId: "p1", key: "Pin Name", value: "1" }));
  lines.push(rec("ATTR", "a3", 1, { parentId: "p2", key: "Pin Number", value: pin2Number }));
  lines.push(rec("ATTR", "a4", 1, { parentId: "p2", key: "Pin Name", value: "2" }));

  // ---- 符号：三脚测试件（引脚不在坐标轴上，旋转与镜像都看得出效果） ----
  lines.push(doc("SYMBOL", "s3", "TRI_3PIN"));
  lines.push(rec("META", "m2b", 1, { title: "TRI_3PIN", docType: 2 }));
  lines.push(rec("PIN", "u1", 1, { x: -30, y: -10, rotation: 0, length: 5 }));
  lines.push(rec("PIN", "u2", 1, { x: 30, y: -10, rotation: 180, length: 5 }));
  lines.push(rec("PIN", "u3", 1, { x: 0, y: 20, rotation: 90, length: 5 }));
  lines.push(rec("ATTR", "a10", 1, { parentId: "u1", key: "Pin Number", value: "1" }));
  lines.push(rec("ATTR", "a11", 1, { parentId: "u1", key: "Pin Name", value: "A" }));
  lines.push(rec("ATTR", "a12", 1, { parentId: "u2", key: "Pin Number", value: "2" }));
  lines.push(rec("ATTR", "a13", 1, { parentId: "u2", key: "Pin Name", value: "B" }));
  lines.push(rec("ATTR", "a14", 1, { parentId: "u3", key: "Pin Number", value: "3" }));
  lines.push(rec("ATTR", "a15", 1, { parentId: "u3", key: "Pin Name", value: "C" }));

  // ---- 符号：地标识 ----
  lines.push(doc("SYMBOL", "s2", "GND"));
  lines.push(rec("META", "m2", 1, { title: "GND", docType: 18 }));
  lines.push(rec("PIN", "g1", 1, { x: 0, y: 0, rotation: 0, length: 0 }));
  lines.push(rec("ATTR", "a5", 1, { parentId: "g1", key: "Pin Number", value: "1" }));
  lines.push(rec("ATTR", "a6", 1, { key: "Global Net Name", value: "GND" }));

  // ---- 器件 ----
  lines.push(doc("DEVICE", "d1", "R_0603"));
  lines.push(rec("META", "m3", 1, { title: "R_0603", attributes: { Symbol: "s1", Value: "10k" } }));
  lines.push(doc("DEVICE", "d3", "TRI_3PIN"));
  lines.push(rec("META", "m3b", 1, { title: "TRI_3PIN", attributes: { Symbol: "s3" } }));

  // ---- 封装 ----
  lines.push(doc("FOOTPRINT", "f1", "R0603"));
  lines.push(rec("META", "m4", 1, { title: "R0603" }));
  const pad1: Record<string, unknown> = { num: "1", centerX: -30, centerY: 0 };
  if (padMax !== null) pad1.max = padMax;
  lines.push(rec("PAD", "pd1", 1, pad1));
  lines.push(rec("PAD", "pd2", 1, { num: "2", centerX: 30, centerY: 0 }));

  // ---- 原理图页 ----
  lines.push(doc("SCH_PAGE", "pg1", "P1"));
  lines.push(rec("META", "m5", 1, { title: "P1", docType: 2 }));
  lines.push(
    rec("COMPONENT", "c1", 1, {
      x: 100,
      y: 200,
      rotation: 0,
      isMirror: false,
      attrs: { DeviceName: JSON.stringify({ name: "R_0603", uuid: "d1" }) },
    }),
  );
  lines.push(rec("ATTR", "a7", 1, { parentId: "c1", key: "Designator", value: "R1" }));
  lines.push(rec("COMPONENT", "c2", 2, { x: 80, y: 200, rotation: 0 }));
  lines.push(rec("ATTR", "a8", 1, { parentId: "c2", key: "Symbol", value: "s2" }));
  // 旋转 + 镜像用例：rotation=90 且 isMirror=True。
  lines.push(
    rec("COMPONENT", "c3", 1, {
      x: 400,
      y: 300,
      rotation: 90,
      isMirror: true,
      attrs: { DeviceName: JSON.stringify({ name: "TRI_3PIN", uuid: "d3" }) },
    }),
  );
  lines.push(rec("ATTR", "a16", 1, { parentId: "c3", key: "Designator", value: "U3" }));
  // 纯旋转用例：rotation=180，不镜像。
  lines.push(
    rec("COMPONENT", "c4", 1, {
      x: 600,
      y: 400,
      rotation: 180,
      isMirror: false,
      attrs: { DeviceName: JSON.stringify({ name: "TRI_3PIN", uuid: "d3" }) },
    }),
  );
  lines.push(rec("ATTR", "a17", 1, { parentId: "c4", key: "Designator", value: "U4" }));
  lines.push(rec("WIRE", "w1", 3, {}));
  lines.push(rec("ATTR", "a9", 1, { parentId: "w1", key: "NET", value: "VCC" }));
  lines.push(
    rec("LINE", "l1", 3, {
      lineGroup: "w1",
      startX: 120,
      startY: 200,
      endX: 200,
      endY: 200,
    }),
  );

  if (duplicatePage) {
    // 同名页：第二页标题也叫 P1，标签会变成 P1#2，但 name 仍是 P1。
    lines.push(doc("SCH_PAGE", "pg2", "P1"));
    lines.push(rec("META", "m5b", 1, { title: "P1", docType: 2 }));
  }

  // ---- PCB ----
  lines.push(doc("PCB", "pb1", "PCB"));
  lines.push(rec("META", "m6", 1, { title: "PCB" }));
  lines.push(rec("LAYER", ["LAYER", 1], 1, { layerType: "TOP", layerName: "Top Layer" }));
  lines.push(rec("LAYER", ["LAYER", 2], 1, { layerType: "BOTTOM", layerName: "Bottom Layer" }));
  lines.push(rec("LAYER_PHYS", ["LAYER_PHYS"], 1, { thickness: 1.6, er: 4.4, lossTangent: 0.02 }));
  lines.push(rec("COMPONENT", "pc1", 1, { x: 0, y: 0, angle: 0, layerId: 1 }));
  lines.push(rec("ATTR", "b1", 1, { parentId: "pc1", key: "Designator", value: "R1" }));
  lines.push(rec("ATTR", "b2", 1, { parentId: "pc1", key: "Device", value: "d1" }));
  lines.push(rec("ATTR", "b3", 1, { parentId: "pc1", key: "Footprint", value: "f1" }));
  lines.push(rec("PAD_NET", ["PAD_NET", "pc1", "1", "pd1"], 10, { padNet: "GND" }));
  lines.push(rec("PAD_NET", ["PAD_NET", "pc1", "2", "pd2"], 5, { padNet: "" }));
  lines.push(rec("PAD_NET", ["PAD_NET", "pc1", "2", "pd2"], 20, { padNet: netForPad2 }));

  // 残留元件：没有位号。
  lines.push(rec("COMPONENT", "pc9", 2, { x: 500, y: 500, angle: 0, layerId: 1 }));
  lines.push(rec("PAD_NET", ["PAD_NET", "pc9", "1", "px"], 7, { padNet: "GHOST" }));

  lines.push(
    rec("LINE", "t1", 4, {
      netName: "VCC",
      layerId: 1,
      startX: 0,
      startY: 0,
      endX: 1000,
      endY: 0,
      width: 10,
    }),
  );
  lines.push(
    rec("VIA", "v1", 4, {
      netName: "VCC",
      centerX: 500,
      centerY: 0,
      holeDiameter: 11.811,
      viaDiameter: 23.622,
      viaType: "THROUGH",
    }),
  );
  lines.push(
    rec("POLY", "o1", 4, {
      layerId: 11,
      polyType: "BOARD_OUTLINE",
      path: ["R", 0, 0, 1000, 500, 0, 0],
    }),
  );

  if (twoPcb) {
    // 第二个 PCB 文档：只有底层走线和另一种孔径的过孔。
    lines.push(doc("PCB", "pb2", "PCB_2"));
    lines.push(rec("META", "m7", 1, { title: "PCB_2" }));
    lines.push(
      rec("LINE", "t2", 4, {
        netName: "GND",
        layerId: 2,
        startX: 0,
        startY: 0,
        endX: 300,
        endY: 400,
        width: 8,
      }),
    );
    lines.push(
      rec("VIA", "v2", 4, {
        netName: "GND",
        centerX: 100,
        centerY: 100,
        holeDiameter: 20.0,
        viaDiameter: 40.0,
        viaType: "THROUGH",
      }),
    );
    lines.push(
      rec("POLY", "o2", 4, {
        layerId: 11,
        polyType: "BOARD_OUTLINE",
        // 第二块板小且错开：用于验证“逐板尺寸”与“并集尺寸”是两回事。
        path: ["R", 2000, 0, 500, 500, 0, 0],
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---- 最小 stored-ZIP 写入器（测试夹具专用） ----

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i] ?? 0;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipInput {
  name: string | Uint8Array;
  data: Buffer;
  flags?: number;
}

export function buildStoredZip(files: readonly ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name =
      typeof file.name === "string" ? Buffer.from(file.name, "utf8") : Buffer.from(file.name);
    const flags =
      file.flags ?? (typeof file.name === "string" && /\P{ASCII}/u.test(file.name) ? 0x0800 : 0);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + file.data.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** GBK 原始字节的“工程文件.epru”，与 EDA 写出的未设 UTF-8 标志位成员名一致。 */
export const GBK_EPRU_NAME = Buffer.from([
  0xb9, 0xa4, 0xb3, 0xcc, 0xce, 0xc4, 0xbc, 0xfe, 0x2e, 0x65, 0x70, 0x72, 0x75,
]);

export function writeProject(filePath: string, options: FixtureOptions = {}): string {
  const epru = buildEpru(options);
  const epruName = options.epruName ?? "TestProj.epru";
  const zip = buildStoredZip([
    {
      name: "project2.json",
      data: Buffer.from(JSON.stringify({ title: "TestProj", editorVersion: "4.1.0" }), "utf8"),
    },
    { name: epruName, data: Buffer.from(epru, "utf8") },
  ]);
  writeFileSync(filePath, zip);
  return filePath;
}

/** 额外生成一个 GBK 成员名的工程，用来覆盖 cp437→GBK 解码路径。 */
export function writeGbkProject(filePath: string, options: FixtureOptions = {}): string {
  const epru = buildEpru(options);
  const zip = buildStoredZip([
    {
      name: "project2.json",
      data: Buffer.from(JSON.stringify({ title: "TestProj", editorVersion: "4.1.0" }), "utf8"),
    },
    { name: GBK_EPRU_NAME, data: Buffer.from(epru, "utf8"), flags: 0 },
  ]);
  writeFileSync(filePath, zip);
  return filePath;
}
