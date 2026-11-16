import { readFileSync } from "node:fs";

import type { CapabilityRoute } from "./capabilities.ts";
import {
  aggregateDrc,
  boardDigest,
  compareBoardDigest,
  dedupeDrcLeaves,
  normalizeBoardState,
  snapshotKey,
  type BoardDigest,
  type BoardDigestComparison,
  type BoardState,
} from "./boardState.ts";
import { writeEvidence, type EvidenceWriteResult } from "./evidence.ts";
import {
  EdaVerbError,
  EXIT_NO_CHANNEL,
  EXIT_PRECHECK,
  EXIT_PROTOCOL,
  EXIT_TIMEOUT,
  runRouted,
  type ExecContext,
  type RoutedAttempt,
  type RoutedOutcome,
} from "./exec.ts";
import {
  BOARD_READ_JS_V2,
  DOC_PROBE_JS,
  DOC_TYPE_PCB,
  DRC_JS,
  READER_ID,
  autoRouteJs,
  docTypeName,
} from "./payloads.ts";

/**
 * 编辑器动词层（源仓库 `scripts/eda_verbs.py` 的高频子集）。
 *
 * 六个动词：doc_info、read_board_state、run_drc、board_digest、route_nets、
 * eval_api。读动词只说读到了什么；写动词必须先 confirm，并把对象、影响与回滚
 * 写进错误 details。成败只看回读：读板看 docType 与计数，DRC 看叶子与双探针，
 * 自动布线看布线前后的线数。
 */

/** doc_info / eval_api 不在台账里，用固定两条路由（bridge 优先，CDP 兜底）。 */
const SYNTHETIC_ROUTES: readonly CapabilityRoute[] = [
  { priority: 1, channel: "bridge" },
  { priority: 2, channel: "cdp" },
];

export interface VerbMeta {
  channel: string;
  attempts: RoutedAttempt[];
  degrade?: string;
  evidence?: EvidenceWriteResult;
}

export interface VerbOptions {
  /** 给定时把 result.json 与 evidence.md 落到该目录。 */
  outDir?: string;
  command?: string;
  timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseResultRecord(outcome: RoutedOutcome, verb: string): Record<string, unknown> {
  let value = outcome.result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new EdaVerbError("BAD_RESPONSE", `${verb}：编辑器返回的不是 JSON 对象`, {
        exitCode: EXIT_PROTOCOL,
        details: { attempts: outcome.attempts, raw: String(outcome.result).slice(0, 300) },
      });
    }
  }
  const record = asRecord(value);
  if (!record) {
    throw new EdaVerbError("BAD_RESPONSE", `${verb}：编辑器返回结构异常（不是对象）`, {
      exitCode: EXIT_PROTOCOL,
      details: {
        attempts: outcome.attempts,
        raw: value === null ? null : (JSON.stringify(value) ?? "null").slice(0, 300),
      },
    });
  }
  return record;
}

function failureExitCode(outcome: RoutedOutcome): number {
  const codes = outcome.attempts
    .map((attempt) => attempt.exitCode)
    .filter((code): code is number => typeof code === "number");
  if (codes.includes(EXIT_TIMEOUT)) return EXIT_TIMEOUT;
  if (codes.includes(EXIT_PROTOCOL)) return EXIT_PROTOCOL;
  return EXIT_NO_CHANNEL;
}

function describeAttempts(attempts: readonly RoutedAttempt[]): string {
  return attempts
    .map((attempt) => {
      const head = `${attempt.channel}(P${attempt.priority ?? "?"})`;
      return attempt.ok ? `${head} 成功` : `${head} ${attempt.detail ?? "失败"}`;
    })
    .join("；");
}

/** 通道全失败时抛错，带上每次尝试的明细；成功时返回结果。 */
function requireOutcome(outcome: RoutedOutcome, verb: string): unknown {
  if (outcome.ok) return outcome.result;
  const degrade = outcome.degrade ? `；降级：${outcome.degrade}` : "";
  throw new EdaVerbError(
    outcome.channel === "degrade" ? "CHANNEL_DEGRADED" : "NO_CHANNEL",
    `${verb} 没有可用通道：${describeAttempts(outcome.attempts)}${degrade}`,
    {
      exitCode: failureExitCode(outcome),
      details: {
        attempts: outcome.attempts,
        degrade: outcome.degrade ?? null,
        channel: outcome.channel,
      },
    },
  );
}

function writeVerbEvidence(
  verb: string,
  input: {
    ok: boolean;
    channel: string;
    attempts: readonly RoutedAttempt[];
    result: unknown;
    error?: string;
  },
  options: VerbOptions,
): EvidenceWriteResult | undefined {
  if (!options.outDir) return undefined;
  return writeEvidence(
    {
      verb,
      ok: input.ok,
      channel: input.channel,
      result: input.result,
      attempts: input.attempts,
      command: options.command,
      error: input.error,
      fingerprint: { reader_id: READER_ID, channel: input.channel },
    },
    { outDir: options.outDir },
  );
}

// ─── doc_info ─────────────────────────────────────────────────────────

export interface DocInfoOutcome extends VerbMeta {
  ok: true;
  doc_type: number | null;
  doc_type_name: string;
  uuid: string | null;
}

/** 读当前文档类型（`dmt_SelectControl.getCurrentDocumentInfo()`）。 */
export async function docInfo(ctx: ExecContext = {}): Promise<DocInfoOutcome> {
  const outcome = await runRouted(
    "doc_info",
    { code: DOC_PROBE_JS },
    { ...ctx, routes: ctx.routes ?? SYNTHETIC_ROUTES },
  );
  const value = requireOutcome(outcome, "doc_info");
  // 没有打开任何文档时探针返回 null：这是合法读数，不当作协议错误。
  let record = asRecord(value);
  if (record === null && typeof value === "string") {
    try {
      record = asRecord(JSON.parse(value) as unknown);
    } catch {
      record = null;
    }
  }
  const docType = typeof record?.type === "number" ? record.type : null;
  const uuid = typeof record?.uuid === "string" && record.uuid !== "" ? record.uuid : null;
  return {
    ok: true,
    channel: outcome.channel,
    attempts: outcome.attempts,
    degrade: outcome.degrade,
    doc_type: docType,
    doc_type_name: docTypeName(docType),
    uuid,
  };
}

// ─── 读板 ─────────────────────────────────────────────────────────────

interface RawBoardRead {
  outcome: RoutedOutcome;
  raw: Record<string, unknown>;
}

async function readRawBoard(ctx: ExecContext, options: VerbOptions): Promise<RawBoardRead> {
  const outcome = await runRouted(
    "read_board_state",
    {
      code: BOARD_READ_JS_V2,
      docTypes: [DOC_TYPE_PCB],
      timeoutMs: options.timeoutMs ?? 240_000,
    },
    ctx,
  );
  const record = parseResultRecord(
    { ...outcome, ok: true, result: requireOutcome(outcome, "read_board_state") },
    "read_board_state",
  );
  const rawDocType = typeof record.doc_type === "number" ? record.doc_type : null;
  if (record.doc_type_mismatch === true || rawDocType !== DOC_TYPE_PCB) {
    throw new EdaVerbError(
      "BOARD_NOT_PCB",
      `当前文档是 ${docTypeName(rawDocType)}（documentType=${rawDocType === null ? "null" : rawDocType}），` +
        "不是 PCB。停在原理图页读板会得到「八计数全 0 且无报错」的假读数；先切到 PCB 文档再读",
      {
        exitCode: EXIT_PRECHECK,
        details: {
          doc_type: rawDocType,
          doc_type_name: docTypeName(rawDocType),
          channel: outcome.channel,
          attempts: outcome.attempts,
        },
      },
    );
  }
  return { outcome, raw: record };
}

export interface ReadBoardOutcome extends VerbMeta {
  ok: true;
  raw_doc_type: number;
  state: BoardState;
}

/** 读 PCB 板面状态；非 PCB 文档直接拒绝（docType gate + 显式检查）。 */
export async function readBoardState(
  ctx: ExecContext = {},
  options: VerbOptions = {},
): Promise<ReadBoardOutcome> {
  const { outcome, raw } = await readRawBoard(ctx, options);
  const state = normalizeBoardState(raw);
  const result = { raw_doc_type: state.doc_type, state };
  const evidence = writeVerbEvidence(
    "read_board_state",
    { ok: true, channel: outcome.channel, attempts: outcome.attempts, result },
    options,
  );
  return {
    ok: true,
    channel: outcome.channel,
    attempts: outcome.attempts,
    degrade: outcome.degrade,
    raw_doc_type: state.doc_type ?? DOC_TYPE_PCB,
    state,
    evidence,
  };
}

// ─── DRC ──────────────────────────────────────────────────────────────

export interface DrcCategory {
  category: string | null;
  count: number;
  items: unknown[];
}

export interface DrcReadback {
  raw_leaf_count: number;
  leaf_count: number;
  dup_removed: number;
  count_mismatch: boolean | null;
  leaf_hash: string;
  probe_complete: boolean;
  tol: number;
}

export interface RunDrcOutcome extends VerbMeta {
  ok: boolean;
  total: number;
  categories: DrcCategory[];
  drc: number;
  drc_cat: Record<string, number>;
  drc_sub: Record<string, number>;
  cats: string[];
  readback: DrcReadback;
  /** 探针齐备且 EDA 自报计数对得上时才算「可信读数」。 */
  data_trustworthy: boolean;
}

function normalizeCategories(value: unknown): DrcCategory[] {
  if (!Array.isArray(value)) return [];
  const out: DrcCategory[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    out.push({
      category: typeof record.category === "string" ? record.category : null,
      count: typeof record.count === "number" ? record.count : 0,
      items: Array.isArray(record.items) ? record.items : [],
    });
  }
  return out;
}

/** 跑 DRC：类别统计来自载荷，去重与指纹来自 boardState（D10 口径）。 */
export async function runDrc(
  ctx: ExecContext = {},
  options: VerbOptions = {},
): Promise<RunDrcOutcome> {
  const outcome = await runRouted(
    "run_drc",
    { code: DRC_JS, docTypes: [DOC_TYPE_PCB], timeoutMs: options.timeoutMs ?? 180_000 },
    ctx,
  );
  const record = parseResultRecord(
    { ...outcome, ok: true, result: requireOutcome(outcome, "run_drc") },
    "run_drc",
  );
  if (typeof record.error === "string" && record.error !== "") {
    throw new EdaVerbError("DRC_FAILED", `DRC 执行失败：${record.error}`, {
      exitCode: EXIT_PROTOCOL,
      details: { channel: outcome.channel, attempts: outcome.attempts },
    });
  }
  if (!Array.isArray(record.leaves)) {
    throw new EdaVerbError("DRC_BAD_RESPONSE", "DRC 载荷没有返回 leaves，无法做去重与指纹", {
      exitCode: EXIT_PROTOCOL,
      details: { channel: outcome.channel, attempts: outcome.attempts },
    });
  }
  const categories = normalizeCategories(record.categories);
  const leaves = record.leaves;
  const edaCounts = categories.map((item) => item.count);
  const dedupe = dedupeDrcLeaves(leaves, { edaCounts });
  const aggregate = aggregateDrc(dedupe.leaves);
  const readback: DrcReadback = {
    raw_leaf_count: dedupe.drc_raw_leaf_count,
    leaf_count: dedupe.drc_leaf_count,
    dup_removed: dedupe.drc_dup_removed,
    count_mismatch: dedupe.drc_count_mismatch,
    leaf_hash: dedupe.drc_leaf_hash,
    probe_complete: dedupe.probes.probe_complete,
    tol: dedupe.tol,
  };
  const dataTrustworthy = readback.probe_complete && readback.count_mismatch !== true;
  const result = {
    total: leaves.length,
    categories,
    drc: aggregate.drc,
    drc_cat: aggregate.drc_cat,
    drc_sub: aggregate.drc_sub,
    cats: aggregate.cats,
    readback,
  };
  const evidence = writeVerbEvidence(
    "run_drc",
    { ok: true, channel: outcome.channel, attempts: outcome.attempts, result },
    options,
  );
  return {
    ok: true,
    channel: outcome.channel,
    attempts: outcome.attempts,
    degrade: outcome.degrade,
    total: leaves.length,
    categories,
    drc: aggregate.drc ?? 0,
    drc_cat: aggregate.drc_cat ?? {},
    drc_sub: aggregate.drc_sub ?? {},
    cats: aggregate.cats ?? [],
    readback,
    data_trustworthy: dataTrustworthy,
    evidence,
  };
}

// ─── 指纹 ─────────────────────────────────────────────────────────────

export interface BoardDigestOutcome extends VerbMeta {
  ok: true;
  digest: BoardDigest;
  /** 给了 baseline 才有比较结果。 */
  comparison: BoardDigestComparison | null;
}

function compareToBaseline(
  raw: Record<string, unknown>,
  digest: BoardDigest,
  baseline: string,
): BoardDigestComparison {
  const text = baseline.trim();
  const fromFile = (): string => {
    try {
      return readFileSync(text, "utf8");
    } catch (error) {
      throw new EdaVerbError(
        "BASELINE_READ_FAILED",
        `读不了 baseline 文件 ${text}：${error instanceof Error ? error.message : String(error)}`,
        { exitCode: EXIT_PRECHECK },
      );
    }
  };
  const content = text.startsWith("{") ? text : fromFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new EdaVerbError("BASELINE_BAD_JSON", "baseline 不是合法 JSON", {
      exitCode: EXIT_PRECHECK,
    });
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new EdaVerbError("BASELINE_BAD_JSON", "baseline 顶层必须是 JSON 对象", {
      exitCode: EXIT_PRECHECK,
    });
  }
  if ("drc_leaves" in record) {
    return compareBoardDigest(raw, record);
  }
  const expected = typeof record.snapshot_key === "string" ? record.snapshot_key : null;
  if (expected === null) {
    throw new EdaVerbError(
      "BASELINE_NOT_SNAPSHOT",
      "baseline 既不是 v2 读数（缺 reader_id / drc_leaves），也没有 snapshot_key",
      { exitCode: EXIT_PRECHECK },
    );
  }
  const comparable = digest.comparable;
  const actual = digest.snapshot_key;
  const verdict = !comparable ? "unjudgeable" : expected === actual ? "pass" : "fail";
  const reasons: string[] = [];
  if (!comparable) {
    reasons.push(...digest.reasons);
    if (reasons.length === 0) reasons.push("comparable_false: 本次读数不可判");
  } else if (verdict === "fail") {
    reasons.push("snapshot_key_mismatch: 与 baseline 的快照主键不相等");
  }
  return {
    comparable,
    verdict: verdict as BoardDigestComparison["verdict"],
    reasons,
    reader_ids: [digest.reader_id],
    snapshot_key_before: expected,
    snapshot_key_after: actual,
    drc_leaf_hashes: [digest.drc_leaf_hash],
    states: { before: 0, after: 1 },
  };
}

/** 读板指纹；跨版本或探针不全时 judge=unjudgeable，给了 baseline 可直接比较。 */
export async function boardDigestState(
  ctx: ExecContext = {},
  options: VerbOptions & { baseline?: string } = {},
): Promise<BoardDigestOutcome> {
  const { outcome, raw } = await readRawBoard(ctx, options);
  const state = normalizeBoardState(raw);
  const digest = boardDigest(state);
  const comparison = options.baseline ? compareToBaseline(raw, digest, options.baseline) : null;
  const result = { digest, comparison, snapshot_key: digest.snapshot_key };
  const evidence = writeVerbEvidence(
    "board_digest",
    {
      ok: true,
      channel: outcome.channel,
      attempts: outcome.attempts,
      result,
    },
    options,
  );
  return {
    ok: true,
    channel: outcome.channel,
    attempts: outcome.attempts,
    degrade: outcome.degrade,
    digest,
    comparison,
    evidence,
  };
}

/** 供 CLI 在两次读数之间比较时复用：只取当前 state 的主键。 */
export function stateSnapshotKey(state: BoardState): string {
  return snapshotKey(state);
}

// ─── 自动布线（写） ───────────────────────────────────────────────────

export interface RouteNetsOptions extends VerbOptions {
  nets: readonly string[];
  confirm?: boolean;
}

export interface RouteNetsOutcome extends VerbMeta {
  /** 成败只认线数回读：回读失败或线数没增加都算未成功。 */
  ok: boolean;
  nets: string[];
  before: number | null;
  after: number | null;
  delta: number | null;
  lines_added: number | null;
  readback_ok: boolean;
  changed: boolean;
  auto_route: unknown;
  warning?: string;
}

/** 写操作的预演信息：对象、影响、回滚。MCP 与 CLI 在没 confirm 时都展示它。 */
export function routeNetsPreview(nets: readonly string[]): Record<string, unknown> {
  return {
    verb: "route_net",
    object: { nets: [...nets] },
    impact:
      "对指定网络跑 pcb_Document.autoRouting；会新增线段与过孔，已布通的网络可能被重排。" +
      "写操作在历史预览态或非 PCB 文档下会静默失败，执行前要确认当前文档与编辑器状态。",
    rollback:
      "自动布线没有整体撤销 API；写前请另存工程，或确认编辑器撤销历史足够回退。" +
      "本工具会把布线前后线数写进回读结果。",
    confirm_hint: "确认影响后加 --confirm（CLI）或 confirm: true（MCP）重新调用。",
  };
}

/** 对指定网络集合自动布线；confirm 闸口在动词层，CLI 与 MCP 共用。 */
export async function routeNets(
  ctx: ExecContext = {},
  options: RouteNetsOptions = { nets: [] },
): Promise<RouteNetsOutcome> {
  const nets = options.nets.map((item) => item.trim()).filter((item) => item !== "");
  if (nets.length === 0) {
    throw new EdaVerbError("NETS_EMPTY", "网络列表为空：用 --nets a,b 指定至少一个网络", {
      exitCode: EXIT_PRECHECK,
    });
  }
  if (!options.confirm) {
    throw new EdaVerbError("CONFIRM_REQUIRED", "这是写操作，确认影响后以 confirm=true 重新调用。", {
      exitCode: EXIT_PRECHECK,
      details: routeNetsPreview(nets),
    });
  }
  const outcome = await runRouted(
    "route_net",
    { code: autoRouteJs(nets), docTypes: [DOC_TYPE_PCB], timeoutMs: options.timeoutMs ?? 300_000 },
    ctx,
  );
  const record = parseResultRecord(
    { ...outcome, ok: true, result: requireOutcome(outcome, "route_net") },
    "route_net",
  );
  const before = typeof record.before === "number" ? record.before : null;
  const after = typeof record.after === "number" ? record.after : null;
  const delta = before !== null && after !== null ? after - before : null;
  const readbackOk = before !== null && after !== null && before >= 0 && after >= 0;
  const changed = delta !== null && delta > 0;
  let warning: string | undefined;
  if (!readbackOk) {
    warning = "线数回读失败（before/after 为 -1）：本次无法判定布线成败，请不要当成成功。";
  } else if (!changed) {
    warning =
      "布线后线数没有增加：网络可能已布通，或当前文档不是 PCB / 处于历史预览态，写入被静默忽略。";
  }
  const ok = readbackOk && changed;
  const result = {
    nets,
    before,
    after,
    delta,
    lines_added: changed ? delta : 0,
    readback_ok: readbackOk,
    changed,
    auto_route: record.result ?? null,
    warning: warning ?? null,
  };
  const evidence = writeVerbEvidence(
    "route_net",
    { ok, channel: outcome.channel, attempts: outcome.attempts, result, error: warning },
    options,
  );
  return {
    ok,
    channel: outcome.channel,
    attempts: outcome.attempts,
    degrade: outcome.degrade,
    nets,
    before,
    after,
    delta,
    lines_added: changed ? delta : 0,
    readback_ok: readbackOk,
    changed,
    auto_route: record.result ?? null,
    warning,
    evidence,
  };
}

// ─── eval_api（逃生口） ───────────────────────────────────────────────

export interface EvalApiOptions extends VerbOptions {
  code: string;
  confirm?: boolean;
  docTypes?: readonly number[];
}

export interface EvalApiOutcome extends VerbMeta {
  ok: true;
  value: unknown;
}

/** 逃生口：执行任意编辑器代码。属于写操作，必须 confirm。 */
export async function evalApi(
  ctx: ExecContext = {},
  options: EvalApiOptions = { code: "" },
): Promise<EvalApiOutcome> {
  const code = options.code;
  if (code.trim() === "") {
    throw new EdaVerbError("CODE_EMPTY", "eval 需要 --code 或 --file", { exitCode: EXIT_PRECHECK });
  }
  if (!options.confirm) {
    throw new EdaVerbError(
      "CONFIRM_REQUIRED",
      "这是逃生口：代码可以修改设计数据，确认后以 confirm=true 调用。",
      {
        exitCode: EXIT_PRECHECK,
        details: {
          verb: "eval_api",
          code_preview: code.length > 500 ? `${code.slice(0, 500)}…` : code,
          impact: "执行任意 JS，可能创建、修改或删除图元；代码由调用方负责。",
          rollback: "代码自己产生的副作用没有统一回滚；写前另存工程或用撤销历史。",
        },
      },
    );
  }
  const outcome = await runRouted(
    "eval_api",
    { code, docTypes: options.docTypes ?? [DOC_TYPE_PCB], timeoutMs: options.timeoutMs ?? 120_000 },
    { ...ctx, routes: ctx.routes ?? SYNTHETIC_ROUTES },
  );
  const value = requireOutcome(outcome, "eval_api");
  const result = { value };
  const evidence = writeVerbEvidence(
    "eval_api",
    { ok: true, channel: outcome.channel, attempts: outcome.attempts, result },
    options,
  );
  return {
    ok: true,
    channel: outcome.channel,
    attempts: outcome.attempts,
    degrade: outcome.degrade,
    value,
    evidence,
  };
}
