import { z } from "zod";

import {
  ToolError,
  defineTool,
  requireConfirm,
  type ToolContext,
  type ToolDef,
} from "../mcp/types.ts";
import { Board, detectState, normalizeState } from "./board.ts";
import {
  attributionOf,
  discover,
  endpointUrl,
  parsePortRange,
  resolveEndpoint,
  versionBrowser,
  versionWebSocketUrl,
  type DiscoverResult,
} from "./discover.ts";
import { activeDocument, listDocuments, openDocument } from "./docs.ts";
import { evaluateInContext, planEval } from "./eval.ts";
import { sendCdpInput } from "./input.ts";
import { cdpInputActionSchema } from "./inputSchema.ts";
import { redact } from "./redact.ts";
import { screenshotToFile } from "./screenshot.ts";
import { classifyEval } from "./sideEffects.ts";
import { listTargets } from "./targets.ts";
import { asCdpError } from "./errors.ts";

/**
 * CDP 连接层的 MCP 工具。
 *
 * 前置条件（每个工具的描述里都写了）：客户端必须用 `lceda-connect cdp start`
 * 带 `--remote-debugging-port` 启动；已运行的实例无法事后追加调试端口。
 * 只连回环地址，不读 cookie / 凭据。
 */

const HOST = "127.0.0.1";

/** 把任意领域异常转成 ToolError（保留 code / details）。 */
function fail(error: unknown): never {
  if (error instanceof ToolError) throw error;
  const cdpError = asCdpError(error);
  throw new ToolError(cdpError.code, cdpError.message, cdpError.details);
}

function portArg(args: { port?: number }, ctx: ToolContext): number | undefined {
  return args.port ?? ctx.cfg.cdp.port;
}

function requireEndpoint(endpoint: DiscoverResult | null, fallback: string): DiscoverResult {
  if (!endpoint) {
    throw new ToolError(
      "CDP_NOT_FOUND",
      `没有可用的 CDP 端点（${fallback}）。先跑 cdp_discover；` +
        "若客户端不是用 `lceda-connect cdp start` 启动的，请彻底退出后重新带调试端口启动。",
    );
  }
  return endpoint;
}

async function openBoard(
  ctx: ToolContext,
  options: {
    port?: number;
    match?: string;
    index?: number;
    docType?: string | readonly string[] | null;
  },
): Promise<Board> {
  return await Board.open({
    host: HOST,
    port: options.port ?? ctx.cfg.cdp.port,
    match: options.match,
    index: options.index,
    docType: options.docType ?? null,
    env: ctx.env,
    signal: ctx.signal,
  });
}

function discoverView(item: DiscoverResult): Record<string, unknown> {
  return {
    port: item.port,
    source: item.source,
    profile: item.profile,
    cdp: item.cdp,
    uuidMatch: item.uuidMatch,
    browser: redact(versionBrowser(item.version)) || null,
    attribution: attributionOf(item),
    version: versionView(item.version),
  };
}

function versionView(version: unknown): Record<string, unknown> | null {
  if (version === null || typeof version !== "object" || Array.isArray(version)) return null;
  const record = version as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const field of [
    "Browser",
    "Protocol-Version",
    "User-Agent",
    "V8-Version",
    "webSocketDebuggerUrl",
  ]) {
    if (typeof record[field] === "string") output[field] = redact(record[field]);
  }
  return output;
}

const PORT_FIELD = z
  .number()
  .int()
  .min(1)
  .max(65535)
  .optional()
  .describe("CDP 调试端口；省略时先读 profile 的 DevToolsActivePort，再试配置端口");

const MATCH_FIELD = z
  .string()
  .optional()
  .describe("窗口标题或 URL 的子串，用于在多窗口里选一个 page；命中不唯一会报错停手");

export const cdpDiscoverTool = defineTool({
  name: "cdp_discover",
  description:
    "发现并验证本机立创EDA专业版的 CDP 端点（只读）。前置条件：客户端必须用 " +
    "`lceda-connect cdp start` 带调试端口启动（已运行的实例无法事后追加端口）。" +
    "判定标准是 /json/version 同时返回 Browser 与 Protocol-Version；" +
    "uuidMatch 表示 profile 端口文件里的 browser uuid 与当前实例是否一致，优先使用 uuid 匹配的端点。" +
    "没有任何可用端点时返回 CDP_NOT_FOUND 错误，details 里带各候选端口的诊断明细。",
  input: {
    port: PORT_FIELD,
    scan: z.string().optional().describe("附加扫描的端口区间，形如 9200-9300（一般不需要）"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    try {
      const output = await discover(HOST, {
        port: portArg(args, ctx),
        scan: parseScan(args.scan),
        env: ctx.env,
        signal: ctx.signal,
      });
      const best = output.usable[0] ?? null;
      if (!best) {
        throw new ToolError(
          "CDP_NOT_FOUND",
          "候选端口都不响应 /json/version：不像 CDP，或端口文件已经过期。" +
            "请确认客户端是用 `lceda-connect cdp start` 带调试端口启动的。",
          { livePorts: output.livePorts, results: output.results.map(discoverView) },
        );
      }
      return {
        found: true,
        endpoint: endpointUrl(HOST, best.port),
        browser: redact(versionBrowser(best.version)) || null,
        webSocketDebuggerUrl: redact(versionWebSocketUrl(best.version)) || null,
        livePorts: output.livePorts,
        results: output.results.map(discoverView),
      };
    } catch (error) {
      fail(error);
    }
  },
});

function targetView(target: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of ["id", "type", "title", "url", "webSocketDebuggerUrl"]) {
    if (typeof target[field] === "string") output[field] = redact(target[field]);
  }
  return output;
}

export const cdpTargetsTool = defineTool({
  name: "cdp_targets",
  description:
    "列出本机立创EDA专业版的 CDP target（page / iframe / worker / service_worker），只读。" +
    "前置条件：客户端用 `lceda-connect cdp start` 启动。标题与 URL 已脱敏（账号字段替换为 <REDACTED>）。" +
    "编辑器不是独立 target：PCB / 原理图是主页面里的 iframe，看结构请用 cdp_eval 的 ui 上下文配合 DOM 读取。",
  input: { port: PORT_FIELD },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    try {
      const endpoint = requireEndpoint(
        await resolveEndpoint(HOST, {
          port: portArg(args, ctx),
          env: ctx.env,
          signal: ctx.signal,
        }),
        "端口自动发现失败",
      );
      const targets = await listTargets(HOST, endpoint.port, undefined, ctx.signal);
      return {
        port: endpoint.port,
        endpoint: endpointUrl(HOST, endpoint.port),
        browser: versionBrowser(endpoint.version) || null,
        targets: targets.map((target) => {
          const view = targetView(target);
          if (typeof view.title === "string") view.title = redact(view.title);
          return view;
        }),
      };
    } catch (error) {
      fail(error);
    }
  },
});

export const cdpEvalTool = defineTool({
  name: "cdp_eval",
  description:
    "在立创EDA专业版的页面里执行 JavaScript 并返回结果（默认拒绝有副作用的表达式）。" +
    "前置条件：客户端用 `lceda-connect cdp start` 启动。" +
    "context=api（默认）：表达式作为 async 函数体执行，已注入 A = globalThis._EXTAPI_ROOT_，" +
    "读编辑器 API 时写 `return await A.pcb_Net.getAllNets()`；选页按 PCB 文档类型过滤。" +
    "context=ui：表达式原样求值，不注入 A、不按文档类型过滤，适合读顶层 UI DOM" +
    "（弹窗、右键菜单、工具栏）；执行前会先做顶层 UI 判据，命中 iframe/空白页直接报错。" +
    "无法证明只读时必须显式 confirm: true；allowSideEffects: true 是已弃用兼容别名。" +
    "选页命中数不等于 1 时报错，不会静默取第一个。",
  input: {
    expression: z.string().min(1).describe("要执行的 JavaScript 表达式或函数体"),
    context: z.enum(["api", "ui"]).optional().describe("求值上下文：api（默认）或 ui"),
    match: MATCH_FIELD,
    index: z.number().int().min(0).optional().describe("显式 page 序号；给了就不做唯一性断言"),
    allowSideEffects: z.boolean().optional().describe("已弃用：confirm 的兼容别名"),
    confirm: z.boolean().optional().describe("确认可能有副作用的表达式并允许执行"),
    port: PORT_FIELD,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    try {
      const context = args.context ?? "api";
      const classification = classifyEval(args.expression);
      const confirmed = args.confirm ?? args.allowSideEffects;
      if (!classification.readonly) {
        requireConfirm(confirmed, {
          expression_preview:
            args.expression.length > 500 ? `${args.expression.slice(0, 500)}…` : args.expression,
          reasons: classification.reasons,
          hint: "确认影响并以 confirm: true 重新调用；allowSideEffects 是已弃用兼容别名。",
        });
      }
      const plan = planEval(
        context === "ui"
          ? { context, expression: args.expression }
          : { context, apiBody: args.expression },
      );
      const board = await openBoard(ctx, {
        port: args.port,
        match: args.match,
        index: args.index,
        docType: plan.wantDocType,
      });
      try {
        const outcome = await evaluateInContext(board.session, plan, ctx.signal);
        return {
          context,
          page: board.title,
          port: board.port,
          value: outcome.value,
          type: outcome.type ?? null,
        };
      } finally {
        board.close();
      }
    } catch (error) {
      fail(error);
    }
  },
});

export const cdpScreenshotTool = defineTool({
  name: "cdp_screenshot",
  description:
    "截取立创EDA专业版当前页面可视区并保存为 PNG（写文件，不改设计数据）。" +
    "前置条件：客户端用 `lceda-connect cdp start` 启动。" +
    "可选 fit 先缩放到板框、hideLayers 临时隐藏层（截完自动恢复）。" +
    "截图可能含账号、工程名、器件编号，外发前请自行确认。选页命中数不等于 1 时报错。",
  input: {
    outPath: z.string().min(1).describe("PNG 输出路径（必填；相对路径按当前工作目录解析）"),
    fit: z.boolean().optional().describe("截图前缩放到板框（PCB 文档）"),
    hideLayers: z
      .array(z.number().int().min(0))
      .optional()
      .describe("截前临时隐藏的层 id；截完自动恢复"),
    match: MATCH_FIELD,
    index: z.number().int().min(0).optional().describe("显式 page 序号"),
    port: PORT_FIELD,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, ctx) => {
    try {
      const outputPath = await ctx.resolveWritePath(args.outPath);
      const board = await openBoard(ctx, {
        port: args.port,
        match: args.match,
        index: args.index,
      });
      try {
        const result = await screenshotToFile(board.session, outputPath, {
          fit: args.fit,
          hideLayers: args.hideLayers,
        });
        return { ...result, page: board.title, port: board.port };
      } finally {
        board.close();
      }
    } catch (error) {
      fail(error);
    }
  },
});

export const cdpDocListTool = defineTool({
  name: "cdp_doc_list",
  description:
    "列出当前工程内可打开的 PCB 与原理图页（含 uuid），只读。前置条件：客户端用 " +
    "`lceda-connect cdp start` 启动，且已打开一个工程。走编辑器 API，不用坐标点击。",
  input: { match: MATCH_FIELD, port: PORT_FIELD },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    try {
      const board = await openBoard(ctx, { port: args.port, match: args.match });
      try {
        const listed = await listDocuments(board);
        return { page: board.title, port: board.port, ...listed };
      } finally {
        board.close();
      }
    } catch (error) {
      fail(error);
    }
  },
});

export const cdpDocActiveTool = defineTool({
  name: "cdp_doc_active",
  description:
    "读取当前拥有输入焦点的文档（PCB / 原理图页），只读。前置条件：客户端用 " +
    "`lceda-connect cdp start` 启动。按焦点接口判定，via 字段说明是哪条接口给出的答案；" +
    "没有活动文档时 kind=none。",
  input: { match: MATCH_FIELD, port: PORT_FIELD },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    try {
      const board = await openBoard(ctx, { port: args.port, match: args.match });
      try {
        const active = await activeDocument(board);
        return { page: board.title, port: board.port, active };
      } finally {
        board.close();
      }
    } catch (error) {
      fail(error);
    }
  },
});

export const cdpDocOpenTool = defineTool({
  name: "cdp_doc_open",
  description:
    "按名字或 uuid 打开工程内文档并切换焦点（不改设计数据）。前置条件：客户端用 " +
    "`lceda-connect cdp start` 启动，且已打开一个工程。name 与 uuid 必须且只能给一个；" +
    "同名多义会报错并列出候选。openDocument 只建标签页，activateDocument 才换焦点，" +
    "因此默认会激活并回读 active_after 校验：焦点没落到目标文档就报 DOC_FOCUS_MISMATCH。" +
    "waitForDocumentReady 在 V4.1.78 恒为 false（alpha 接口），ready.note 会说明，不要把 ready:false 当失败。",
  input: {
    name: z.string().optional().describe("文档名（PCB 名或原理图页名），与 uuid 二选一"),
    uuid: z.string().optional().describe("文档 UUID，与 name 二选一"),
    kind: z.enum(["pcb", "sch", "auto"]).optional().describe("限定文档类型，默认 auto"),
    activate: z.boolean().optional().describe("打开后是否切换焦点，默认 true"),
    wait: z.boolean().optional().describe("激活后是否等就绪，默认 true"),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .max(300_000)
      .optional()
      .describe("就绪等待毫秒数，默认 30000"),
    match: MATCH_FIELD,
    port: PORT_FIELD,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, ctx) => {
    try {
      // 先做参数校验，避免为了一个用法错误去连客户端
      if (Boolean(args.name) === Boolean(args.uuid)) {
        throw new ToolError("DOC_USAGE", "需要 name 或 uuid 且只能给一个");
      }
      const board = await openBoard(ctx, { port: args.port, match: args.match });
      try {
        const opened = await openDocument(board, {
          name: args.name,
          uuid: args.uuid,
          kind: args.kind,
          activate: args.activate,
          wait: args.wait,
          timeoutMs: args.timeoutMs,
        });
        return { page: board.title, port: board.port, ...opened };
      } finally {
        board.close();
      }
    } catch (error) {
      fail(error);
    }
  },
});

export const cdpUiStateTool = defineTool({
  name: "cdp_ui_state",
  description:
    "只读读取编辑器状态：是否处于历史预览态、是否有可见模态对话框、当前工程与文档类型，" +
    "并给出 writable / blocked 结论（历史预览态或模态框存在时写操作会静默失败，必须先处理）。" +
    "前置条件：客户端用 `lceda-connect cdp start` 启动。modal 项带可点句柄；blocked 文案分成" +
    "「安全关闭」与「提交类（勿点）」两栏，不要把提交类按钮当关闭用。",
  input: {
    match: MATCH_FIELD,
    index: z.number().int().min(0).optional().describe("显式 page 序号"),
    port: PORT_FIELD,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    try {
      const board = await openBoard(ctx, {
        port: args.port,
        match: args.match,
        index: args.index,
      });
      try {
        const state = normalizeState(await detectState(board));
        return { page: board.title, port: board.port, state };
      } finally {
        board.close();
      }
    } catch (error) {
      fail(error);
    }
  },
});

export const cdpInputTool = defineTool({
  name: "cdp_input",
  description:
    "向本机指定 PCB 页面派发一次鼠标点击、有限按键或文本，不启动客户端或拉前台。" +
    "仅在编辑器 API 不适用时使用；必须确认并指定端口、精确 target 和当前 PCB UUID。" +
    "结果仅代表 CDP 确认，须另行回读实际效果；结果不确定时不要自动重试。",
  input: {
    port: z.number().int().min(1).max(65535),
    target: z.string().min(1).max(128).describe("cdp_targets 返回的精确页面 target ID"),
    documentUuid: z.string().min(1).max(128).describe("预期的当前 PCB 文档 UUID"),
    action: cdpInputActionSchema,
    confirm: z.boolean().optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, ctx) => {
    try {
      return await sendCdpInput(args, { signal: ctx.signal });
    } catch (error) {
      fail(error);
    }
  },
});

function parseScan(value: string | undefined): readonly [number, number] | undefined {
  if (!value) return undefined;
  const range = parsePortRange(value);
  if (!range) {
    throw new ToolError("INVALID_SCAN", `端口区间格式应为 LOW-HIGH，收到 ${JSON.stringify(value)}`);
  }
  return range;
}

/** 注册到 MCP 注册表的全部 CDP 工具。 */
export const cdpTools: ToolDef[] = [
  cdpDiscoverTool,
  cdpTargetsTool,
  cdpEvalTool,
  cdpScreenshotTool,
  cdpDocListTool,
  cdpDocActiveTool,
  cdpDocOpenTool,
  cdpUiStateTool,
  cdpInputTool,
];
