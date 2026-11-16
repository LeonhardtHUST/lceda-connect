import { expect, test } from "vite-plus/test";

import {
  BOARD_READ_JS_V2,
  BOARD_READ_JS_V2_SNAPSHOT,
  READOUT_TARGETS_TOKEN,
} from "../src/eda/payloads.ts";
import {
  PyFloat,
  aggregateDrc,
  canonicalJson,
  compareBoardDigest,
  dedupeDrcLeaves,
  detailsHash,
  designatorSetHash,
  drcLeafHash,
  normalizeBoardState,
  silkHash,
  snapshotKey,
} from "../src/eda/boardState.ts";

// 冻结期望值来自源仓库 tests/test_board_reader_v2_designators.py（Python 3.13 复核）：
//   details_hash=18b999a495e91a01 / drc_leaf_hash=a7fb6a8d5495f060 / snapshot_key=b4ba92f1564aecad。
// 任何一处 canonical 口径或盐变化都会让这些常数对不上。

const FROZEN_DETAILS_HASH = "18b999a495e91a01";
const FROZEN_DRC_LEAF_HASH = "a7fb6a8d5495f060";
const FROZEN_SNAPSHOT_KEY = "b4ba92f1564aecad";

const DETAILS = [
  { id: "R1", x: 3.0, y: 4.0, rot: 0 },
  { id: "U9", x: 1.5, y: -2.25, rot: 90 },
];

function leaf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cat: "Clearance",
    sub: "Track",
    obj1: "A",
    obj2: "B",
    name: "Clearance",
    x: 1.0,
    y: 2.0,
    severity: "error",
    ...over,
  };
}

function rawV2(options: {
  details?: unknown;
  leaves?: unknown[];
  groupsCount?: number;
}): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    lines: 200,
    vias: 6,
    pours: 1,
    nets: ["B_NET", "A_NET", "C_NET"],
    reader_id: "BOARD_READ_JS@v2",
    drc_leaves: options.leaves ?? [leaf()],
    eda_groups: [{ name: "Clearance", count: options.groupsCount ?? 1 }],
  };
  if (options.details !== undefined) {
    raw.details = options.details;
    raw.comps = Array.isArray(options.details) ? options.details.length : 2;
  }
  return raw;
}

test("canonicalJson 与 Python json.dumps 同形：键排序、浮点保留 .0、无空白", () => {
  expect(canonicalJson({ x: new PyFloat(3), y: new PyFloat(-2.25), i: 200 })).toBe(
    '{"i":200,"x":3.0,"y":-2.25}',
  );
  expect(canonicalJson(new PyFloat(70))).toBe("70.0");
  expect(canonicalJson(new PyFloat(0.5))).toBe("0.5");
  expect(canonicalJson([new PyFloat(1), "中", null, true])).toBe('[1.0,"中",null,true]');
  // 计数是整数，不能写成 200.0（快照主键按 Python int 序化）
  expect(canonicalJson(200)).toBe("200");
});

test("details_hash / drc_leaf_hash / snapshot_key 与源实现冻结值一致", () => {
  expect(detailsHash(DETAILS)).toBe(FROZEN_DETAILS_HASH);
  expect(drcLeafHash([leaf()])).toBe(FROZEN_DRC_LEAF_HASH);

  const state = normalizeBoardState(rawV2({ details: DETAILS }));
  expect(state.details_hash).toBe(FROZEN_DETAILS_HASH);
  expect(state.drc_leaf_hash).toBe(FROZEN_DRC_LEAF_HASH);
  expect(state.drc).toBe(1);
  expect(state.cats).toEqual(["Clearance:1"]);
  expect(state.designator_set_hash).toBe("34496e9abf810c7c");
  expect(state.comparable).toBe(true);
  expect(state.reasons).toEqual([]);
  expect(snapshotKey(state)).toBe(FROZEN_SNAPSHOT_KEY);
});

test("哈希带盐：换 reader_id 结果必变，None 与空集分明", () => {
  expect(detailsHash(DETAILS, { readerId: "BOARD_READ_JS@v1" })).toBe("8cc4e3c3e20f0e13");
  expect(detailsHash(null)).toBeNull();
  expect(detailsHash([])).toBe("c4fd862c93624804");
  expect(designatorSetHash(null)).toBeNull();
  expect(designatorSetHash([])).toBe("13b60e50a59a1a1d");
});

test("位号集合指纹：集合语义、大小写不折叠、重命名必变", () => {
  const base = designatorSetHash(DETAILS);
  expect(base).toBe("34496e9abf810c7c");
  expect(designatorSetHash([...DETAILS].reverse())).toBe(base);
  expect(
    designatorSetHash([
      { id: "R1", x: 9, y: 9, rot: 7 },
      { id: " R1 ", x: 5, y: 5, rot: 3 },
    ]),
  ).toBe(designatorSetHash([{ id: "R1", x: 1, y: 1, rot: 0 }]));
  expect(designatorSetHash([{ id: "r1" }])).not.toBe(base);
});

test("DRC 去重：身份四元组精确分组、坐标只在组内容差聚类", () => {
  const leaves = [
    leaf({ x: 1.0, y: 2.0 }),
    leaf({ x: 1.01, y: 2.0 }),
    leaf({ x: 9.0, y: 9.0 }),
    leaf({
      cat: "Netlist Error",
      sub: "Unrouted",
      obj1: "U1",
      obj2: "U2",
      name: "Netlist Error",
      x: 0.0,
      y: 0.0,
    }),
    leaf({
      cat: "Netlist Error",
      sub: "Unrouted",
      obj1: "U1",
      obj2: "U2",
      name: "Netlist Error",
      x: 0.0,
      y: 0.0,
    }),
  ];
  const dedupe = dedupeDrcLeaves(leaves, { edaCounts: [2, 2] });
  expect(dedupe.drc_raw_leaf_count).toBe(5);
  expect(dedupe.drc_leaf_count).toBe(3);
  expect(dedupe.drc_dup_removed).toBe(2);
  expect(dedupe.drc_count_mismatch).toBe(true);
  expect(dedupe.drc_leaf_hash).toBe("52829f63cfaf11d2");
  expect(dedupe.probes.probe_complete).toBe(true);

  const aggregate = aggregateDrc(dedupe.leaves);
  expect(aggregate.drc).toBe(3);
  expect(aggregate.cats).toEqual(["Clearance:2", "Netlist Error:1"]);
  expect(aggregate.drc_cat).toEqual({ Clearance: 2, "Netlist Error": 1 });
  expect(aggregate.connection_category_drift).toBe(false);
});

test("DRC 身份字段缺失：各自独立不合并，并如实留痕", () => {
  const dedupe = dedupeDrcLeaves([{ errorType: "X" }, { errorType: "X" }]);
  expect(dedupe.drc_raw_leaf_count).toBe(2);
  expect(dedupe.drc_leaf_count).toBe(2);
  expect(dedupe.identity_incomplete).toBe(2);
  expect(dedupe.coord_missing).toBe(2);
  expect(dedupe.probes.probe_complete).toBe(false);
});

test("丝印指纹：空集稳定、字段变化敏感、int 与 float 等价", () => {
  const silks = [{ layer: 3, x: 1, y: 2.5, text: "HELLO", fontSize: 70, lineWidth: 10 }];
  expect(silkHash(silks)).toBe("6484ff9b11673aea");
  expect(silkHash([])).toBe("3b397d41e57e1723");
  expect(silkHash(silks)).toBe(
    silkHash([{ layer: 3.0, x: 1.0, y: 2.5, text: "HELLO", fontSize: 70.0, lineWidth: 10.0 }]),
  );
  expect(silkHash([{ ...silks[0], text: "HELLO!" }])).not.toBe(silkHash(silks));
  expect(silkHash(null)).toBeNull();
});

test("归一化：v1 计数型快照 comparable=false；跨 reader 一律 unjudgeable", () => {
  const v1 = normalizeBoardState({ lines: 10, comps: 2, drc: 3, cats: [] });
  expect(v1.comparable).toBe(false);
  expect(v1.reader_id).toBe("BOARD_READ_JS@v1");
  expect(v1.details_hash).toBeNull();

  const raw = rawV2({ details: DETAILS });
  expect(compareBoardDigest(raw, raw).verdict).toBe("pass");

  const renamed = rawV2({
    details: [
      { id: "R9", x: 3.0, y: 4.0, rot: 0 },
      { id: "U9", x: 1.5, y: -2.25, rot: 90 },
    ],
  });
  const changed = compareBoardDigest(raw, renamed);
  expect(changed.verdict).toBe("fail");
  expect(changed.reasons.some((reason) => reason.startsWith("snapshot_key_mismatch"))).toBe(true);

  const crossReader = rawV2({ details: DETAILS });
  crossReader.reader_id = "BOARD_READ_JS@v1";
  const blocked = compareBoardDigest(raw, crossReader);
  expect(blocked.verdict).toBe("unjudgeable");
  expect(blocked.comparable).toBe(false);
});

test("非 PCB 读数：docType 闸门给出 mismatch 且计数全 null", () => {
  const raw = {
    doc_type: 1,
    doc_type_mismatch: true,
    lines: null,
    vias: null,
    comps: null,
    pours: null,
    nets: null,
    drc_leaves: null,
    details: null,
    silks: null,
    settled: null,
    settled_mismatch_keys: [],
    reader_id: "BOARD_READ_JS@v2",
  };
  const state = normalizeBoardState(raw);
  expect(state.doc_type_mismatch).toBe(true);
  expect(state.lines).toBeNull();
  expect(state.available).toBe(false);
  expect(state.comparable).toBe(false);
  expect(state.reasons.some((reason) => reason.startsWith("doc_type_mismatch"))).toBe(true);
});

test("读数载荷保留三条假 0 防线，且模块级常量不残留注入点", () => {
  expect(BOARD_READ_JS_V2).toContain("if (docType !== 3)");
  expect(BOARD_READ_JS_V2).toContain(".catch(() => null)");
  expect(BOARD_READ_JS_V2).toContain("reader_id: 'BOARD_READ_JS@v2'");
  expect(BOARD_READ_JS_V2).toContain("eda['pcb_' + 'PrimitivePour']");
  expect(BOARD_READ_JS_V2).not.toContain(READOUT_TARGETS_TOKEN);
  expect(BOARD_READ_JS_V2).toContain("const CFG = null;");
  expect(BOARD_READ_JS_V2_SNAPSHOT).toContain("const pourApi = eda.pcb_PrimitivePour;");
  expect(BOARD_READ_JS_V2_SNAPSHOT).not.toContain(READOUT_TARGETS_TOKEN);
});
