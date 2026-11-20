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
import type { Io } from "../core/io.ts";
import { hr, paint } from "../core/term.ts";
import { Board } from "./board.ts";
import {
  DEFAULT_CDP_HOST,
  attributionOf,
  defaultPortFromEnv,
  discover,
  endpointUrl,
  parsePortRange,
  profileLabel,
  requireLoopbackHost,
  resolveEndpoint,
  versionBrowser,
  versionWebSocketUrl,
} from "./discover.ts";
import { activeDocument, listDocuments, openDocument } from "./docs.ts";
import { asCdpError, CdpError } from "./errors.ts";
import { EvalUsageError, evaluateInContext, planEval, type EvalContext } from "./eval.ts";
import { sendCdpInput } from "./input.ts";
import { cdpInputActionSchema } from "./inputSchema.ts";
import { pickPage } from "./pickPage.ts";
import { redact } from "./redact.ts";
import { screenshotToFile } from "./screenshot.ts";
import { CdpSession } from "./session.ts";
import { firstSideEffectPattern, hasSideEffects } from "./sideEffects.ts";
import { fetchFrameTree, flattenFrameTree, formatFrameTree, listTargets } from "./targets.ts";

/**
 * `lceda-connect cdp-client <动作>` 的实现（源仓库 lceda_cdp.py 的 CLI 部分）。
 *
 * 动作：discover / targets / frames / eval / shot / docs / input。
 * 只连回环地址；`eval` 默认拒绝有副作用的表达式。退出码沿用源仓库口径：
 * 0 成功 / 1 未找到或用法 / 2 端点或选页失败 / 3 拒绝（副作用、非回环）/ 4 协议错误。
 */

const COMMON_OPTIONS: readonly OptionSpec[] = [
  { name: "json", type: "boolean", description: "以 JSON 输出（给脚本 / Agent 用）" },
  {
    name: "host",
    type: "string",
    placeholder: "HOST",
    description: "CDP 主机（只允许回环地址，默认 127.0.0.1）",
  },
  {
    name: "port",
    type: "number",
    placeholder: "PORT",
    description: "CDP 端口；省略则自动发现（读 DevToolsActivePort）",
  },
  {
    name: "match",
    type: "string",
    placeholder: "TEXT",
    description: "按窗口标题 / URL 子串选页；命中不唯一会报错停手",
  },
  {
    name: "index",
    type: "number",
    placeholder: "N",
    description: "显式 page 序号（跳过唯一性断言，越界仍报错）",
  },
];

const DISCOVER_OPTIONS: readonly OptionSpec[] = [
  {
    name: "scan",
    type: "string",
    placeholder: "LOW-HIGH",
    description: "附加扫描的端口区间，如 9200-9300",
  },
];

const EVAL_OPTIONS: readonly OptionSpec[] = [
  {
    name: "expr",
    type: "string",
    placeholder: "JS",
    description: "原样求值的表达式；--context ui 必填",
  },
  {
    name: "api",
    type: "string",
    placeholder: "BODY",
    description: "扩展 API 上下文的 async 函数体（自动注入 A = _EXTAPI_ROOT_）",
  },
  {
    name: "context",
    type: "string",
    placeholder: "api|ui",
    description: "求值上下文，默认 api",
  },
  {
    name: "allow-side-effects",
    type: "boolean",
    description: "确认表达式有副作用并允许执行",
  },
];

const SHOT_OPTIONS: readonly OptionSpec[] = [
  { name: "out", type: "string", placeholder: "PATH", description: "PNG 输出路径（必填）" },
  { name: "fit", type: "boolean", description: "截图前缩放到板框" },
  {
    name: "hide",
    type: "string",
    placeholder: "IDS",
    description: "临时隐藏的层 id，逗号分隔；截完自动恢复",
  },
];

const DOC_OPTIONS: readonly OptionSpec[] = [
  { name: "name", type: "string", placeholder: "NAME", description: "文档名（与 --uuid 二选一）" },
  {
    name: "uuid",
    type: "string",
    placeholder: "UUID",
    description: "文档 UUID（与 --name 二选一）",
  },
  {
    name: "kind",
    type: "string",
    placeholder: "pcb|sch|auto",
    description: "限定文档类型，默认 auto",
  },
  {
    name: "no-activate",
    type: "boolean",
    description: "只打开标签页，不切换焦点（也不回读 active_after）",
  },
  { name: "no-wait", type: "boolean", description: "跳过就绪等待" },
  {
    name: "timeout",
    type: "number",
    placeholder: "SEC",
    description: "就绪等待秒数，默认 30",
  },
];

const ALL_OPTIONS: readonly OptionSpec[] = [
  ...COMMON_OPTIONS,
  ...DISCOVER_OPTIONS,
  ...EVAL_OPTIONS,
  ...SHOT_OPTIONS,
  ...DOC_OPTIONS,
];

const ACTIONS: readonly string[] = [
  "discover",
  "targets",
  "frames",
  "eval",
  "shot",
  "docs",
  "input",
];

const INPUT_OPTIONS: readonly OptionSpec[] = [
  {
    name: "port",
    type: "string",
    placeholder: "PORT",
    description: "本机调试端口（必填，不自动发现）",
  },
  { name: "target", type: "string", placeholder: "ID", description: "精确 page target ID（必填）" },
  {
    name: "document",
    type: "string",
    placeholder: "UUID",
    description: "当前 PCB 文档 UUID（必填）",
  },
  { name: "confirm", type: "boolean", description: "确认派发到指定 PCB 页面，可能改动工程" },
  { name: "x", type: "string", placeholder: "X", description: "顶层页面视口 CSS 像素坐标" },
  { name: "y", type: "string", placeholder: "Y", description: "顶层页面视口 CSS 像素坐标" },
  { name: "button", type: "string", placeholder: "left|right", description: "鼠标键（默认 left）" },
  { name: "click-count", type: "string", placeholder: "1|2", description: "点击次数（默认 1）" },
  {
    name: "key",
    type: "string",
    placeholder: "KEY",
    description: "Escape / Enter / Tab / ArrowUp / ArrowDown / ArrowLeft / ArrowRight / Backspace",
  },
  {
    name: "text",
    type: "string",
    placeholder: "TEXT",
    description: "插入到当前获得焦点的可编辑控件",
  },
  { name: "json", type: "boolean", description: "以 JSON 输出" },
];

const INPUT_ACTION_OPTIONS = {
  click: ["x", "y", "button", "click-count"],
  key: ["key"],
  text: ["text"],
} as const;
const INPUT_COMMON = new Set(["port", "target", "document", "confirm", "json"]);

function inputHelp(io: Io): void {
  io.out(
    "用法: lceda-connect cdp input <click|key|text> --port PORT --target ID --document UUID --confirm [选项]",
  );
  io.out("仅向指定 PCB 页面派发；不会启动客户端、拉前台或使用系统键鼠。响应只确认 CDP 收到事件。");
  for (const line of formatOptions(INPUT_OPTIONS)) io.out(line);
}

async function cmdInput(argv: readonly string[], io: Io): Promise<number> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    inputHelp(io);
    return 0;
  }
  let json = false;
  try {
    const parsed = parseArgs(argv, INPUT_OPTIONS);
    json = boolValue(parsed, "json");
    const kind = parsed.positionals[0];
    if (
      parsed.positionals.length !== 1 ||
      (kind !== "click" && kind !== "key" && kind !== "text")
    ) {
      throw new CliUsageError("input 需要且只接受一个动作：click / key / text");
    }
    const allowed: readonly string[] = INPUT_ACTION_OPTIONS[kind];
    for (const flag of Object.keys(parsed.values)) {
      if (!INPUT_COMMON.has(flag) && !allowed.includes(flag)) {
        throw new CliUsageError(`input ${kind} 不接受 --${flag}`);
      }
    }
    const port = stringValue(parsed, "port");
    const target = stringValue(parsed, "target");
    const documentUuid = stringValue(parsed, "document");
    if (!port || !/^\d{1,5}$/.test(port) || !target || !documentUuid) {
      throw new CliUsageError("input 必须显式提供 --port（整数）、--target 和 --document");
    }
    const decimal = (name: string): number => {
      const value = stringValue(parsed, name);
      return value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    };
    const count = stringValue(parsed, "click-count");
    const action = cdpInputActionSchema.safeParse(
      kind === "click"
        ? {
            kind,
            x: decimal("x"),
            y: decimal("y"),
            button: stringValue(parsed, "button"),
            clickCount:
              count === undefined ? undefined : count === "1" ? 1 : count === "2" ? 2 : NaN,
          }
        : kind === "key"
          ? { kind, key: stringValue(parsed, "key") }
          : { kind, text: stringValue(parsed, "text") },
    );
    if (!action.success) throw new CliUsageError("input 动作参数不合法；请查看 cdp input --help");
    const result = await sendCdpInput({
      port: Number(port),
      target,
      documentUuid,
      confirm: boolValue(parsed, "confirm"),
      action: action.data,
    });
    if (json) emitJson(io, { ok: true, ...result });
    else io.out(`CDP 已确认 ${result.dispatched} 个事件；请另行回读编辑器操作结果。`);
    return 0;
  } catch (error) {
    return reportError(
      io,
      error instanceof CliUsageError
        ? new CdpError("CDP_INPUT_INVALID", error.message, { exitCode: 1 })
        : error,
      json,
    );
  }
}

export function cdpClientHelp(): string[] {
  return [
    "",
    paint.cyan("  lceda-connect cdp-client  --  接管本机立创EDA专业版（Chrome DevTools 协议）"),
    paint.gray(`  ${hr()}`),
    "  用法: lceda-connect cdp-client <动作> [选项]",
    "",
    paint.white("  动作:"),
    "    discover    发现并验证 CDP 端点（uuid 归属）",
    "    targets     列出 page / iframe / worker target",
    "    frames      列出页面的 iframe 结构",
    "    eval        在页面里执行 JS（默认只读）",
    "    shot        截取当前页面可视区",
    "    docs        文档列表 / 当前文档 / 打开文档",
    "    input       向指定 PCB 页面派发输入（input --help）",
    "    help        这个帮助",
    "",
    paint.white("  通用选项:"),
    ...formatOptions(COMMON_OPTIONS),
    "",
    paint.white("  discover 选项:"),
    ...formatOptions(DISCOVER_OPTIONS),
    "",
    paint.white("  eval 选项:"),
    ...formatOptions(EVAL_OPTIONS),
    "",
    paint.white("  shot 选项:"),
    ...formatOptions(SHOT_OPTIONS),
    "",
    paint.white("  docs 选项:"),
    "    docs list     列出可打开的 PCB / 原理图页（默认）",
    "    docs active   读当前活动文档",
    "    docs open     打开并激活文档（--name 或 --uuid）",
    ...formatOptions(DOC_OPTIONS),
    "",
    paint.white("  例子:"),
    "    lceda-connect cdp-client discover",
    "    lceda-connect cdp-client targets --json",
    '    lceda-connect cdp-client eval --expr "document.title" --json',
    "    lceda-connect cdp-client eval --context ui --expr \"document.querySelectorAll('[class*=lc_modal]').length\"",
    '    lceda-connect cdp-client eval --api "return await A.pcb_Layer.getCurrentLayer()"',
    "    lceda-connect cdp-client shot --out page.png --fit",
    "    lceda-connect cdp-client docs open --name PCB1",
    "",
    paint.gray(
      "  前置条件: 客户端必须用 `lceda-connect cdp start` 带调试端口启动；已运行实例无法事后追加端口。",
    ),
    paint.gray("  退出码: 0 成功 / 1 未找到或用法 / 2 端点或选页失败 / 3 拒绝 / 4 协议错误"),
    "",
  ];
}

function printHelp(io: Io): void {
  for (const line of cdpClientHelp()) io.out(line);
}

function emitJson(io: Io, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

function reportError(io: Io, error: unknown, json: boolean): number {
  const cdpError = asCdpError(error);
  if (json) {
    emitJson(io, {
      ok: false,
      error: cdpError.code,
      message: cdpError.message,
      details: cdpError.details ?? null,
    });
  } else {
    io.err(paint.red(`  错误：${cdpError.message}`));
  }
  return cdpError.exitCode;
}

function usageError(io: Io, message: string): number {
  io.err(paint.red(`  ${message}`));
  printHelp(io);
  return 1;
}

function evalContextOf(value: string | undefined): EvalContext | undefined {
  if (value === undefined) return undefined;
  if (value === "api" || value === "ui") return value;
  throw new EvalUsageError(`不认识的求值上下文：${value}（可选 api / ui）`);
}

function scanRangeOf(value: string | undefined): readonly [number, number] | undefined {
  if (value === undefined) return undefined;
  const range = parsePortRange(value);
  if (!range) throw new CliUsageError(`端口区间格式应为 LOW-HIGH，收到 "${value}"`);
  return range;
}

function hideLayersOf(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => {
      const parsed = Number.parseInt(item, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new CliUsageError(`层 id 必须是非负整数，收到 "${item}"`);
      }
      return parsed;
    });
}

// ─── 各动作 ──────────────────────────────────────────────────────────

async function cmdDiscover(
  parsed: ParsedArgs,
  io: Io,
  host: string,
  port: number | undefined,
  env: NodeJS.ProcessEnv,
  json: boolean,
): Promise<number> {
  const output = await discover(host, {
    port,
    scan: scanRangeOf(stringValue(parsed, "scan")),
    env,
  });
  const best = output.usable[0] ?? null;
  if (json) {
    emitJson(io, {
      found: best !== null,
      endpoint: best ? endpointUrl(host, best.port) : null,
      webSocketDebuggerUrl: best ? redact(versionWebSocketUrl(best.version)) || null : null,
      browser: best ? versionBrowser(best.version) || null : null,
      livePorts: output.livePorts,
      results: output.results,
    });
    return best ? 0 : 2;
  }

  if (output.results.length === 0) {
    io.out("没有找到 DevToolsActivePort，也没有候选端口。");
    io.out("客户端多半没有用 --remote-debugging-port 启动。");
    return 2;
  }

  for (const item of output.results) {
    const browser = versionBrowser(item.version) || "-";
    const mark = item.cdp && item.uuidMatch === true ? "HIT " : item.cdp ? "LIVE" : "DEAD";
    let line = `${mark} port=${String(item.port).padEnd(6)}${browser}`;
    if (item.profile) line += `  profile=${profileLabel(item.profile)}`;
    line += `  ${attributionOf(item)}`;
    io.out(line);
  }

  if (output.livePorts.length > 1) {
    io.out("");
    io.out(`注意：同时有 ${output.livePorts.length} 个端口在响应 CDP：`);
    io.out(`      ${output.livePorts.join(", ")}`);
    io.out("      确认你要连的是哪一个，必要时用 --port 指定。");
  }

  if (!best) {
    io.out("");
    io.out("候选端口都不响应 /json/version：不像 CDP，或端口文件已经过期。");
    return 2;
  }

  io.out("");
  io.out(`endpoint  : ${endpointUrl(host, best.port)}`);
  if (best.profile) io.out(`profile   : ${best.profile}`);
  io.out(`websocket : ${redact(versionWebSocketUrl(best.version))}`);
  return 0;
}

async function cmdTargets(
  io: Io,
  host: string,
  port: number | undefined,
  json: boolean,
): Promise<number> {
  const endpoint = await resolveEndpoint(host, { port });
  if (!endpoint) {
    throw new CdpError("CDP_NOT_FOUND", "没有可用的 CDP 端点，先跑 discover。", { exitCode: 2 });
  }
  const targets = await listTargets(host, endpoint.port);
  if (json) {
    emitJson(io, {
      port: endpoint.port,
      targets: targets.map((target) => ({
        ...target,
        title: redact(String(target.title ?? "")),
        url: redact(String(target.url ?? "")),
      })),
    });
    return 0;
  }
  io.out(`endpoint: ${endpointUrl(host, endpoint.port)}`);
  io.out(`targets : ${targets.length}`);
  targets.forEach((target, index) => {
    io.out("");
    io.out(`[${index}] ${String(target.type ?? "")}`);
    io.out(`    title: ${redact(String(target.title ?? ""))}`);
    io.out(`    url  : ${redact(String(target.url ?? ""))}`);
    io.out(`    id   : ${String(target.id ?? "")}`);
  });
  return 0;
}

async function cmdFrames(
  parsed: ParsedArgs,
  io: Io,
  host: string,
  port: number | undefined,
  json: boolean,
): Promise<number> {
  const endpoint = await resolveEndpoint(host, { port });
  if (!endpoint) {
    throw new CdpError("CDP_NOT_FOUND", "没有可用的 CDP 端点，先跑 discover。", { exitCode: 2 });
  }
  const targets = await listTargets(host, endpoint.port);
  const page = pickPage(targets, {
    match: stringValue(parsed, "match") ?? null,
    index: numberValue(parsed, "index") ?? null,
  });
  const session = await CdpSession.connect(
    typeof page.webSocketDebuggerUrl === "string" ? page.webSocketDebuggerUrl : "",
  );
  try {
    const tree = await fetchFrameTree(session);
    const rows = flattenFrameTree(tree);
    if (json) {
      emitJson(io, {
        port: endpoint.port,
        page: {
          title: redact(String(page.title ?? "")),
          url: redact(String(page.url ?? "")),
        },
        frames: rows.map((row) => ({ ...row, url: redact(row.url) })),
      });
      return 0;
    }
    io.out(`page: ${redact(String(page.title ?? ""))}`);
    for (const line of formatFrameTree(rows.map((row) => ({ ...row, url: redact(row.url) })))) {
      io.out(line);
    }
    return 0;
  } finally {
    session.close();
  }
}

async function cmdEval(
  parsed: ParsedArgs,
  io: Io,
  host: string,
  port: number | undefined,
  json: boolean,
): Promise<number> {
  const context = evalContextOf(stringValue(parsed, "context"));
  const expression = stringValue(parsed, "expr");
  const apiBody = stringValue(parsed, "api");
  const raw = expression ?? apiBody ?? "";
  if (hasSideEffects(raw) && !boolValue(parsed, "allow-side-effects")) {
    throw new CdpError(
      "SIDE_EFFECTS",
      `拒绝执行：表达式疑似有副作用（命中模式 ${firstSideEffectPattern(raw) ?? "未知"}）。` +
        "确认影响并取得用户同意后，加 --allow-side-effects 重试。",
      { exitCode: 3 },
    );
  }
  const plan = planEval({ context, expression, apiBody });

  const endpoint = await resolveEndpoint(host, { port });
  if (!endpoint) {
    throw new CdpError("CDP_NOT_FOUND", "没有可用的 CDP 端点，先跑 discover。", { exitCode: 2 });
  }
  const targets = await listTargets(host, endpoint.port);
  const page = pickPage(targets, {
    match: stringValue(parsed, "match") ?? null,
    index: numberValue(parsed, "index") ?? null,
    wantDocType: plan.wantDocType,
  });
  const session = await CdpSession.connect(
    typeof page.webSocketDebuggerUrl === "string" ? page.webSocketDebuggerUrl : "",
  );
  try {
    const outcome = await evaluateInContext(session, plan);
    if (json) {
      emitJson(io, {
        port: endpoint.port,
        page: redact(String(page.title ?? "")),
        context: plan.context,
        expression: plan.expression,
        value: outcome.value,
        type: outcome.type ?? null,
      });
      return 0;
    }
    io.out(`page: ${redact(String(page.title ?? ""))}`);
    io.out(`expr: ${plan.expression}`);
    const value =
      typeof outcome.value === "string"
        ? redact(outcome.value)
        : JSON.stringify(outcome.value, null, 2);
    io.out(`value: ${value}`);
    return 0;
  } finally {
    session.close();
  }
}

async function cmdShot(
  parsed: ParsedArgs,
  io: Io,
  host: string,
  port: number | undefined,
  json: boolean,
): Promise<number> {
  const outPath = stringValue(parsed, "out");
  if (!outPath) throw new CliUsageError("shot 需要 --out <PATH>");
  const hideLayers = hideLayersOf(stringValue(parsed, "hide"));

  const endpoint = await resolveEndpoint(host, { port });
  if (!endpoint) {
    throw new CdpError("CDP_NOT_FOUND", "没有可用的 CDP 端点，先跑 discover。", { exitCode: 2 });
  }
  const targets = await listTargets(host, endpoint.port);
  const page = pickPage(targets, {
    match: stringValue(parsed, "match") ?? null,
    index: numberValue(parsed, "index") ?? null,
  });
  const session = await CdpSession.connect(
    typeof page.webSocketDebuggerUrl === "string" ? page.webSocketDebuggerUrl : "",
  );
  try {
    const result = await screenshotToFile(session, outPath, {
      fit: boolValue(parsed, "fit"),
      hideLayers,
    });
    if (json) {
      emitJson(io, { port: endpoint.port, page: redact(String(page.title ?? "")), ...result });
      return 0;
    }
    io.out(`wrote ${result.path} (${result.bytes} bytes)`);
    io.out(
      `fit=${String(result.fit).toLowerCase()} hidden=${
        result.hidden.join(",") || "-"
      } restored=${String(result.restored).toLowerCase()}`,
    );
    io.out(`提醒：${result.warning}`);
    return 0;
  } finally {
    session.close();
  }
}

async function cmdDocs(
  rest: readonly string[],
  parsed: ParsedArgs,
  io: Io,
  host: string,
  port: number | undefined,
  env: NodeJS.ProcessEnv,
  json: boolean,
): Promise<number> {
  const sub = (rest[0] ?? "list").toLowerCase();
  if (rest.length > 1) return usageError(io, `docs 只接受一个子动作，收到：${rest.join(" ")}`);
  if (sub === "help") {
    printHelp(io);
    return 0;
  }
  if (!["list", "active", "open"].includes(sub)) {
    return usageError(io, `不认识的 docs 子动作：${sub}（可选 list / active / open）`);
  }

  const kindText = stringValue(parsed, "kind");
  if (kindText !== undefined && !["pcb", "sch", "auto"].includes(kindText)) {
    return usageError(io, `--kind 只能是 pcb / sch / auto，收到 ${kindText}`);
  }
  if (
    sub === "open" &&
    Boolean(stringValue(parsed, "name")) === Boolean(stringValue(parsed, "uuid"))
  ) {
    return usageError(io, "docs open 需要 --name 或 --uuid 且只能给一个");
  }

  const board = await Board.open({
    host,
    port,
    match: stringValue(parsed, "match"),
    env,
    docType: null,
  });
  try {
    if (sub === "list") {
      const listed = await listDocuments(board);
      if (json) {
        emitJson(io, { port: board.port, page: redact(board.title), ...listed });
        return 0;
      }
      io.out(`documents: ${listed.documents.length}`);
      for (const doc of listed.documents) {
        io.out(`  ${doc.kind}  ${doc.name ?? "?"}  ${doc.uuid}`);
      }
      for (const error of listed.errors ?? []) {
        io.err(`  警告：${error.scope} 列表读取失败：${error.message}`);
      }
      return 0;
    }

    if (sub === "active") {
      const active = await activeDocument(board);
      if (json) {
        emitJson(io, { port: board.port, page: redact(board.title), active });
        return 0;
      }
      if (active.kind === "none") {
        io.out("active: none（当前没有拥有焦点的 PCB / 原理图页）");
      } else {
        io.out(`active: ${active.kind} ${active.name ?? "?"} (${active.uuid ?? "?"})`);
        io.out(`via: ${active.via ?? "未知"}`);
      }
      return 0;
    }

    const timeoutSec = numberValue(parsed, "timeout");
    const opened = await openDocument(board, {
      name: stringValue(parsed, "name"),
      uuid: stringValue(parsed, "uuid"),
      kind: (kindText ?? "auto") as "pcb" | "sch" | "auto",
      activate: !boolValue(parsed, "no-activate"),
      wait: !boolValue(parsed, "no-wait"),
      timeoutMs: timeoutSec === undefined ? undefined : Math.max(0, timeoutSec) * 1000,
    });
    if (json) {
      emitJson(io, { port: board.port, page: redact(board.title), ...opened });
      return 0;
    }
    io.out(`opened: ${opened.kind} ${opened.name ?? "?"} (${opened.uuid}) tab=${opened.tab_id}`);
    io.out(`activated: ${String(opened.activated)}`);
    if (opened.ready) io.out(`ready: ${JSON.stringify(opened.ready)}`);
    if (opened.active_after) {
      io.out(
        `active_after: ${opened.active_after.kind} ${opened.active_after.name ?? "?"} ` +
          `(${opened.active_after.uuid ?? "?"})`,
      );
    }
    return 0;
  } finally {
    board.close();
  }
}

// ─── 入口 ────────────────────────────────────────────────────────────

export async function runCdpClientCommand(
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const first = argv[0]?.toLowerCase();
  if (first === "input") return await cmdInput(argv.slice(1), io);
  if (argv.length === 0 || first === "help" || first === "-h" || first === "--help") {
    printHelp(io);
    return 0;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv, ALL_OPTIONS);
  } catch (error) {
    if (error instanceof CliUsageError) return usageError(io, error.message);
    throw error;
  }

  const action = (parsed.positionals[0] ?? "").toLowerCase();
  const rest = parsed.positionals.slice(1);
  if (!ACTIONS.includes(action)) {
    return usageError(
      io,
      `不认识的 cdp-client 动作：${action || "(空)"}（可选 ${ACTIONS.join(" / ")}）`,
    );
  }
  if (action !== "docs" && rest.length > 0) {
    return usageError(io, `多余的参数：${rest.join(" ")}`);
  }

  const json = boolValue(parsed, "json");
  const host = stringValue(parsed, "host") ?? DEFAULT_CDP_HOST;
  const port = numberValue(parsed, "port") ?? defaultPortFromEnv(env);

  try {
    requireLoopbackHost(host);
    switch (action) {
      case "discover":
        return await cmdDiscover(parsed, io, host, port, env, json);
      case "targets":
        return await cmdTargets(io, host, port, json);
      case "frames":
        return await cmdFrames(parsed, io, host, port, json);
      case "eval":
        return await cmdEval(parsed, io, host, port, json);
      case "shot":
        return await cmdShot(parsed, io, host, port, json);
      default:
        return await cmdDocs(rest, parsed, io, host, port, env, json);
    }
  } catch (error) {
    if (error instanceof CliUsageError) return usageError(io, error.message);
    return reportError(io, error, json);
  }
}

// 保留给上层帮助排版用的导出（lead 在 main.ts 里接线时可直接复用）。
export { COMMON_OPTIONS, DOC_OPTIONS, EVAL_OPTIONS, SHOT_OPTIONS };
