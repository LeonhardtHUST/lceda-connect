import { setTimeout as sleep } from "node:timers/promises";
import { CdpSession } from "../cdp/session.ts";
import { evaluateExpression } from "../cdp/eval.ts";
import type { CdpTarget } from "../cdp/targets.ts";
import { probeUiShell } from "../cdp/uiShell.ts";
import { managerExpression, type ManagerContext, type ManagerStage } from "./managerUi.ts";

const HOST = "127.0.0.1";
const TITLE = " | 嘉立创EDA(专业版) - V4.1.105";
const ORIGINS = new Set(["https://pro.lceda.cn", "https://client"]);
const READBACK_MS = 8000;

export interface WindowIdentity {
  port: number;
  target: string;
  project: string;
  pcb: string;
}

export type ExtensionIdentity = Pick<ManagerContext, "uuid" | "name" | "displayName" | "version">;

function urlHasIdentity(url: URL, id: string): boolean {
  // A board id must occur as a complete token, not a prefix of another id.
  return `${url.pathname}${url.search}${url.hash}`
    .toLowerCase()
    .split(/[^a-f0-9]+/)
    .includes(id);
}

export function selectExtensionWindow(
  targets: readonly CdpTarget[],
  want: WindowIdentity,
): CdpTarget {
  const matches = targets.filter((t) => t.id === want.target);
  const t = matches[0];
  if (
    matches.length !== 1 ||
    !t ||
    t.type !== "page" ||
    typeof t.url !== "string" ||
    typeof t.title !== "string" ||
    !t.title.endsWith(TITLE) ||
    t.title.length <= TITLE.length
  ) {
    throw new Error("未找到唯一的嘉立创 EDA 4.1.105 中文版 PCB 页面；请重新读取 CDP target。");
  }
  const url = new URL(t.url);
  if (
    !ORIGINS.has(url.origin) ||
    url.pathname !== "/editor" ||
    url.username ||
    url.password ||
    !urlHasIdentity(url, want.project) ||
    !urlHasIdentity(url, want.pcb)
  ) {
    throw new Error("编辑器 URL 的来源、工程 ID 或 PCB ID 不符，已停止。");
  }
  const ws = new URL(t.webSocketDebuggerUrl ?? "");
  if (
    ws.protocol !== "ws:" ||
    ws.hostname !== HOST ||
    (ws.port ? Number(ws.port) : 80) !== want.port ||
    ws.pathname !== `/devtools/page/${want.target}` ||
    ws.search ||
    ws.hash ||
    ws.username ||
    ws.password
  ) {
    throw new Error("调试 WebSocket 未绑定指定的本机端口和 page target，已停止。");
  }
  return t;
}

interface UiConnection {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/**
 * 测试接缝：只替换传输/探测的取得方式，不改变发现、绑定、guard 与关闭语义。
 * 不传时与生产行为完全一致（回环 HTTP 列表、CdpSession、UI 探测、身份回读）。
 */
export interface ExtensionManagerHooks {
  fetch?: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  connect?: (wsUrl: string, options: { timeoutMs: number }) => Promise<CdpSession>;
  probe?: (session: CdpSession) => Promise<{ href?: string }>;
  evaluate?: (session: CdpSession, expression: string) => Promise<{ value?: unknown }>;
}

interface Evaluation {
  exceptionDetails?: { exception?: { description?: string }; text?: string };
  result?: { value?: unknown; objectId?: string; subtype?: string };
}

export class ExtensionManager {
  constructor(
    private readonly session: UiConnection,
    private readonly context: ManagerContext,
    private readonly guard: () => Promise<void>,
  ) {}

  private async eval(
    stage: ManagerStage,
    byValue = true,
  ): Promise<NonNullable<Evaluation["result"]>> {
    const r = await this.session.call<Evaluation>("Runtime.evaluate", {
      expression: managerExpression(stage, this.context),
      returnByValue: byValue,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      // Only our fixed guard code emits these error messages; do not echo remote exception data.
      throw new Error(`扩展管理器在 ${stage} 阶段拒绝操作：请复核页面、界面版本和目标扩展。`);
    }
    if (!r.result) throw new Error(`扩展管理器 ${stage} 阶段没有回读结果。`);
    return r.result;
  }

  private async require(stage: ManagerStage): Promise<void> {
    if ((await this.eval(stage)).value !== true)
      throw new Error(`扩展管理器 ${stage} 阶段未通过复核。`);
  }

  private async waitFor(
    stage: ManagerStage,
    accept: (value: unknown) => boolean,
  ): Promise<unknown> {
    const until = Date.now() + READBACK_MS;
    do {
      const { value } = await this.eval(stage);
      if (accept(value)) return value;
      await sleep(200);
    } while (Date.now() < until);
    throw new Error(`扩展管理器 ${stage} 阶段回读超时。`);
  }

  async install(stageFile: string): Promise<{ enabled: boolean }> {
    await this.require("open");
    await this.require("installed");
    await this.require("empty");
    await this.guard();
    const input = await this.eval("file-input", false);
    const id = input.objectId;
    if (!id || input.subtype !== "node") throw new Error("没有取得唯一的 .eext 文件输入控件。");
    try {
      // Do not resend the mutation, even if the transport reports an error.
      await this.session.call("DOM.setFileInputFiles", { objectId: id, files: [stageFile] });
      await this.require("installed");
      await this.waitFor("card", (value) => value === true);
      return await this.details();
    } catch (error) {
      throw new Error(
        "已尝试提交安装，但未完整确认结果。请在同一隔离客户端检查已安装列表；不要直接重试。",
        { cause: error },
      );
    } finally {
      await this.session.call("Runtime.releaseObject", { objectId: id }).catch(() => {});
    }
  }

  private async details(): Promise<{ enabled: boolean }> {
    const value = await this.waitFor(
      "details",
      (x) =>
        x !== null && typeof x === "object" && "enabled" in x && typeof x.enabled === "boolean",
    );
    return value as { enabled: boolean };
  }

  async uninstall(): Promise<void> {
    await this.require("open");
    await this.require("installed");
    await this.waitFor("card", (value) => value === true);
    await this.details();
    await this.require("config");
    await this.guard();
    try {
      await this.require("remove-prompt");
      await this.guard();
      await this.require("remove-confirm");
      await this.waitFor("removed", (value) => value === true);
    } catch (error) {
      throw new Error(
        "未确认扩展已卸载。请在隔离客户端检查权限、待确认对话框和已安装列表；不要直接重试。",
        { cause: error },
      );
    }
  }
}

export async function withExtensionManager<T>(
  window: WindowIdentity,
  identity: ExtensionIdentity,
  action: (manager: ExtensionManager) => Promise<T>,
  hooks: ExtensionManagerHooks = {},
): Promise<T> {
  const request: NonNullable<ExtensionManagerHooks["fetch"]> =
    hooks.fetch ??
    ((url) =>
      fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: { accept: "application/json" },
      }));
  const connect: NonNullable<ExtensionManagerHooks["connect"]> =
    hooks.connect ?? ((url) => CdpSession.connect(url, { timeoutMs: 5000 }));
  const probe: NonNullable<ExtensionManagerHooks["probe"]> = hooks.probe ?? probeUiShell;
  const evaluate: NonNullable<ExtensionManagerHooks["evaluate"]> =
    hooks.evaluate ?? evaluateExpression;
  const response = await request(`http://${HOST}:${window.port}/json/list`);
  const payload: unknown = response.ok ? await response.json() : null;
  if (!Array.isArray(payload)) throw new Error("指定回环端点没有返回 CDP 页面列表。");
  const targets = payload.filter(
    (t): t is CdpTarget => t !== null && typeof t === "object" && !Array.isArray(t),
  );
  const t = selectExtensionWindow(targets, window);
  const href = t.url as string;
  const title = t.title as string;
  const session = await connect(t.webSocketDebuggerUrl as string, { timeoutMs: 5000 });
  try {
    const shell = await probe(session);
    if (shell.href !== href) throw new Error("编辑器窗口已切换，已停止。");
    const guard = async (): Promise<void> => {
      const { value } = await evaluate(session, editorIdentityExpression(window, href, title));
      if (value !== true) throw new Error("当前工程、PCB 或编辑器状态变化，已停止。");
    };
    await guard();
    return await action(new ExtensionManager(session, { ...identity, title, href }, guard));
  } finally {
    session.close();
  }
}

export function editorIdentityExpression(
  window: WindowIdentity,
  href: string,
  title: string,
): string {
  const expected = JSON.stringify({ project: window.project, pcb: window.pcb, href, title });
  return `(async () => {
    const want = ${expected};
    const matches = () => location.href === want.href && document.title === want.title &&
      document.visibilityState === 'visible';
    if (!matches()) return false;
    try {
      const api = globalThis._EXTAPI_ROOT_;
      const p = await api.dmt_Project.getCurrentProjectInfo();
      const d = await api.dmt_SelectControl.getCurrentDocumentInfo();
      return matches() && p?.uuid === want.project && d?.uuid === want.pcb &&
        d.parentProjectUuid === want.project && d.documentType === 3;
    } catch { return false; }
  })()`;
}
