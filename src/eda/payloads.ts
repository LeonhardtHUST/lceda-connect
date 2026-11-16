/**
 * 从 Python 编排层原样抠出来的 JS 载荷。
 *
 * 来源（MIT）：leonskill-easyeda-connect
 * - `scripts/eda_verbs.py`：`DOC_TYPES`、`DOC_PROBE`、`DOC_PROBE_EXPR`、
 *   `bridge_run_drc`、`bridge_route_net`、`bridge_read_board` 的网表读取；
 * - `scripts/board_reader_v2.py`：`BOARD_READ_JS_V2`（含 `__P2P_TARGETS__` 注入点，
 *   本层未移植坐标比对，模块级常量按 `null` 渲染）。
 *
 * 载荷一律用 `eda.` 前缀：bridge 通道把它当 `async function(eda){...}` 的函数体，
 * CDP 通道在求值前注入 `const eda = globalThis._EXTAPI_ROOT_`。载荷必须是安全的
 * 字符串常量：`BOARD_READ_JS_V2` 里的 `docType !== 3` 闸门与 `.catch(() => null)`
 * 兜底不能删，否则停在原理图页会读出「八计数全 0 且无报错」的假读数。
 */

/** 文档类型枚举（`EDMT_EditorDocumentType`），与源仓库 `DOC_TYPES` 一致。 */
export const DOC_TYPES: Readonly<Record<number, string>> = {
  1: "schematic",
  3: "pcb",
  5: "project",
  12: "pcb-2d-preview",
  15: "pcb-3d-preview",
};

export const DOC_TYPE_PCB = 3;
export const DOC_TYPE_SCHEMATIC_PAGE = 1;
export const DOC_TYPE_HOME = -1;

/**
 * DRC 坐标容差（单位与叶子 x/y 一致，真实 DRC 坐标是 mil）。
 * 0.02 是源仓库刻意保守的值：只合并几乎重合的重复上报。
 */
export const DRC_COORD_TOL_DEFAULT = 0.02;

/** 读数器标识；参与四个指纹的盐与快照主键。跨版本不可比就靠它。 */
export const READER_ID = "BOARD_READ_JS@v2";
export const V1_READER_ID = "BOARD_READ_JS@v1";

/** 源仓库 `DOC_PROBE`：当前文档类型与 uuid（bridge 通道，`eda` 已注入）。 */
export const DOC_PROBE_JS = String.raw`
const d = await eda.dmt_SelectControl.getCurrentDocumentInfo();
return d ? { type: d.documentType, uuid: d.uuid } : null;
`;

/** 源仓库 `DOC_PROBE_EXPR`：CDP 通道选页时用的独立表达式（自带 A 注入）。 */
export const DOC_PROBE_EXPR = String.raw`
(async () => {
  const A = globalThis._EXTAPI_ROOT_;
  const d = await A.dmt_SelectControl.getCurrentDocumentInfo();
  return d ? { type: d.documentType } : null;
})()
`;

/** 文档列表载荷：形状取自 `src/cdp/docs.ts` 的 `LIST_JS`，把 `A` 换成 `eda`。 */
export const DOC_LIST_JS = String.raw`
const out = [];
try {
  const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
  for (const p of (pcbs || [])) {
    out.push({kind: 'pcb', name: p.name, uuid: p.uuid,
              project: p.parentProjectUuid || null, board: p.parentBoardName || null});
  }
} catch (e) { out.push({kind: 'error', scope: 'pcb', message: String(e).slice(0, 160)}); }
try {
  const pages = await eda.dmt_Schematic.getAllSchematicPagesInfo();
  for (const s of (pages || [])) {
    out.push({kind: 'sch', name: s.name, uuid: s.uuid,
              project: s.parentProjectUuid || null, schematic: s.parentSchematicName || null});
  }
} catch (e) { out.push({kind: 'error', scope: 'sch', message: String(e).slice(0, 160)}); }
return {documents: out};
`;

/** 网表名载荷：`getAllNetsName()` 无文档时返回 null，不能用 `|| []` 吞成空表。 */
export const NET_NAMES_JS = String.raw`
const nets = await eda.pcb_Net.getAllNetsName().catch(() => null);
if (!Array.isArray(nets)) return { available: false, count: null, netNames: null };
return { available: true, count: nets.length, netNames: nets };
`;

/**
 * DRC 载荷：`pcb_Drc.check(false, true, true)` 展开成「类别统计 + 去重前叶子」。
 *
 * 类别统计部分逐字保留 `bridge_run_drc` 的口径（每类前 12 条明细）；`leaves` 是为
 * D10 去重补的展平结果，投影字段与 `BOARD_READ_JS_V2` 的 `packLeaf` 一致，避免
 * 身份四元组、坐标、severity 因投影不同在两条路径上读出两种结果。
 */
export const DRC_JS = String.raw`
let issues = null;
try { issues = await eda.pcb_Drc.check(false, true, true); } catch (e) { return { error: String(e) }; }
if (!Array.isArray(issues)) return { error: 'DRC 返回不是数组', raw: issues };
const scalar = (v) => (v === null || typeof v === 'string' ||
                       typeof v === 'number' || typeof v === 'boolean') ? v : null;
const scalars = (o) => {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const k of Object.keys(o)) {
    const s = scalar(o[k]);
    if (s !== null) out[k] = s;
  }
  return out;
};
const brief = (v) => {
  const s = scalar(v);
  if (s !== null) return s;
  if (Array.isArray(v)) return v.slice(0, 8).map(brief);
  if (v && typeof v === 'object') return scalars(v);
  return null;
};
const packLeaf = (node, groupName) => {
  const out = scalars(node);
  out._group = (groupName === null || groupName === undefined) ? null : String(groupName);
  for (const key of ['pos', 'objs', 'explanation', 'point', 'location', 'ids', 'severity']) {
    const v = node && node[key];
    if (v !== undefined && v !== null) out[key] = brief(v);
  }
  return out;
};
const categories = [];
const leaves = [];
for (const category of issues) {
  const bucket = [];
  const collect = (node) => {
    if (node && Array.isArray(node.list)) { for (const child of node.list) collect(child); }
    else if (node) { bucket.push(node); }
  };
  const groupName = (category && category.name !== undefined && category.name !== null)
    ? String(category.name) : null;
  const collectLeaves = (node) => {
    if (node && Array.isArray(node.list)) { for (const child of node.list) collectLeaves(child); }
    else if (node) { leaves.push(packLeaf(node, groupName)); }
  };
  collect(category);
  collectLeaves(category);
  categories.push({
    category: category && category.name,
    count: bucket.length,
    items: bucket.slice(0, 12).map((leaf) => ({
      errorType: leaf.errorType,
      objType: leaf.errorObjType,
      net: leaf.net,
      pos: leaf.pos,
      objs: leaf.objs,
      detail: leaf.explanation && leaf.explanation.param
    }))
  });
}
return { total: leaves.length, categories, leaves };
`;

/** 自动布线载荷：与 `bridge_route_net` 逐句一致，只把网络名换成 JSON 字面量。 */
export function autoRouteJs(nets: readonly string[]): string {
  // 与 Python `json.dumps(nets)` 的默认分隔符（逗号后带空格）对齐，便于逐句比对。
  const encoded = `[${nets.map((net) => JSON.stringify(net)).join(", ")}]`;
  return String.raw`
const nets = ${encoded};
const before = await eda.pcb_PrimitiveLine.getAll().then(a => a.length).catch(() => -1);
const result = await eda.pcb_Document.autoRouting({ RoutingNets: nets });
const after = await eda.pcb_PrimitiveLine.getAll().then(a => a.length).catch(() => -1);
return { before, after, result };
`;
}

// ─── BOARD_READ_JS@v2 ─────────────────────────────────────────────────
//
// 逐字取自 `board_reader_v2.py` 的 `_READOUT_JS_TEMPLATE`，只把注入点渲染成 null。
// 三条「静默少读 / 假 0」防线原样保留：
//   ① docType 闸门：非 PCB 一个计数都不采集；
//   ② null 与 [] 分开：读不到是 null，真 0 条是 []；
//   ③ 连读两次比对五项计数 + 网络名，不一致只重试一次并标 settled=false。

/** 坐标比对注入点；本层未实现 targets，模块级常量一律渲染成 `null`。 */
export const READOUT_TARGETS_TOKEN = "__P2P_TARGETS__";

const READOUT_JS_TEMPLATE = `
const di = await eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => null);
const docType = (di && typeof di.documentType === 'number') ? di.documentType : null;
const scalar = (v) => (v === null || typeof v === 'string' ||
                       typeof v === 'number' || typeof v === 'boolean') ? v : null;
const arr = (v) => Array.isArray(v) ? v : null;
const asCount = (v) => (v === null ? null : v.length);
// 坐标比对配置（P1）：下一行的占位符由 Python 侧注入
// {"tol_mil":1.0,"targets":{"C1":[500,-600]}} 或 null。
const CFG = __P2P_TARGETS__;
if (docType !== 3) {
  // 文档类型不对 ⇒ 不采集任何计数（否则得到「全 0 且无报错」的假读数）。
  return {
    doc_type: docType, doc_type_mismatch: true,
    lines: null, vias: null, comps: null, pours: null,
    nets: null, drc_leaves: null, eda_groups: null, details: null,
    settled: null, settled_mismatch_keys: [], targets: null, silks: null,
    reader_id: 'BOARD_READ_JS@v2'
  };
}
const scalars = (o) => {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const k of Object.keys(o)) {
    const s = scalar(o[k]);
    if (s !== null) out[k] = s;
  }
  return out;
};
const brief = (v) => {
  const s = scalar(v);
  if (s !== null) return s;
  if (Array.isArray(v)) return v.slice(0, 8).map(brief);
  if (v && typeof v === 'object') return scalars(v);
  return null;
};
const packLeaf = (node, groupName) => {
  const out = scalars(node);
  const gname = (groupName === null || groupName === undefined) ? null : String(groupName);
  out._group = gname;
  // 分组树递归下来的 category name 必须能在叶子上继承：EDA 原始叶子可能既没有
  // cat 也没有 errorType，只有分组节点带 name。此时补一个 category 供多候选键归一化，
  // 否则该叶子身份全缺、只能保守独立成一条（不是错，但会失去有效去重）。
  if (gname !== null && out.cat === undefined && out.category === undefined &&
      out.errorType === undefined) {
    out.category = gname;
  }
  // severity 是方案 C 的聚合依据：scalars() 已能带出标量值，这里再显式兜住非标量
  // 形态（只新增字段，不改任何既有投影键；severity 不进任何哈希）。
  for (const key of ['pos', 'objs', 'explanation', 'point', 'location', 'ids',
                     'severity']) {
    const v = node && node[key];
    if (v !== undefined && v !== null) out[key] = brief(v);
  }
  return out;
};
const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
// ── 读数本体：cheap（五个轻量 getAll，实测合计 ~10-300ms）与 drc（独吞 ~1.7-2.3s）
// 分开，因为 P0 计划风险 5 要求「连读两次不得让读数翻倍」。
const readCheap = async () => {
  // 每个 getAll 的兜底一律 null（**不是** []）：null = 调用失败/读不到，[] = 真 0 条。
  const lines = arr(await eda.pcb_PrimitiveLine.getAll().catch(() => null));
  const vias = arr(await eda.pcb_PrimitiveVia.getAll().catch(() => null));
  const comps = arr(await eda.pcb_PrimitiveComponent.getAll().catch(() => null));
  const pourApi = eda['pcb_' + 'PrimitivePour'];
  const pours = arr(await pourApi.getAll().catch(() => null));
  // getAllNetsName() 无文档时**返回 null 而不抛错** ⇒ .catch 不会触发，必须显式判。
  const nets = arr(await eda.pcb_Net.getAllNetsName().catch(() => null));
  return { lines: lines, vias: vias, comps: comps, pours: pours, nets: nets };
};
const readDrc = async () => {
  const raw = arr(await eda.pcb_Drc.check(false, true, true).catch(() => null));
  const out = { available: raw !== null, groups: null, leaves: [] };
  if (raw === null) return out;
  out.groups = [];
  const walk = (node, groupName) => {
    if (node && Array.isArray(node.list)) {
      for (const child of node.list) walk(child, groupName);
    } else if (node) {
      out.leaves.push(packLeaf(node, groupName));
    }
  };
  for (const c of raw) {
    out.groups.push(scalars(c));
    const gname = (c && c.name !== undefined && c.name !== null) ? String(c.name) : null;
    walk(c, gname);
  }
  return out;
};
// 丝印（P2）：只投影「回读是否一致」要判的六个字段，**文本与坐标原文只在本进程内**
// 出现一次就交给 Python 折成哈希，绝不写进 state。
// 兜底一律 null（不是 []）：null = 调用失败/没有文档，[] = 板上真没有丝印。
const readSilk = async () => {
  const api = eda.pcb_PrimitiveString;
  // 命名空间/方法缺失时 \`eda.x.getAll()\` 会**同步抛**（.catch 接不到）⇒ 先判存在，
  // 缺失一律当「读不到」（null），绝不当「0 条」。
  if (!api || typeof api.getAll !== 'function') return null;
  const raw = arr(await api.getAll().catch(() => null));
  if (raw === null) return null;
  return raw.map((item) => {
    const o = scalars(item);
    return {
      layer: num(o.layer), x: num(o.x), y: num(o.y),
      text: (o.text === undefined || o.text === null) ? null : String(o.text),
      fontSize: num(o.fontSize), lineWidth: num(o.lineWidth)
    };
  });
};
// 稳定性签名：五项计数 + 网络名集合（排序后 JSON，避免顺序噪声）。
const cheapSig = (r) => ({
  lines: asCount(r.lines), vias: asCount(r.vias), comps: asCount(r.comps),
  pours: asCount(r.pours),
  nets: r.nets === null ? null : JSON.stringify(r.nets.slice().sort())
});
const cheapDiff = (a, b) => {
  const x = cheapSig(a);
  const y = cheapSig(b);
  return Object.keys(x).filter((k) => x[k] !== y[k]);
};
const buildDetails = (comps) => (comps === null ? null : comps.map((c) => {
  let cid = null;
  if (c) {
    const v = (c.designator !== undefined && c.designator !== null) ? c.designator
            : ((c.name !== undefined && c.name !== null) ? c.name : c.id);
    if (v !== undefined && v !== null) cid = String(v);
  }
  const rotA = c ? num(c.rotation) : null;
  const rotB = c ? num(c.rot) : null;
  return { id: cid, x: c ? num(c.x) : null, y: c ? num(c.y) : null,
           rot: (rotA !== null ? rotA : rotB) };
}));
// 稳定性判定放在**最贵的 DRC 之前**：DRC 一次就吃掉 1.3-2.3s，若把它夹在两次
// 读数中间，第二次 \`getAll\` 会因文档被 DRC 触碰而变慢（实测 +0.55~1.0s）。
// 现在顺序是「廉价读 → 间隔 → 廉价读 → DRC」，常态只多一次廉价读 + 300ms。
let prev = await readCheap();
await new Promise((resolve) => setTimeout(resolve, 50));
let cur = await readCheap();
let diff = cheapDiff(prev, cur);
let retried = false;
if (diff.length > 0) {
  // 几何在动（例如刚 openDocument 还在加载）⇒ 只重试一次：再等一个间隔重新读。
  retried = true;
  prev = cur;
  await new Promise((resolve) => setTimeout(resolve, 50));
  cur = await readCheap();
  diff = cheapDiff(prev, cur);
}
const used = { cheap: cur, drc: await readDrc(), silk: await readSilk() };
const comps = used.cheap.comps;
const details = buildDetails(comps);
// 坐标比对在这里完成（D2=三）：只回传每件的 hit / delta_mil，**坐标明文不出进程**。
// CFG === null ⇒ 完全不比对、不额外调用任何 API（targets 明细为 null）。
let targetsOut = null;
if (CFG !== null && details !== null) {
  targetsOut = [];
  for (const tid of Object.keys(CFG.targets)) {
    const tgt = CFG.targets[tid];
    const row = { id: tid, found: false, hit: false, delta_mil: null };
    for (const d of details) {
      if (!d || d.id !== tid) continue;
      row.found = true;
      if (d.x !== null && d.y !== null) {
        const dx = d.x - tgt[0];
        const dy = d.y - tgt[1];
        row.delta_mil = Math.sqrt(dx * dx + dy * dy);
        row.hit = row.delta_mil <= CFG.tol_mil;
      }
      break;
    }
    targetsOut.push(row);
  }
}
return {
  doc_type: docType, doc_type_mismatch: false,
  settled: diff.length === 0, settled_mismatch_keys: diff, settled_retried: retried,
  lines: asCount(used.cheap.lines), vias: asCount(used.cheap.vias),
  comps: asCount(comps), pours: asCount(used.cheap.pours),
  nets: used.cheap.nets,                          // 数组 或 null（不冒充 []）
  drc_leaves: used.drc.available ? used.drc.leaves : null,   // null 与 [] 必须可区分
  eda_groups: used.drc.groups, details: details,
  silks: used.silk,                               // null = 读不到；[] = 真没有丝印
  targets: targetsOut,                            // null = 未传 targets / 明细不可读
  reader_id: 'BOARD_READ_JS@v2'
};
`;

/** 不注入坐标比对的读数器（与 Python 的 `BOARD_READ_JS_V2` 逐字一致）。 */
export const BOARD_READ_JS_V2: string = READOUT_JS_TEMPLATE.replace(
  READOUT_TARGETS_TOKEN,
  () => "null",
);

/** 写前快照版：只把 pour API 的拼接写法换成点号，其余逐字相同。 */
export const BOARD_READ_JS_V2_SNAPSHOT: string = BOARD_READ_JS_V2.replace(
  "const pourApi = eda['pcb_' + 'PrimitivePour'];",
  "const pourApi = eda.pcb_PrimitivePour;",
);

/** 给 `docType` 数字找可读名字；未知类型原样返回字符串。 */
export function docTypeName(value: unknown): string {
  if (typeof value !== "number" || !Number.isInteger(value)) return "unknown";
  return DOC_TYPES[value] ?? `unknown(${value})`;
}
