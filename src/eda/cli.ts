import { readFileSync } from "node:fs";

import {
  CliUsageError,
  boolValue,
  formatOptions,
  numberValue,
  parseArgs,
  stringValue,
  type OptionSpec,
  type ParsedArgs,
} from "../core/cliArgs.ts";
import { loadConfig } from "../core/config.ts";
import type { Io } from "../core/io.ts";
import { hr, paint } from "../core/term.ts";
import { capabilitySummary, lookupCapability } from "./capabilities.ts";
import { checkEnvironment, type EnvironmentReport } from "./channels.ts";
import { EdaVerbError, createDefaultExecContext, type ExecContext } from "./exec.ts";
import {
  boardDigestState,
  docInfo,
  evalApi,
  readBoardState,
  routeNets,
  routeNetsPreview,
  runDrc,
} from "./verbs.ts";

/**
 * `lceda-connect eda <动作>` 的实现（源仓库 `scripts/eda_verbs.py` 的 CLI 子集）。
 *
 * 动作：status / doc / board / drc / digest / route / eval / lookup。
 * 退出码沿用源仓库口径：0 成功 / 1 部分成功 / 2 通道不可用 / 3 前置失败 /
 * 4 协议错误 / 5 超时。写操作不带 --confirm 时只打印计划，不改数据。
 */

const OPTIONS: readonly OptionSpec[] = [
  { name: "json", type: "boolean", description: "以 JSON 输出（给脚本 / Agent 用）" },
  {
    name: "out",
    type: "string",
    placeholder: "DIR",
    description: "证据包输出目录（result.json + evidence.md）",
  },
  {
    name: "match",
    type: "string",
    placeholder: "TEXT",
    description: "CDP 选页用的窗口标题 / URL 子串",
  },
  {
    name: "window",
    type: "string",
    placeholder: "ID",
    description: "bridge 目标窗口 id；缺省按文档类型自动挑或使用激活窗口",
  },
  {
    name: "timeout",
    type: "number",
    placeholder: "SEC",
    description: "单次执行超时（秒）；DRC / 自动布线默认放宽",
  },
  {
    name: "baseline",
    type: "string",
    placeholder: "PATH",
    description: "digest 的对照物：读数 JSON 文件路径或 snapshot_key",
  },
  {
    name: "nets",
    type: "string",
    placeholder: "A,B",
    description: "route 要自动布线的网络名，逗号分隔",
  },
  { name: "confirm", type: "boolean", description: "写操作确认（route / eval）" },
  { name: "code", type: "string", placeholder: "JS", description: "eval 的 async 函数体" },
  { name: "file", type: "string", placeholder: "PATH", description: "eval 从文件读取函数体" },
  {
    name: "limit",
    type: "number",
    placeholder: "N",
    description: "lookup 返回条数上限（默认 10）",
  },
];

const ACTIONS: readonly string[] = [
  "status",
  "doc",
  "board",
  "drc",
  "digest",
  "route",
  "eval",
  "lookup",
  "help",
];

export function edaHelp(): string[] {
  return [
    "",
    paint.cyan("  lceda-connect eda  --  按双通道编排编辑器动作（官方 API 优先，CDP 兜底）"),
    paint.gray(`  ${hr()}`),
    "  用法: lceda-connect eda <动作> [选项]",
    "",
    paint.white("  动作:"),
    "    status    双通道环境自检（both / bridge-only / cdp-only / none）",
    "    doc       读当前文档类型与 uuid；停在原理图页会得到假的全 0，先看这里",
    "    board     读 PCB 板面计数、网络表、DRC 叶子、丝印与指纹（非 PCB 拒绝）",
    "    drc       跑 DRC，返回类别统计、D9 去重与双探针回读",
    "    digest    计算四个指纹 + snapshot_key；可给 --baseline 判 pass/fail/unjudgeable",
    "    route     自动布线（写操作；不带 --confirm 只打印计划）",
    "    eval      逃生口：执行任意编辑器 JS（写操作；不带 --confirm 只打印计划）",
    "    lookup    检索动词台账（capability-map），零命中返回空",
    "    help      这个帮助",
    "",
    paint.white("  选项:"),
    ...formatOptions(OPTIONS),
    "",
    paint.white("  例子:"),
    "    lceda-connect eda status",
    "    lceda-connect eda doc --json",
    "    lceda-connect eda board --out .\\out",
    "    lceda-connect eda drc --json",
    "    lceda-connect eda digest --baseline .\\baseline.json",
    "    lceda-connect eda route --nets GND,VCC --confirm",
    '    lceda-connect eda eval --code "return await eda.dmt_SelectControl.getCurrentDocumentInfo();" --confirm',
    "    lceda-connect eda lookup 自动布线",
    "",
    paint.gray("  写操作没有 --confirm 时只打印对象 / 影响 / 回滚，不改任何数据。"),
    paint.gray(
      "  退出码: 0 成功 / 1 部分成功或用法 / 2 通道不可用 / 3 前置失败 / 4 协议错误 / 5 超时",
    ),
    "",
  ];
}

function printHelp(io: Io): void {
  for (const line of edaHelp()) io.out(line);
}

function printJson(io: Io, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

function secToMs(parsed: ParsedArgs): number | undefined {
  const seconds = numberValue(parsed, "timeout");
  if (seconds === undefined) return undefined;
  return Math.max(1, seconds) * 1000;
}

function contextOf(parsed: ParsedArgs, env: NodeJS.ProcessEnv): ExecContext {
  const cfg = loadConfig(env);
  return createDefaultExecContext({
    env,
    cdpPort: cfg.cdp.port,
    bridgePortFirst: cfg.bridge.portFirst,
    bridgePortLast: cfg.bridge.portLast,
    match: stringValue(parsed, "match"),
    windowId: stringValue(parsed, "window"),
    timeoutMs: secToMs(parsed),
  });
}

function commandOf(argv: readonly string[]): string {
  return `lceda-connect eda ${argv.join(" ")}`.trim();
}

function printAttempts(
  io: Io,
  attempts: readonly { channel: string; priority: number | null; ok: boolean; detail?: string }[],
): void {
  if (attempts.length <= 1) return;
  io.out(paint.gray("  换路记录:"));
  for (const attempt of attempts) {
    const head = `${attempt.channel}(P${attempt.priority ?? "?"})`;
    io.out(paint.gray(`    ${head} ${attempt.ok ? "成功" : (attempt.detail ?? "失败")}`));
  }
}

function printStatus(io: Io, report: EnvironmentReport): void {
  io.out(`  状态: ${report.status}（${report.channel_state}）`);
  for (const check of report.checks) {
    const mark = check.status === "ready" ? "OK  " : check.status === "partial" ? "PART" : "MISS";
    const extra = check.detail ? `  ${check.detail}` : "";
    io.out(`  [${mark}] ${check.id} (${check.reason_code})${extra}`);
    if (check.hint) io.out(paint.gray(`         ${check.hint}`));
  }
  for (const note of report.functional_degradations) io.out(paint.gray(`  降级: ${note}`));
  io.out(`  下一步: ${report.next_action}`);
}

function printDoc(
  io: Io,
  result: { channel: string; doc_type: number | null; doc_type_name: string; uuid: string | null },
): void {
  io.out(`  文档: ${result.doc_type_name}（documentType=${result.doc_type ?? "null"}）`);
  io.out(`  uuid: ${result.uuid ?? "-"}`);
  io.out(`  通道: ${result.channel}`);
}

function printBoard(io: Io, result: Awaited<ReturnType<typeof readBoardState>>): void {
  const state = result.state;
  io.out(`  通道: ${result.channel}`);
  io.out(`  文档: ${state.doc_type === null ? "unknown" : state.doc_type}（PCB 闸门通过）`);
  io.out(
    `  计数: lines=${state.lines ?? "null"} vias=${state.vias ?? "null"} ` +
      `comps=${state.comps ?? "null"} pours=${state.pours ?? "null"}`,
  );
  io.out(`  网络: ${Array.isArray(state.nets) ? `${state.nets.length} 个` : "不可读"}`);
  io.out(
    `  DRC: 去重后 ${state.drc_leaf_count ?? "null"} 条` +
      `（原始 ${state.drc_raw_leaf_count ?? "null"}，去掉重复 ${state.drc_dup_removed ?? "null"}）`,
  );
  if (state.cats && state.cats.length > 0) io.out(`  类别: ${state.cats.join(" / ")}`);
  io.out(`  指纹: details=${state.details_hash ?? "-"} 位号=${state.designator_set_hash ?? "-"}`);
  io.out(`        silk=${state.silk_hash ?? "-"} drc=${state.drc_leaf_hash ?? "-"}`);
  io.out(`  可信: available=${state.available} comparable=${state.comparable}`);
  for (const reason of state.reasons) io.err(`  原因: ${reason}`);
  for (const warning of state.warnings) io.err(`  警告: ${warning}`);
  printAttempts(io, result.attempts);
  if (result.evidence) io.out(`  证据包: ${result.evidence.folder}`);
}

function printDrc(io: Io, result: Awaited<ReturnType<typeof runDrc>>): void {
  io.out(`  通道: ${result.channel}`);
  io.out(`  DRC 叶子: ${result.total} 条（去重后 ${result.drc}）`);
  for (const category of result.categories) {
    io.out(`    ${category.category ?? "(未命名)"}: ${category.count}`);
  }
  io.out(`  类别统计: ${result.cats.join(" / ") || "-"}`);
  io.out(
    `  回读: leaves=${result.readback.leaf_count} dup_removed=${result.readback.dup_removed} ` +
      `count_mismatch=${String(result.readback.count_mismatch)} probe_complete=${result.readback.probe_complete}`,
  );
  io.out(`  指纹: ${result.readback.leaf_hash}`);
  io.out(`  可信读数: ${result.data_trustworthy}`);
  printAttempts(io, result.attempts);
  if (result.evidence) io.out(`  证据包: ${result.evidence.folder}`);
}

function printDigest(io: Io, result: Awaited<ReturnType<typeof boardDigestState>>): void {
  const digest = result.digest;
  io.out(`  通道: ${result.channel}`);
  io.out(`  snapshot_key: ${digest.snapshot_key}`);
  io.out(`  details_hash: ${digest.details_hash ?? "-"}`);
  io.out(`  designator_set_hash: ${digest.designator_set_hash ?? "-"}`);
  io.out(`  silk_hash: ${digest.silk_hash ?? "-"}`);
  io.out(`  drc_leaf_hash: ${digest.drc_leaf_hash ?? "-"}`);
  io.out(`  reader: ${digest.reader_id}  judge: ${digest.judge}`);
  for (const reason of digest.reasons) io.err(`  原因: ${reason}`);
  if (result.comparison) {
    io.out(`  对照: ${result.comparison.verdict}（comparable=${result.comparison.comparable}）`);
    io.out(`        before=${result.comparison.snapshot_key_before}`);
    io.out(`        after =${result.comparison.snapshot_key_after}`);
    for (const reason of result.comparison.reasons) io.err(`  对照原因: ${reason}`);
  }
  printAttempts(io, result.attempts);
  if (result.evidence) io.out(`  证据包: ${result.evidence.folder}`);
}

function printRoutePlan(io: Io, nets: readonly string[]): void {
  const plan = routeNetsPreview(nets);
  io.out(`  动词: ${String(plan.verb)}`);
  io.out(`  对象: ${JSON.stringify(plan.object)}`);
  io.out(`  影响: ${String(plan.impact)}`);
  io.out(`  回滚: ${String(plan.rollback)}`);
  io.out(`  ${String(plan.confirm_hint)}`);
  io.out(paint.gray("  本次未加 --confirm，只打印计划，没有改动任何数据。"));
}

// ─── 动作 ─────────────────────────────────────────────────────────────

async function runStatus(io: Io, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const report = await checkEnvironment({ env });
  if (boolValue(parsed, "json")) {
    printJson(io, { ...report, capability_map: capabilitySummary() });
  } else {
    printStatus(io, report);
    const summary = capabilitySummary();
    io.out(
      paint.gray(
        `  动词台账: schema=${summary.schemaVersion ?? "-"} ${summary.verbCount} 个动词 / ` +
          `${summary.capabilityCount} 类能力`,
      ),
    );
  }
  return report.exit_code;
}

async function runDoc(io: Io, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const result = await docInfo(contextOf(parsed, env));
  if (boolValue(parsed, "json")) {
    printJson(io, {
      channel: result.channel,
      attempts: result.attempts,
      doc_type: result.doc_type,
      doc_type_name: result.doc_type_name,
      uuid: result.uuid,
    });
  } else {
    printDoc(io, result);
    printAttempts(io, result.attempts);
  }
  return 0;
}

async function runBoard(io: Io, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const result = await readBoardState(contextOf(parsed, env), {
    outDir: stringValue(parsed, "out"),
    command: commandOf(["board"]),
    timeoutMs: secToMs(parsed),
  });
  if (boolValue(parsed, "json")) {
    printJson(io, {
      channel: result.channel,
      attempts: result.attempts,
      raw_doc_type: result.raw_doc_type,
      state: result.state,
      evidence: result.evidence?.folder ?? null,
    });
  } else {
    printBoard(io, result);
  }
  return 0;
}

async function runDrcAction(io: Io, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const result = await runDrc(contextOf(parsed, env), {
    outDir: stringValue(parsed, "out"),
    command: commandOf(["drc"]),
    timeoutMs: secToMs(parsed),
  });
  if (boolValue(parsed, "json")) {
    printJson(io, {
      channel: result.channel,
      attempts: result.attempts,
      total: result.total,
      categories: result.categories,
      drc: result.drc,
      drc_cat: result.drc_cat,
      drc_sub: result.drc_sub,
      cats: result.cats,
      readback: result.readback,
      data_trustworthy: result.data_trustworthy,
      evidence: result.evidence?.folder ?? null,
    });
  } else {
    printDrc(io, result);
  }
  return 0;
}

async function runDigest(io: Io, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const result = await boardDigestState(contextOf(parsed, env), {
    outDir: stringValue(parsed, "out"),
    command: commandOf(["digest"]),
    timeoutMs: secToMs(parsed),
    baseline: stringValue(parsed, "baseline"),
  });
  if (boolValue(parsed, "json")) {
    printJson(io, {
      channel: result.channel,
      attempts: result.attempts,
      digest: result.digest,
      comparison: result.comparison,
      evidence: result.evidence?.folder ?? null,
    });
  } else {
    printDigest(io, result);
  }
  return result.comparison?.verdict === "fail" ? 1 : 0;
}

async function runRoute(io: Io, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const nets = (stringValue(parsed, "nets") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (nets.length === 0) throw new CliUsageError("route 需要 --nets a,b（至少一个网络）");
  if (!boolValue(parsed, "confirm")) {
    if (boolValue(parsed, "json")) printJson(io, routeNetsPreview(nets));
    else printRoutePlan(io, nets);
    return 0;
  }
  const result = await routeNets(contextOf(parsed, env), {
    nets,
    confirm: true,
    outDir: stringValue(parsed, "out"),
    command: commandOf(["route", "--nets", nets.join(","), "--confirm"]),
    timeoutMs: secToMs(parsed),
  });
  if (boolValue(parsed, "json")) {
    printJson(io, {
      ok: result.ok,
      channel: result.channel,
      attempts: result.attempts,
      nets: result.nets,
      before: result.before,
      after: result.after,
      delta: result.delta,
      lines_added: result.lines_added,
      readback_ok: result.readback_ok,
      changed: result.changed,
      warning: result.warning ?? null,
      auto_route: result.auto_route,
      evidence: result.evidence?.folder ?? null,
    });
  } else {
    io.out(`  通道: ${result.channel}`);
    io.out(`  网络: ${result.nets.join(", ")}`);
    io.out(
      `  线数: before=${result.before ?? "null"} after=${result.after ?? "null"} delta=${result.delta ?? "null"}`,
    );
    io.out(`  回读: readback_ok=${result.readback_ok} changed=${result.changed}`);
    if (result.warning) io.err(`  警告: ${result.warning}`);
    printAttempts(io, result.attempts);
    if (result.evidence) io.out(`  证据包: ${result.evidence.folder}`);
  }
  return result.ok ? 0 : 1;
}

async function runEval(io: Io, parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<number> {
  const file = stringValue(parsed, "file");
  let code = stringValue(parsed, "code");
  if (file) {
    try {
      code = readFileSync(file, "utf8");
    } catch (error) {
      throw new CliUsageError(
        `读不了 ${file}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!code || code.trim() === "") throw new CliUsageError("eval 需要 --code 或 --file");
  if (!boolValue(parsed, "confirm")) {
    const preview = {
      verb: "eval_api",
      code_preview: code.length > 500 ? `${code.slice(0, 500)}…` : code,
      impact: "执行任意 JS，可能创建、修改或删除图元；代码由调用方负责。",
      rollback: "代码副作用没有统一回滚；写前另存工程或用撤销历史。",
      confirm_hint: "确认影响后加 --confirm 重新调用。",
    };
    if (boolValue(parsed, "json")) printJson(io, preview);
    else {
      io.out(`  动词: eval_api`);
      io.out(`  代码: ${preview.code_preview}`);
      io.out(`  影响: ${preview.impact}`);
      io.out(`  回滚: ${preview.rollback}`);
      io.out(paint.gray("  本次未加 --confirm，只打印计划，没有执行任何代码。"));
    }
    return 0;
  }
  const result = await evalApi(contextOf(parsed, env), {
    code,
    confirm: true,
    outDir: stringValue(parsed, "out"),
    command: commandOf(["eval", "--confirm"]),
    timeoutMs: secToMs(parsed),
  });
  if (boolValue(parsed, "json")) {
    printJson(io, {
      channel: result.channel,
      attempts: result.attempts,
      value: result.value,
      evidence: result.evidence?.folder ?? null,
    });
  } else {
    io.out(`  通道: ${result.channel}`);
    io.out(JSON.stringify(result.value, null, 2));
    printAttempts(io, result.attempts);
    if (result.evidence) io.out(`  证据包: ${result.evidence.folder}`);
  }
  return 0;
}

async function runLookup(io: Io, parsed: ParsedArgs): Promise<number> {
  const query = parsed.positionals.slice(1).join(" ").trim();
  if (query === "") throw new CliUsageError("lookup 需要一个查询词，如 read_board_state 或 DRC");
  const limit = numberValue(parsed, "limit");
  const result = lookupCapability(query, { limit });
  if (boolValue(parsed, "json")) {
    printJson(io, result);
  } else {
    io.out(`  查询: ${result.query}  命中 ${result.total} 个`);
    for (const hit of result.hits) {
      io.out("");
      io.out(`  ${hit.id}  [${hit.status ?? "-"}]  ${hit.capability ?? "-"}`);
      if (hit.intent) io.out(`    ${hit.intent}`);
      for (const route of hit.routes) {
        io.out(
          paint.gray(
            `    P${route.priority ?? "?"} ${route.channel ?? "degrade"}  ${route.entry ?? ""}`,
          ),
        );
      }
      for (const path of hit.menu_paths) io.out(paint.gray(`    菜单: ${path}`));
    }
    if (result.hint) io.out(paint.gray(`  ${result.hint}`));
  }
  return 0;
}

// ─── 入口 ─────────────────────────────────────────────────────────────

function reportError(io: Io, error: unknown, json: boolean): number {
  if (error instanceof EdaVerbError) {
    if (json) {
      printJson(io, {
        ok: false,
        error: error.code,
        message: error.message,
        exit_code: error.exitCode,
        details: error.details ?? null,
      });
    } else {
      io.err(paint.red(`  错误：${error.message}`));
      if (error.details !== undefined) {
        io.err(paint.gray(`  详情：${JSON.stringify(error.details)}`));
      }
    }
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    printJson(io, { ok: false, error: "EDA_ERROR", message, exit_code: 4 });
  } else {
    io.err(paint.red(`  错误：${message}`));
  }
  return 4;
}

export async function runEdaCommand(
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const tokens = argv[0] === "eda" ? argv.slice(1) : [...argv];
  const first = tokens[0]?.toLowerCase();
  if (tokens.length === 0 || first === "help" || first === "-h" || first === "--help") {
    printHelp(io);
    return 0;
  }
  if (!ACTIONS.includes(first ?? "")) {
    io.err(paint.red(`  不认识的 eda 动作：${first ?? "(空)"}（可选 ${ACTIONS.join(" / ")}）`));
    printHelp(io);
    return 1;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(tokens, OPTIONS);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(paint.red(`  ${error.message}`));
      printHelp(io);
      return 1;
    }
    throw error;
  }

  const action = first ?? "help";
  const extras = parsed.positionals.slice(1);
  if (action !== "lookup" && extras.length > 0) {
    io.err(paint.red(`  多余的参数：${extras.join(" ")}`));
    printHelp(io);
    return 1;
  }

  const json = boolValue(parsed, "json");
  try {
    switch (action) {
      case "status":
        return await runStatus(io, parsed, env);
      case "doc":
        return await runDoc(io, parsed, env);
      case "board":
        return await runBoard(io, parsed, env);
      case "drc":
        return await runDrcAction(io, parsed, env);
      case "digest":
        return await runDigest(io, parsed, env);
      case "route":
        return await runRoute(io, parsed, env);
      case "eval":
        return await runEval(io, parsed, env);
      case "lookup":
        return await runLookup(io, parsed);
      default:
        printHelp(io);
        return 0;
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.err(paint.red(`  ${error.message}`));
      printHelp(io);
      return 1;
    }
    return reportError(io, error, json);
  }
}
