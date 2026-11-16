import {
  BridgeClientError,
  discover as discoverBridge,
  execute as executeBridge,
  windows as bridgeWindows,
} from "../bridge/client.ts";
import { BRIDGE_LISTEN_HOST, BRIDGE_PORT_END, BRIDGE_PORT_START } from "../bridge/protocol.ts";
import { DEFAULT_CDP_HOST, defaultPortFromEnv, resolveEndpoint } from "../cdp/discover.ts";
import { asCdpError } from "../cdp/errors.ts";
import { evaluateExpression } from "../cdp/eval.ts";
import { CdpSession } from "../cdp/session.ts";
import { listTargets, type CdpTarget } from "../cdp/targets.ts";
import { routesOf, type CapabilityRoute } from "./capabilities.ts";
import { DOC_PROBE_EXPR, DOC_PROBE_JS } from "./payloads.ts";

/**
 * 统一执行器：按 capability-map 的 `routes[].priority` 选通道。
 *
 * 移植自源仓库 `eda_verbs.run_routed`。换路只发生在**通道级故障**（无 bridge /
 * 未连接 / 超时 / 协议错误）；前置检查错误（例如当前文档不是 PCB、没有目标窗口）
 * 直接抛出，因为换一条通道也解决不了。
 *
 * 退出码口径沿用源仓库：0 成功 / 1 部分成功 / 2 通道不可用 / 3 前置失败 /
 * 4 协议错误 / 5 超时。
 */

export const EXIT_OK = 0;
export const EXIT_PARTIAL = 1;
export const EXIT_NO_CHANNEL = 2;
export const EXIT_PRECHECK = 3;
export const EXIT_PROTOCOL = 4;
export const EXIT_TIMEOUT = 5;

/** 领域错误：带退出码与细节，CLI/MCP 各自映射。 */
export class EdaVerbError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    options: { exitCode?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EdaVerbError";
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT_PROTOCOL;
    this.details = options.details;
  }
}

/** 通道级故障：路由器捕获后会尝试下一条路由。 */
export class ChannelError extends Error {
  readonly code: string;
  readonly channel: "bridge" | "cdp";
  readonly exitCode: number;

  constructor(
    channel: "bridge" | "cdp",
    code: string,
    message: string,
    exitCode: number,
    options: { cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ChannelError";
    this.channel = channel;
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface BridgeChannel {
  execute(code: string, options?: { windowId?: string; timeoutMs?: number }): Promise<unknown>;
  /** 已注册的 EDA 窗口 id；适配器不支持时可以不实现。 */
  listWindows?(): Promise<string[]>;
  /**
   * 按文档类型挑窗口（源仓库 `resolve_window`）。找不到返回 null；
   * 探测过程中的通道级故障要冒泡，不能伪装成「没有目标文档」。
   */
  resolveWindow?(
    docTypes: readonly number[],
    probeCode: string,
    options?: { timeoutMs?: number },
  ): Promise<string | null>;
}

export interface CdpChannel {
  evalApi(
    body: string,
    options?: { docTypes?: readonly number[]; match?: string; timeoutMs?: number },
  ): Promise<unknown>;
}

export interface ExecContext {
  env?: NodeJS.ProcessEnv;
  bridge?: BridgeChannel;
  cdp?: CdpChannel;
  /** 测试注入：覆盖台账里的路由（按 priority 排序后使用）。 */
  routes?: readonly CapabilityRoute[];
  /** 目标窗口；给了就不再做文档类型探测。 */
  windowId?: string;
  /** CDP 选页的标题 / URL 子串。 */
  match?: string;
  /** 单次执行超时（毫秒）。 */
  timeoutMs?: number;
}

export interface RoutedPayload {
  /** 一段 `async function(eda){...}` 的函数体。 */
  code: string;
  /** 允许的文档类型；PCB 动词默认 [3]。 */
  docTypes?: readonly number[];
  timeoutMs?: number;
  /** 覆盖 ctx.windowId。 */
  windowId?: string;
}

export interface RoutedAttempt {
  priority: number | null;
  channel: string;
  ok: boolean;
  detail?: string;
  exitCode?: number;
  degrade?: string;
}

export type RoutedChannel = "bridge" | "cdp" | "none" | "degrade";

export interface RoutedOutcome<T = unknown> {
  ok: boolean;
  channel: RoutedChannel;
  attempts: RoutedAttempt[];
  result: T | null;
  degrade?: string;
}

/** 源仓库 `PCB_VERBS`：这些动词在 bridge 通道要先挑一个 PCB 窗口。 */
export const PCB_VERBS: ReadonlySet<string> = new Set([
  "read_board_state",
  "run_drc",
  "route_net",
  "pour_create",
  "silk_annotate",
  "place_component",
  "manufacture_export",
  "aesthetic_lint",
  "modify_pcb_string",
  "set_board_stackup",
  "read_layer_stackup",
  "lock_layer",
  "configure_layer_appearance",
  "add_custom_layer",
  "select_active_layer",
]);

function timeoutExitCode(channel: "bridge" | "cdp", error: unknown): ChannelError {
  if (channel === "bridge" && error instanceof BridgeClientError) {
    const exitCode =
      error.code === "NO_BRIDGE"
        ? EXIT_NO_CHANNEL
        : error.code === "NOT_CONNECTED"
          ? EXIT_NO_CHANNEL
          : error.code === "TIMEOUT"
            ? EXIT_TIMEOUT
            : EXIT_PROTOCOL;
    return new ChannelError("bridge", error.code, error.message, exitCode, { cause: error });
  }
  const cdpError = asCdpError(error);
  const exitCode = cdpError.code.includes("TIMEOUT")
    ? EXIT_TIMEOUT
    : cdpError.exitCode === EXIT_NO_CHANNEL
      ? EXIT_NO_CHANNEL
      : EXIT_PROTOCOL;
  return new ChannelError(channel, cdpError.code, cdpError.message, exitCode, { cause: error });
}

/**
 * 按台账路由执行一个动词。
 *
 * 返回 `{ok, channel, attempts, result}`；通道全失败时 `ok=false`，由动词层决定
 * 报错还是降级。非通道级错误原样抛出，`attempts` 里保留失败记录。
 */
export async function runRouted(
  verb: string,
  payload: RoutedPayload,
  ctx: ExecContext = {},
): Promise<RoutedOutcome> {
  let routes: readonly CapabilityRoute[];
  if (ctx.routes) {
    routes = [...ctx.routes].sort((left, right) => (left.priority ?? 99) - (right.priority ?? 99));
  } else {
    try {
      routes = routesOf(verb);
    } catch (error) {
      throw new EdaVerbError(
        "VERB_NOT_FOUND",
        error instanceof Error ? error.message : String(error),
        { exitCode: EXIT_PRECHECK },
      );
    }
  }

  const attempts: RoutedAttempt[] = [];
  const isPcbVerb = PCB_VERBS.has(verb);
  for (const route of routes) {
    const priority = typeof route.priority === "number" ? route.priority : null;
    if (route.channel === null || route.channel === undefined) {
      attempts.push({
        priority,
        channel: "degrade",
        ok: false,
        degrade: route.degrade,
        detail: route.degrade,
      });
      return {
        ok: false,
        channel: "degrade",
        attempts,
        result: null,
        degrade: route.degrade,
      };
    }
    const channel = route.channel;
    if (channel !== "bridge" && channel !== "cdp") {
      attempts.push({
        priority,
        channel,
        ok: false,
        detail: "该通道未实现此动词（本地计算 / 离线通道不在本层执行范围）",
      });
      continue;
    }
    const impl: BridgeChannel | CdpChannel | undefined =
      channel === "bridge" ? ctx.bridge : ctx.cdp;
    if (!impl) {
      attempts.push({ priority, channel, ok: false, detail: "该通道未提供执行器" });
      continue;
    }

    try {
      let result: unknown;
      if (channel === "bridge") {
        const bridge = impl as BridgeChannel;
        let windowId = payload.windowId ?? ctx.windowId;
        if (windowId === undefined && isPcbVerb && bridge.resolveWindow) {
          const docTypes = payload.docTypes ?? [3];
          const resolved = await bridge.resolveWindow(docTypes, DOC_PROBE_JS, {
            timeoutMs: Math.min(payload.timeoutMs ?? ctx.timeoutMs ?? 10_000, 10_000),
          });
          if (resolved === null) {
            throw new EdaVerbError(
              "NO_TARGET_WINDOW",
              `没有处于 ${docTypes.join("/")} 文档的窗口。先打开对应文档再执行`,
              { exitCode: EXIT_PRECHECK },
            );
          }
          windowId = resolved;
        }
        result = await bridge.execute(payload.code, {
          windowId,
          timeoutMs: payload.timeoutMs ?? ctx.timeoutMs,
        });
      } else {
        const cdp = impl as CdpChannel;
        result = await cdp.evalApi(payload.code, {
          // undefined = 不按文档类型过滤（doc_info 要读任意文档）；PCB 动词显式传 [3]。
          docTypes: payload.docTypes,
          match: ctx.match,
          timeoutMs: payload.timeoutMs ?? ctx.timeoutMs,
        });
      }
      attempts.push({ priority, channel, ok: true });
      return { ok: true, channel, attempts, result };
    } catch (error) {
      if (!(error instanceof ChannelError)) {
        attempts.push({
          priority,
          channel,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      attempts.push({
        priority,
        channel,
        ok: false,
        detail: `${error.code}: ${error.message}`,
        exitCode: error.exitCode,
      });
    }
  }

  const degrade = routes.find((route) => route.channel === null)?.degrade ?? "所有通道都失败";
  return { ok: false, channel: "none", attempts, result: null, degrade };
}

// ─── 真实通道适配器 ───────────────────────────────────────────────────

export interface BridgeChannelOptions {
  host?: string;
  portFirst?: number;
  portLast?: number;
  defaultTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** 绑定一台 bridge 的适配器；首次执行时才探测端口。 */
export class DefaultBridgeChannel implements BridgeChannel {
  private readonly host: string;
  private readonly portFirst: number;
  private readonly portLast: number;
  private readonly defaultTimeoutMs: number | undefined;
  private endpointPort: number | null = null;

  constructor(options: BridgeChannelOptions = {}) {
    this.host = options.host ?? BRIDGE_LISTEN_HOST;
    this.portFirst = options.portFirst ?? BRIDGE_PORT_START;
    this.portLast = options.portLast ?? BRIDGE_PORT_END;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
  }

  private async port(): Promise<number> {
    if (this.endpointPort !== null) return this.endpointPort;
    let endpoint;
    try {
      endpoint = await discoverBridge({
        host: this.host,
        portFirst: this.portFirst,
        portLast: this.portLast,
      });
    } catch (error) {
      throw timeoutExitCode("bridge", error);
    }
    if (!endpoint) {
      throw new ChannelError(
        "bridge",
        "NO_BRIDGE",
        `端口区间 ${this.portFirst}-${this.portLast} 里没有 easyeda-bridge：先跑 lceda-bridge start`,
        EXIT_NO_CHANNEL,
      );
    }
    if (!endpoint.health.edaConnected) {
      throw new ChannelError(
        "bridge",
        "NOT_CONNECTED",
        "bridge 在跑，但没有 EDA 窗口连接：到客户端点扩展的「重新连接」",
        EXIT_NO_CHANNEL,
      );
    }
    this.endpointPort = endpoint.port;
    return endpoint.port;
  }

  async execute(
    code: string,
    options: { windowId?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const port = await this.port();
    try {
      return await executeBridge(port, code, {
        host: this.host,
        windowId: options.windowId,
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      });
    } catch (error) {
      this.endpointPort = null;
      throw timeoutExitCode("bridge", error);
    }
  }

  async listWindows(): Promise<string[]> {
    const port = await this.port();
    try {
      const listed = await bridgeWindows(port, { host: this.host });
      return listed.windows
        .filter((item) => item.connected)
        .map((item) => item.windowId)
        .filter((windowId): windowId is string => typeof windowId === "string" && windowId !== "");
    } catch (error) {
      this.endpointPort = null;
      throw timeoutExitCode("bridge", error);
    }
  }

  async resolveWindow(
    docTypes: readonly number[],
    probeCode: string,
    options: { timeoutMs?: number } = {},
  ): Promise<string | null> {
    const windowIds = await this.listWindows();
    for (const windowId of windowIds) {
      let info: Record<string, unknown> | null = null;
      try {
        const raw = await this.execute(probeCode, {
          windowId,
          timeoutMs: options.timeoutMs ?? 10_000,
        });
        info =
          raw !== null && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : null;
      } catch (error) {
        if (
          error instanceof ChannelError &&
          (error.code === "NO_BRIDGE" || error.code === "NOT_CONNECTED" || error.code === "TIMEOUT")
        ) {
          throw error;
        }
        info = null;
      }
      const type = typeof info?.type === "number" ? info.type : null;
      if (type !== null && docTypes.includes(type)) return windowId;
    }
    return null;
  }
}

export interface CdpChannelOptions {
  host?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
}

function pageCandidates(targets: readonly CdpTarget[], match: string | undefined): CdpTarget[] {
  return targets.filter((target) => {
    if (target.type !== "page") return false;
    if (typeof target.webSocketDebuggerUrl !== "string" || target.webSocketDebuggerUrl === "") {
      return false;
    }
    if (!match) return true;
    return (
      (typeof target.url === "string" && target.url.includes(match)) ||
      (typeof target.title === "string" && target.title.includes(match))
    );
  });
}

/** CDP 适配器：逐页探测文档类型，选中匹配页后求值。 */
export class DefaultCdpChannel implements CdpChannel {
  private readonly host: string;
  private readonly portOption: number | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultTimeoutMs: number | undefined;

  constructor(options: CdpChannelOptions = {}) {
    this.host = options.host ?? DEFAULT_CDP_HOST;
    this.portOption = options.port;
    this.env = options.env ?? process.env;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
  }

  async evalApi(
    body: string,
    options: { docTypes?: readonly number[]; match?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const endpoint = await this.endpoint();
    const targets = await this.targets(endpoint.port);
    const pages = pageCandidates(targets, options.match);
    if (pages.length === 0) {
      throw new ChannelError(
        "cdp",
        "CDP_NO_PAGE",
        "CDP 端点可用，但没有匹配的 page target",
        EXIT_NO_CHANNEL,
      );
    }

    const seen: Array<{ title: string; type: number | null }> = [];
    let lastError: unknown = null;
    let matched = false;
    for (const page of pages) {
      let session: CdpSession;
      try {
        session = await CdpSession.connect(String(page.webSocketDebuggerUrl), {
          env: this.env,
          timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
        });
      } catch (error) {
        lastError = error;
        continue;
      }
      try {
        let docType: number | null = null;
        try {
          const probe = await evaluateExpression(session, DOC_PROBE_EXPR);
          const value = probe.value;
          if (value !== null && typeof value === "object") {
            const raw = (value as Record<string, unknown>).type;
            docType = typeof raw === "number" ? raw : null;
          }
        } catch (error) {
          lastError = error;
          continue;
        }
        seen.push({
          title: typeof page.title === "string" ? page.title : "",
          type: docType,
        });
        const allowed = options.docTypes;
        if (allowed && allowed.length > 0 && (docType === null || !allowed.includes(docType))) {
          continue;
        }
        matched = true;
        const expression =
          "(async()=>{const eda=globalThis._EXTAPI_ROOT_;" +
          "if(!eda) return {error:'主世界没有扩展接口'};" +
          `${body}\n})()`;
        const outcome = await evaluateExpression(session, expression);
        const value = outcome.value;
        if (
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          (value as Record<string, unknown>).error === "主世界没有扩展接口"
        ) {
          throw new ChannelError(
            "cdp",
            "CDP_NO_EXTAPI",
            "页面主世界没有 _EXTAPI_ROOT_：该页不是编辑器主画面",
            EXIT_NO_CHANNEL,
          );
        }
        return value;
      } catch (error) {
        if (error instanceof ChannelError) throw error;
        lastError = error;
      } finally {
        session.close();
      }
    }

    // 有匹配文档但求值失败 ⇒ 协议/超时类通道故障，不能伪装成「没有目标文档」。
    if (matched) {
      throw timeoutExitCode("cdp", lastError ?? new Error("CDP 求值失败"));
    }
    if (options.docTypes && options.docTypes.length > 0) {
      const existing = seen
        .map((item) => `${item.title || "(无标题)"}=${item.type === null ? "unknown" : item.type}`)
        .join(", ");
      throw new EdaVerbError(
        "CDP_NO_DOC",
        `视觉通道没有处于 ${options.docTypes.join("/")} 文档的窗口（现有：${existing || "无"}）`,
        { exitCode: EXIT_PRECHECK },
      );
    }
    throw timeoutExitCode("cdp", lastError ?? new Error("CDP 求值失败"));
  }

  private async endpoint(): Promise<{ port: number }> {
    const port = this.portOption ?? defaultPortFromEnv(this.env);
    try {
      const endpoint = await resolveEndpoint(this.host, { port, env: this.env });
      if (!endpoint) {
        throw new ChannelError(
          "cdp",
          "CDP_NOT_FOUND",
          "找不到 CDP 端点：客户端需带 --remote-debugging-port 启动",
          EXIT_NO_CHANNEL,
        );
      }
      return { port: endpoint.port };
    } catch (error) {
      if (error instanceof ChannelError) throw error;
      throw timeoutExitCode("cdp", error);
    }
  }

  private async targets(port: number): Promise<CdpTarget[]> {
    try {
      return await listTargets(this.host, port);
    } catch (error) {
      throw timeoutExitCode("cdp", error);
    }
  }
}

export interface DefaultExecContextOptions {
  env?: NodeJS.ProcessEnv;
  cdpPort?: number;
  match?: string;
  bridgePortFirst?: number;
  bridgePortLast?: number;
  windowId?: string;
  timeoutMs?: number;
}

/** CLI / MCP 共用的默认上下文：真 bridge + 真 CDP，首次执行才探测。 */
export function createDefaultExecContext(options: DefaultExecContextOptions = {}): ExecContext {
  const env = options.env ?? process.env;
  return {
    env,
    bridge: new DefaultBridgeChannel({
      portFirst: options.bridgePortFirst,
      portLast: options.bridgePortLast,
      env,
    }),
    cdp: new DefaultCdpChannel({ port: options.cdpPort, env }),
    match: options.match,
    windowId: options.windowId,
    timeoutMs: options.timeoutMs,
  };
}
