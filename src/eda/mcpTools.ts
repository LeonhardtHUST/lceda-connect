import { z } from "zod";

import {
  ToolError,
  defineTool,
  requireConfirm,
  type ToolContext,
  type ToolDef,
} from "../mcp/types.ts";
import { capabilitySummary, lookupCapability } from "./capabilities.ts";
import { checkEnvironment } from "./channels.ts";
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
 * 编辑器动词层的 MCP 工具。
 *
 * 两条通道都从本机回环地址接入：bridge（官方扩展 API）优先，CDP（桌面调试协议）
 * 兜底。所有结论都来自回读：读板看 docType 与计数，DRC 看叶子指纹与双探针，
 * 自动布线看布线前后的线数。写操作没有 confirm 时只返回预演信息。
 */

function fail(error: unknown): never {
  if (error instanceof ToolError) throw error;
  if (error instanceof EdaVerbError) {
    throw new ToolError(error.code, error.message, error.details);
  }
  const code = (error as { code?: unknown } | null)?.code;
  const details = (error as { details?: unknown } | null)?.details;
  throw new ToolError(
    typeof code === "string" ? code : "EDA_ERROR",
    error instanceof Error ? error.message : String(error),
    details,
  );
}

interface CommonArgs {
  match?: string;
  windowId?: string;
  timeoutMs?: number;
}

/** 用 AppConfig 的端口区间与 CDP 端口组装执行上下文。 */
function execContext(args: CommonArgs, ctx: ToolContext): ExecContext {
  return createDefaultExecContext({
    env: ctx.env,
    cdpPort: ctx.cfg.cdp.port,
    bridgePortFirst: ctx.cfg.bridge.portFirst,
    bridgePortLast: ctx.cfg.bridge.portLast,
    match: args.match,
    windowId: args.windowId,
    timeoutMs: args.timeoutMs,
    signal: ctx.signal,
  });
}

const MATCH_FIELD = z
  .string()
  .optional()
  .describe("CDP 选页用的窗口标题 / URL 子串；多窗口时命中不唯一会报错停手");

const WINDOW_FIELD = z
  .string()
  .optional()
  .describe("bridge 目标窗口 id；省略时按文档类型自动挑（PCB 动词）或用当前激活窗口");

const TIMEOUT_FIELD = z
  .number()
  .int()
  .min(1_000)
  .max(600_000)
  .optional()
  .describe("单次执行超时（毫秒）；DRC 与自动布线本身就要数秒到数十秒");

const OUT_DIR_FIELD = z
  .string()
  .optional()
  .describe("可选：把 result.json 与 evidence.md 写到该目录（证据包）");

export const lcedaStatusTool = defineTool({
  name: "lceda_status",
  description:
    "双通道环境自检（只读）：检查 bridge 服务与 CDP 端点，返回 channel_state 四态" +
    "（both / bridge-only / cdp-only / none）、逐项 checks（含 reason_code 与 hint）与 next_action。" +
    "只探测回环地址，不安装、不登录、不改配置、不启动进程。退出码口径：0 双通道 / 1 单通道 / 2 都不可用。" +
    "结论来自实际探测，不是猜测；某条通道报告 partial 时不要把它当作可用通道继续写操作。",
  input: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (_args, ctx) => {
    try {
      const report = await checkEnvironment({ env: ctx.env });
      return { ...report, capability_map: capabilitySummary() };
    } catch (error) {
      fail(error);
    }
  },
});

export const edaDocInfoTool = defineTool({
  name: "eda_doc_info",
  description:
    "读取当前编辑器文档的类型与 uuid（只读）：走 dmt_SelectControl.getCurrentDocumentInfo()，" +
    "documentType 映射为 pcb(3) / schematic(1) / project(5) / pcb-2d-preview(12) / pcb-3d-preview(15)。" +
    "先确认文档类型再读板：停在原理图页调用读板类工具会得到「八计数全 0 且无报错」的假读数，" +
    "本工具就是用来避免这个假 0 的。bridge 优先，失败换 CDP；换路记录在 attempts 里。",
  input: {
    match: MATCH_FIELD,
    windowId: WINDOW_FIELD,
    timeoutMs: TIMEOUT_FIELD,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    try {
      const result = await docInfo(execContext(args, ctx));
      return {
        channel: result.channel,
        attempts: result.attempts,
        doc_type: result.doc_type,
        doc_type_name: result.doc_type_name,
        uuid: result.uuid,
      };
    } catch (error) {
      fail(error);
    }
  },
});

export const edaReadBoardTool = defineTool({
  name: "eda_read_board",
  description:
    "读 PCB 板面状态（只读）：八个图元计数、网络表、DRC 叶子（去重前）、元件明细与丝印，" +
    "归一化成 state 后只输出哈希与件数，不输出逐件坐标/位号明文。" +
    "成败只认回读：计数、网络名、DRC 叶子来自同一次读数，返回 available / comparable 与 reasons 供判断。" +
    "硬前置：当前文档必须是 PCB(3)。停在原理图页读板会得到假的全 0（八计数全 0 且无报错），" +
    "所以非 PCB 文档直接报 BOARD_NOT_PCB，不会把 0 当结果返回。" +
    "同样用 drc_dup_removed 与 drc_count_mismatch 判断 DRC 是否重复上报或计数不符。",
  input: {
    match: MATCH_FIELD,
    windowId: WINDOW_FIELD,
    timeoutMs: TIMEOUT_FIELD,
    outDir: OUT_DIR_FIELD,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args, ctx) => {
    try {
      await ctx.progress(0, 3, "读取 PCB 板面状态");
      const result = await readBoardState(execContext(args, ctx), {
        outDir: args.outDir === undefined ? undefined : await ctx.resolveWritePath(args.outDir),
        timeoutMs: args.timeoutMs,
      });
      await ctx.progress(3, 3, "PCB 板面状态读取完成");
      return {
        channel: result.channel,
        attempts: result.attempts,
        raw_doc_type: result.raw_doc_type,
        state: result.state,
        evidence: result.evidence?.folder ?? null,
      };
    } catch (error) {
      fail(error);
    }
  },
});

export const edaRunDrcTool = defineTool({
  name: "eda_run_drc",
  description:
    "在 PCB 上跑一次 DRC（只读，不改板）：调用 pcb_Drc.check(false, true, true)，返回按类别分组的统计，" +
    "并对展平叶子做 D10 去重（身份四元组精确分组，坐标只在组内容差聚类）与指纹。" +
    "成败只认回读：readback.probe_complete=false 或 count_mismatch=true 时读数不可信，不要报「DRC 通过」；" +
    "drc_dup_removed 是主探针，只说明重复条数，不代表错误消失。DRC 一次要数秒，超时默认放宽到 180 秒；可能在编辑器里留下 DRC 标记。",
  input: {
    match: MATCH_FIELD,
    windowId: WINDOW_FIELD,
    timeoutMs: TIMEOUT_FIELD,
    outDir: OUT_DIR_FIELD,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args, ctx) => {
    try {
      const result = await runDrc(execContext(args, ctx), {
        outDir: args.outDir === undefined ? undefined : await ctx.resolveWritePath(args.outDir),
        command: "eda_run_drc",
        timeoutMs: args.timeoutMs,
      });
      return {
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
      };
    } catch (error) {
      fail(error);
    }
  },
});

export const edaBoardDigestTool = defineTool({
  name: "eda_board_digest",
  description:
    "读 PCB 并计算指纹（只读）：details_hash、designator_set_hash、silk_hash、drc_leaf_hash 与 snapshot_key。" +
    "算法与源实现一致：sha256(salt + canonical(sorted(...)))[:16]。" +
    "跨版本（reader_id 不一致）或探针不全时 judge=unjudgeable，既不判通过也不判失败。" +
    "给 baseline（另一份读数 JSON 或上一次的 snapshot_key）时比较两份读数：只有可比且主键相等才是 pass，" +
    "否则 fail 或 unjudgeable；比较前请确认两次都停在同一个 PCB 文档。",
  input: {
    match: MATCH_FIELD,
    windowId: WINDOW_FIELD,
    timeoutMs: TIMEOUT_FIELD,
    outDir: OUT_DIR_FIELD,
    baseline: z
      .string()
      .optional()
      .describe("可选：baseline 文件路径或 snapshot_key；用来判断 pass/fail/unjudgeable"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args, ctx) => {
    try {
      const result = await boardDigestState(execContext(args, ctx), {
        outDir: args.outDir === undefined ? undefined : await ctx.resolveWritePath(args.outDir),
        command: "eda_board_digest",
        timeoutMs: args.timeoutMs,
        baseline: args.baseline,
      });
      return {
        channel: result.channel,
        attempts: result.attempts,
        digest: result.digest,
        comparison: result.comparison,
        evidence: result.evidence?.folder ?? null,
      };
    } catch (error) {
      fail(error);
    }
  },
});

export const edaRouteNetsTool = defineTool({
  name: "eda_route_nets",
  description:
    "对指定网络集合做自动布线（写操作，默认不执行）。对象：nets 参数列出的网络；" +
    "影响：pcb_Document.autoRouting({RoutingNets}) 会新增线段与过孔，已布通的网络可能被重排；" +
    "回滚：没有整体撤销 API，写前另存工程或确认撤销历史足够回退。" +
    "不带 confirm 时只返回对象/影响/回滚与调用提示，不改任何数据。" +
    "成败只认回读：布线前后各读一次 pcb_PrimitiveLine 数量，after 必须大于 before 才算成功；" +
    "线数没增加说明网络已布通、或当前文档不是 PCB / 处于历史预览态导致写入被静默忽略。",
  input: {
    nets: z.array(z.string().min(1)).min(1).describe('要布线的网络名列表，如 ["GND", "VCC"]'),
    confirm: z.boolean().optional().describe("写操作确认；不带时只返回预演信息"),
    match: MATCH_FIELD,
    windowId: WINDOW_FIELD,
    timeoutMs: TIMEOUT_FIELD,
    outDir: OUT_DIR_FIELD,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, ctx) => {
    try {
      const nets = args.nets.map((item) => item.trim()).filter((item) => item !== "");
      await ctx.progress(0, 3, "读取布线前状态");
      requireConfirm(args.confirm, routeNetsPreview(nets));
      const result = await routeNets(execContext(args, ctx), {
        nets,
        confirm: true,
        outDir: args.outDir === undefined ? undefined : await ctx.resolveWritePath(args.outDir),
        timeoutMs: args.timeoutMs,
      });
      await ctx.progress(3, 3, "自动布线与回读完成");
      return {
        channel: result.channel,
        attempts: result.attempts,
        nets: result.nets,
        before: result.before,
        after: result.after,
        delta: result.delta,
        lines_added: result.lines_added,
        readback_ok: result.readback_ok,
        changed: result.changed,
        ok: result.ok,
        warning: result.warning ?? null,
        auto_route: result.auto_route,
        evidence: result.evidence?.folder ?? null,
      };
    } catch (error) {
      fail(error);
    }
  },
});

export const edaEvalApiTool = defineTool({
  name: "eda_eval_api",
  description:
    "逃生口：在编辑器扩展上下文里执行任意 JS（默认不执行）。code 是 async 函数体，" +
    "可用 eda.* 接口并用 return 交出结果；需要 await 每个 Promise。" +
    "这是写操作：可能创建、修改或删除图元，影响无法事先界定，也没有统一回滚；" +
    "先取得用户明确同意，再以 confirm: true 调用。只读需求优先用 eda_read_board / eda_doc_info。" +
    "bridge 通道直接执行；CDP 通道注入 eda = globalThis._EXTAPI_ROOT_ 后执行，换路记录在 attempts。",
  input: {
    code: z
      .string()
      .min(1)
      .describe("async 函数体，如 `return await eda.dmt_SelectControl.getCurrentDocumentInfo();`"),
    confirm: z.boolean().optional().describe("写操作确认；不带时只返回预演信息"),
    outDir: OUT_DIR_FIELD,
    timeoutMs: TIMEOUT_FIELD,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args, ctx) => {
    try {
      requireConfirm(args.confirm, {
        verb: "eval_api",
        code_preview: args.code.length > 500 ? `${args.code.slice(0, 500)}…` : args.code,
        impact: "执行任意 JS，可能创建、修改或删除图元；代码由调用方负责。",
        rollback: "代码副作用没有统一回滚；写前另存工程或用撤销历史。",
      });
      const result = await evalApi(execContext(args, ctx), {
        code: args.code,
        confirm: true,
        outDir: args.outDir === undefined ? undefined : await ctx.resolveWritePath(args.outDir),
        command: "eda_eval_api",
        timeoutMs: args.timeoutMs,
      });
      return {
        channel: result.channel,
        attempts: result.attempts,
        value: result.value,
        evidence: result.evidence?.folder ?? null,
      };
    } catch (error) {
      fail(error);
    }
  },
});

export const edaCapabilityLookupTool = defineTool({
  name: "eda_capability_lookup",
  description:
    "检索编辑器动词台账（capability-map，124 个动词，只读）：查某个动词的路由、入口、失败信号、" +
    "菜单路径与实测记录。多个关键词按 AND 匹配；零命中返回空数组与提示，绝不按相似度编造条目。" +
    "用来回答「这个动作有没有可靠的 API 入口」「该走 bridge 还是 CDP」「失败长什么样」，" +
    "查不到就说明本层没有该动词的实测记录。",
  input: {
    query: z.string().min(1).describe("动词 id 或意图关键词，如 read_board_state、DRC、自动布线"),
    limit: z.number().int().min(1).max(50).optional().describe("返回条数上限，默认 10"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (args) => {
    try {
      return lookupCapability(args.query, { limit: args.limit });
    } catch (error) {
      fail(error);
    }
  },
});

/** 注册到 MCP 注册表的全部编辑器动词工具。 */
export const edaTools: ToolDef[] = [
  lcedaStatusTool,
  edaDocInfoTool,
  edaReadBoardTool,
  edaRunDrcTool,
  edaBoardDigestTool,
  edaRouteNetsTool,
  edaEvalApiTool,
  edaCapabilityLookupTool,
];
