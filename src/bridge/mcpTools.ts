import { z } from "zod";

import {
  ToolError,
  defineTool,
  requireConfirm,
  type ToolDef,
  type ToolContext,
} from "../mcp/types.ts";
import {
  BridgeClientError,
  bridgeErrorHint,
  discover,
  execute,
  requireConnected,
  selectWindow,
  windows,
} from "./client.ts";
import { BRIDGE_PORT_END, BRIDGE_PORT_START, BRIDGE_SERVICE_ID } from "./protocol.ts";

/**
 * bridge 相关的 MCP 工具。
 *
 * 数据面只有 HTTP：/health、/eda-windows、/execute。执行代码是写操作，
 * 默认不跑，必须显式 confirm。
 */

function portRange(ctx: ToolContext): [number, number] {
  return [ctx.cfg.bridge.portFirst, ctx.cfg.bridge.portLast];
}

function rethrow(error: unknown): never {
  if (error instanceof BridgeClientError) {
    throw new ToolError(error.code, error.message, { hint: bridgeErrorHint(error.code) });
  }
  throw error;
}

export const bridgeStatusTool = defineTool({
  name: "bridge_status",
  description:
    "查看本机 EasyEDA bridge 的运行状态：端口、EDA 窗口连接数、当前激活窗口、待处理请求数。" +
    "只读 HTTP 探测，不会启动服务。找不到服务时返回 running: false，并按 lceda-bridge start 提示。",
  input: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (_args, ctx) => {
    const [portFirst, portLast] = portRange(ctx);
    const endpoint = await discover({
      portFirst,
      portLast,
      host: ctx.cfg.bridge.bindHost,
    });
    if (!endpoint) {
      return {
        running: false,
        service: BRIDGE_SERVICE_ID,
        portRange: [portFirst, portLast],
        hint: bridgeErrorHint("NO_BRIDGE"),
      };
    }
    const health = endpoint.health;
    return {
      running: true,
      port: endpoint.port,
      service: health.service,
      edaConnected: Boolean(health.edaConnected),
      edaWindowCount: Number(health.edaWindowCount ?? 0),
      activeWindowId: health.activeWindowId ?? null,
      pendingRequests: Number(health.pendingRequests ?? 0),
      timestamp: health.timestamp,
    };
  },
});

export const bridgeWindowsTool = defineTool({
  name: "bridge_windows",
  description:
    "列出 bridge 上已注册的 EasyEDA 窗口（windowId、是否连着、是否是当前激活窗口）。" +
    "执行代码报窗口断开时，先用它看还有哪些窗口，再用 bridge_select_window 切换。",
  input: {},
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (_args, ctx) => {
    try {
      const [portFirst, portLast] = portRange(ctx);
      const endpoint = await discover({ portFirst, portLast, host: ctx.cfg.bridge.bindHost });
      if (!endpoint) {
        throw new BridgeClientError(
          "NO_BRIDGE",
          `端口区间 ${portFirst}-${portLast} 里没有 ${BRIDGE_SERVICE_ID}`,
        );
      }
      const list = await windows(endpoint.port, { host: ctx.cfg.bridge.bindHost });
      return { port: endpoint.port, ...list };
    } catch (error) {
      rethrow(error);
    }
  },
});

export const bridgeSelectWindowTool = defineTool({
  name: "bridge_select_window",
  description:
    "把 bridge 的当前激活窗口切换成指定 windowId。之后不带 windowId 的 bridge_execute 都会打到这个窗口。" +
    "windowId 从 bridge_windows 取；切换本身不修改设计数据。",
  input: {
    windowId: z.string().min(1).describe("目标窗口 id，如 bridge_windows 返回的 win-abc"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async ({ windowId }, ctx) => {
    try {
      const [portFirst, portLast] = portRange(ctx);
      const endpoint = await discover({ portFirst, portLast, host: ctx.cfg.bridge.bindHost });
      if (!endpoint) {
        throw new BridgeClientError(
          "NO_BRIDGE",
          `端口区间 ${portFirst}-${portLast} 里没有 ${BRIDGE_SERVICE_ID}`,
        );
      }
      const result = await selectWindow(endpoint.port, windowId, { host: ctx.cfg.bridge.bindHost });
      return {
        port: endpoint.port,
        success: true,
        activeWindowId: result.activeWindowId ?? windowId,
      };
    } catch (error) {
      rethrow(error);
    }
  },
});

export const bridgeExecuteTool = defineTool({
  name: "bridge_execute",
  description:
    "在正在运行的 EasyEDA Pro 编辑器里执行代码，返回 return 的结果。" +
    "code 必须是 `async function(eda){ ... }` 的函数体，并且用 return 交出结果；" +
    "所有返回 Promise 的 API 必须 await。PCB 坐标与尺寸单位是 mil（1mil = 0.0254mm）；" +
    "枚举参数用文档里的成员名（如 EPCB_LayerId.TOP），不要猜数字。" +
    "会执行任意代码、可能创建或修改图元，属于写操作：先确认影响，再以 confirm: true 调用。",
  input: {
    code: z
      .string()
      .min(1)
      .describe("函数体源码，如 `return await eda.dmt_Project.getCurrentProjectInfo();`"),
    windowId: z.string().optional().describe("目标窗口 id；缺省用当前激活窗口"),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .optional()
      .describe("客户端等待上限（毫秒，默认 35000；服务端自身 30 秒超时）"),
    confirm: z.boolean().optional().describe("写操作确认；不带时只返回预演信息，不执行"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async ({ code, windowId, timeoutMs, confirm }, ctx) => {
    requireConfirm(confirm, {
      tool: "bridge_execute",
      windowId: windowId ?? "(active)",
      code: code.length > 500 ? `${code.slice(0, 500)}…` : code,
    });
    if (!/\breturn\b/.test(code)) {
      throw new ToolError(
        "CODE_SHAPE",
        "code 必须是 `async function(eda){ ... }` 的函数体，并用 return 返回结果。",
      );
    }
    try {
      const [portFirst, portLast] = portRange(ctx);
      const endpoint = await discover({ portFirst, portLast, host: ctx.cfg.bridge.bindHost });
      if (!endpoint) {
        throw new BridgeClientError(
          "NO_BRIDGE",
          `端口区间 ${portFirst}-${portLast} 里没有 ${BRIDGE_SERVICE_ID}`,
        );
      }
      await requireConnected(endpoint.port, { host: ctx.cfg.bridge.bindHost });
      const result = await execute(endpoint.port, code, {
        windowId,
        timeoutMs,
        host: ctx.cfg.bridge.bindHost,
      });
      return {
        port: endpoint.port,
        windowId: windowId ?? endpoint.health.activeWindowId ?? null,
        result,
      };
    } catch (error) {
      rethrow(error);
    }
  },
});

export const bridgeTools: ToolDef[] = [
  bridgeStatusTool,
  bridgeWindowsTool,
  bridgeSelectWindowTool,
  bridgeExecuteTool,
];

/** 供初始化信息展示：默认端口区间。 */
export const BRIDGE_DEFAULT_PORT_RANGE: readonly [number, number] = [
  BRIDGE_PORT_START,
  BRIDGE_PORT_END,
];
