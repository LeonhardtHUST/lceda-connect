import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { packageRoot } from "../core/assets.ts";
import { homeDir, type BridgeConfig } from "../core/config.ts";
import {
  ensureDir,
  exists,
  fileSize,
  formatSize,
  readJson,
  removeFile,
  writeJson,
} from "../core/fsx.ts";
import { appendLog, followLog, rotateIfTooLarge, tailLines } from "../core/log.ts";
import { listListeners, probeHealth } from "../core/netprobe.ts";
import {
  nodeCandidates,
  probeNodeVersion,
  resetNodeCache,
  resolveNodePath,
} from "../core/nodeResolve.ts";
import { selfEntryPath, spawnDetached } from "../core/spawn.ts";
import { hr, paint } from "../core/term.ts";
import { isPidAlive, killProcessTree, listProcesses, sleep } from "../core/windows.ts";
import type { Io } from "../core/io.ts";
import type { BridgeHealth, TcpListener } from "../core/types.ts";
import type { BridgeAction, BridgeOptions, CommandContext } from "./types.ts";

/**
 * Bridge 子命令实现。
 * 对应旧脚本：D:\Tools\bin\lceda-bridge.ps1
 * （action: start|stop|kill|restart|status|st|health|logs|log|doctor|check|env|run|supervise|help）。
 *
 * 分工：
 *   - 纯逻辑（进程分类、排序、state.json、状态对象、日志标记、文案）都拆成独立导出的纯函数，便于单测；
 *   - 真正会动系统的部分（起进程、杀进程、扫端口）只在 action 实现里调用 core。
 * 文案、退出码、字段名一律对齐旧脚本，便于老的脚本 / Agent 继续解析。
 */

// ─── 常量（与旧脚本一一对应）────────────────────────────────────────

/** 服务进程的命令行特征。 */
export const BRIDGE_SERVICE_TAG = "bridge-server.mjs";
/** 旧封装脚本的命令行特征。 */
export const BRIDGE_LEGACY_TAG = "start-easyeda-bridge.bat";

/** start 轮询 /health 的间隔（旧脚本 350ms）。 */
const HEALTH_POLL_MS = 350;
/** stop 兜底扫端口：12 次 × 250ms。 */
const STOP_POLL_ATTEMPTS = 12;
const STOP_POLL_MS = 250;
/** restart 在 stop 之后稍等，让端口彻底释放（旧脚本 400ms）。 */
const RESTART_SETTLE_MS = 400;
/** start 超时后打印的日志行数（旧脚本 -Tail 15）。 */
const START_FAIL_LOG_LINES = 15;
/** supervise 找不到 node 时的重试间隔（旧脚本 60s）。 */
const SUPERVISE_RETRY_MS = 60_000;
/** supervise 把「缺 node / 缺脚本」写到这里（旧脚本 $env:TEMP\lceda-bridge-supervise.err）。 */
const SUPERVISE_ERR_FILE = "lceda-bridge-supervise.err";
/** 本机的健康检查 / agent 连接不该被系统代理接管。 */
const LOOPBACK_NO_PROXY = "127.0.0.1,localhost";

/** 找不到 node 时的三条修法（与旧脚本 doctor 的文案一致）。 */
export const NODE_FIX_LINES: readonly string[] = [
  "    1) 让 vp 装回一个:   vp env install 24.22.0",
  '    2) 永久钉住路径:     setx LCEDA_NODE "D:\\path\\to\\node.exe"',
  "    3) 装官方 LTS:       winget install OpenJS.NodeJS.LTS",
];

/** 输出用的着色名（term.ts 的 paint 键）。 */
type PaintKey = keyof typeof paint;

// ─── 纯逻辑：进程分类 ────────────────────────────────────────────────

export interface ProcessTags {
  /** 命令行里出现即认定为 bridge 服务进程，如 bridge-server.mjs。 */
  serviceTag: string;
  /** 命令行里出现即认定为外层包装进程，如 start-easyeda-bridge.bat。 */
  legacyTag: string;
  /**
   * 旧 PowerShell 实现的脚本名（迁移期机器上可能还有 PS 守护进程在跑）。
   * 它的命令行形如 `pwsh -File "D:\Tools\bin\lceda-bridge.ps1" -Action supervise`，
   * 只靠 selfPath 是认不出来的，漏掉它 stop 就白杀了（它会把 node 子进程再拉起来）。
   */
  legacyScriptTag?: string;
}

export const BRIDGE_LEGACY_SCRIPT_TAG = "lceda-bridge.ps1";

export const DEFAULT_PROCESS_TAGS: ProcessTags = {
  serviceTag: BRIDGE_SERVICE_TAG,
  legacyTag: BRIDGE_LEGACY_TAG,
  legacyScriptTag: BRIDGE_LEGACY_SCRIPT_TAG,
};

/** 供 collectStopTargets 使用的进程快照形状（core 的 ProcInfo 结构化兼容）。 */
export interface ProcessLike {
  pid: number;
  name: string;
  commandLine: string;
}

export type StopTargetKind = "wrapper" | "supervisor" | "node";

export type ListenerStopDecision = "verified" | "unknown";

export function listenerStopDecision(
  health: BridgeHealth | null,
  serviceId: string,
): ListenerStopDecision {
  return health?.service === serviceId ? "verified" : "unknown";
}

export interface ClassifiedCommand {
  kind: StopTargetKind;
  order: number;
}

export interface StopTarget extends ProcessLike {
  kind: StopTargetKind;
  order: number;
}

/** 可以接受单个入口路径，也可以接受一组（多个 bin 入口）。 */
export type SelfPathInput = string | readonly string[] | null;

/**
 * 本 CLI 的入口候选。
 * 包里有 cli.mjs / cli-cdp.mjs / cli-bridge.mjs 三个 bin，start 用哪个入口起的守护进程，
 * 其命令行里就是哪个路径；stop 时只认当前入口会漏掉「别的入口起的」守护进程，
 * 所以同目录的兄弟入口一起算（动作关键字仍然必须命中 supervise/run，不会误杀）。
 */
export function selfEntryCandidates(entry: string): string[] {
  const dir = path.dirname(entry);
  const names = [path.basename(entry), "cli.mjs", "cli-bridge.mjs", "cli-cdp.mjs"];
  return [...new Set(names.map((name) => path.join(dir, name)))];
}

function selfPaths(selfPath: SelfPathInput): string[] {
  if (!selfPath) return [];
  const list = typeof selfPath === "string" ? [selfPath] : selfPath;
  return list.map((item) => item.toLowerCase()).filter((item) => item !== "");
}

/**
 * 命令行里是否出现了某个动作词。
 * 同时兼容旧 PowerShell 的 `-Action supervise` 和本 CLI 的 `bridge supervise` 两种写法。
 */
function matchesActionToken(commandLineLower: string, action: string): boolean {
  return new RegExp(`(?:^|\\s)(?:-action\\s+)?${action}(?=\\s|$)`, "i").test(commandLineLower);
}

/**
 * 判断一条命令行是不是 bridge 相关进程（对应旧脚本的 Get-TargetProcess 判定部分）。
 * 返回 null 表示无关进程。
 */
export function classifyCommandLine(
  commandLine: string,
  selfPath: SelfPathInput,
  tags: ProcessTags = DEFAULT_PROCESS_TAGS,
): ClassifiedCommand | null {
  if (!commandLine) return null;
  const lowered = commandLine.toLowerCase();

  const isService = lowered.includes(tags.serviceTag.toLowerCase());
  const hasLegacy = lowered.includes(tags.legacyTag.toLowerCase());
  const hasSelf = selfPaths(selfPath).some((item) => lowered.includes(item));

  const legacyScript = tags.legacyScriptTag ? tags.legacyScriptTag.toLowerCase() : "";
  const hasLegacyScript = legacyScript !== "" && lowered.includes(legacyScript);

  const isSupervisor = (hasSelf || hasLegacyScript) && matchesActionToken(lowered, "supervise");
  const isForeground = (hasSelf || hasLegacyScript) && matchesActionToken(lowered, "run");
  const isWrapper = hasLegacy || isForeground;

  if (!isService && !isWrapper && !isSupervisor) return null;
  // 顺序很重要：先杀外层（bat / run 前台 / 守护进程），否则它会把子进程又拉起来
  if (isWrapper) return { kind: "wrapper", order: 0 };
  if (isSupervisor) return { kind: "supervisor", order: 1 };
  return { kind: "node", order: 2 };
}

/** 按「外层 → 守护 → 服务」排序，同层按 pid 升序（对应 Sort-Object Order, ProcessId）。 */
export function sortStopTargets(targets: readonly StopTarget[]): StopTarget[] {
  return [...targets].sort((left, right) => left.order - right.order || left.pid - right.pid);
}

/**
 * 从进程快照里挑出需要清理的 bridge 进程，并排好杀进程顺序。
 * 跳过自身进程与拿不到命令行的进程（对应旧脚本的 `$p.ProcessId -eq $PID` / IsNullOrEmpty 判断）。
 */
export function collectStopTargets(
  processes: readonly ProcessLike[],
  selfPath: SelfPathInput,
  selfPid: number = process.pid,
  tags: ProcessTags = DEFAULT_PROCESS_TAGS,
): StopTarget[] {
  const targets: StopTarget[] = [];
  for (const proc of processes) {
    if (proc.pid === selfPid) continue;
    if (!proc.commandLine) continue;
    const classified = classifyCommandLine(proc.commandLine, selfPath, tags);
    if (!classified) continue;
    targets.push({
      pid: proc.pid,
      name: proc.name,
      commandLine: proc.commandLine,
      kind: classified.kind,
      order: classified.order,
    });
  }
  return sortStopTargets(targets);
}

// ─── 纯逻辑：bridge-server.mjs / 子进程参数 ───────────────────────────

/**
 * bridge-server.mjs 的候选路径，顺序与旧脚本一致：
 * LCEDA_BRIDGE_SCRIPT → ~\.workbuddy\... → ~\.claude\...
 */
export function bridgeScriptCandidates(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): string[] {
  const candidates: string[] = [];
  const configured = override ?? env.LCEDA_BRIDGE_SCRIPT;
  if (configured) candidates.push(configured);
  const home = homeDir(env);
  candidates.push(
    path.join(home, ".workbuddy", "skills", "easyeda-api", "scripts", "bridge-server.mjs"),
  );
  candidates.push(
    path.join(home, ".claude", "skills", "easyeda-api", "scripts", "bridge-server.mjs"),
  );
  return candidates;
}

/** 找到第一个真实存在的 bridge-server.mjs（只看外部脚本，保持原有语义）。 */
export function resolveBridgeScript(
  bridge: BridgeConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const candidate of bridgeScriptCandidates(env, bridge.bridgeScript)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * 随包发布的内置 bridge 服务（src/cli-bridge-server.ts 的打包产物）。
 * 外部脚本一个都找不到时用它——不再要求用户另装 easyeda-api 技能与 ws 依赖。
 */
export function builtinBridgeScript(): string | null {
  try {
    return path.join(packageRoot(), "dist", "cli-bridge-server.mjs");
  } catch {
    // packageRoot 只在包结构异常时失败，内置服务视为不可用
    return null;
  }
}

export interface BridgeScriptResolution {
  path: string;
  /** true 表示这是内置服务（doctor 的 ws 检查要跳过）。 */
  builtin: boolean;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

/** 判断一个脚本路径是不是内置服务（大小写不敏感，Windows 路径）。 */
export function isBuiltinBridgeScript(
  scriptPath: string,
  builtinPath: string | null = builtinBridgeScript(),
): boolean {
  return builtinPath !== null && samePath(scriptPath, builtinPath);
}

/**
 * 服务脚本解析顺序：LCEDA_BRIDGE_SCRIPT / --script → 旧的外部候选 → 内置 dist/cli-bridge-server.mjs。
 * 显式指定的脚本即使等于内置路径，也按内置处理（supervise 会把它经环境变量传下来）。
 */
export function resolveBridgeScriptWithBuiltin(
  bridge: BridgeConfig,
  env: NodeJS.ProcessEnv = process.env,
  builtinPath: string | null = builtinBridgeScript(),
): BridgeScriptResolution | null {
  for (const candidate of bridgeScriptCandidates(env, bridge.bridgeScript)) {
    if (!exists(candidate)) continue;
    return {
      path: candidate,
      builtin: builtinPath !== null && samePath(candidate, builtinPath),
    };
  }
  if (builtinPath !== null && exists(builtinPath)) return { path: builtinPath, builtin: true };
  return null;
}

export interface ResolvedNode {
  path: string;
  version: string;
}

/**
 * 解析要用的 node：
 * 先用钉死的路径（--node / LCEDA_NODE，落在 cfg.bridge.nodePath），它跑不起来就回落到 core 的候选链
 * —— 与旧脚本「LCEDA_NODE 排第一，但只认第一个真能跑的」一致。
 */
export async function resolveNodeFor(
  bridge: Pick<BridgeConfig, "nodePath">,
  env: NodeJS.ProcessEnv = process.env,
  probe: (exe: string) => Promise<string | null> = probeNodeVersion,
  fallback: (env: NodeJS.ProcessEnv) => Promise<ResolvedNode | null> = resolveNodePath,
): Promise<ResolvedNode | null> {
  if (bridge.nodePath) {
    const version = await probe(bridge.nodePath);
    if (version) return { path: bridge.nodePath, version };
  }
  return await fallback(env);
}

/** supervise 子命令的参数（--once 时追加 --once）。 */
export function buildSuperviseArgs(options: { once: boolean }): string[] {
  const args = ["bridge", "supervise"];
  if (options.once) args.push("--once");
  return args;
}

/**
 * 后台守护进程的启动命令：node 自身可执行文件 + 本 CLI 入口 + supervise。
 * 不再需要旧脚本那样找 PowerShell 宿主（-File lceda-bridge.ps1 -Action supervise）。
 */
export function buildSuperviseCommand(
  selfPath: string,
  nodePath: string,
  options: { once: boolean },
): { file: string; args: string[] } {
  return { file: nodePath, args: [selfPath, ...buildSuperviseArgs(options)] };
}

/** 子进程环境：固定 NO_PROXY（本机回环不走代理），并把解析结果钉死，避免子进程再解析一遍。 */
export function buildBridgeChildEnv(
  env: NodeJS.ProcessEnv,
  nodePath: string,
  scriptPath: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    NO_PROXY: LOOPBACK_NO_PROXY,
    no_proxy: LOOPBACK_NO_PROXY,
    LCEDA_NODE: nodePath,
    LCEDA_BRIDGE_SCRIPT: scriptPath,
  };
}

// ─── 纯逻辑：state.json ──────────────────────────────────────────────

/** state.json 的字段（与旧脚本 [ordered] 里写的一模一样，顺序也保持）。 */
export interface BridgeState {
  supervisorPid: number;
  node: string;
  script: string;
  startedAt: string;
  log: string;
}

function asInt(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

/** 读 state.json；文件缺失或不是合法 JSON 时返回 null（对应 Get-SavedState 的 catch）。 */
export function readBridgeState(file: string): BridgeState | null {
  const raw = readJson<Record<string, unknown>>(file);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    supervisorPid: asInt(raw.supervisorPid),
    node: asText(raw.node),
    script: asText(raw.script),
    startedAt: asText(raw.startedAt),
    log: asText(raw.log),
  };
}

export function writeBridgeState(file: string, state: BridgeState): void {
  writeJson(file, state);
}

// ─── 纯逻辑：时间戳 / 日志标记 ────────────────────────────────────────

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function localStamp(date: Date, separator: string): string {
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return `${day}${separator}${time}`;
}

/** 对应 PowerShell `Get-Date -Format 'yyyy-MM-dd HH:mm:ss'`（本地时间）。 */
export function localTimestamp(date: Date = new Date()): string {
  return localStamp(date, " ");
}

/** 对应 PowerShell `Get-Date -Format 's'`：2026-11-14T17:31:50（本地时间，无时区）。 */
export function localTimestampSeconds(date: Date = new Date()): string {
  return localStamp(date, "T");
}

/** 旧脚本写入 `\r\n===== <时间> start bridge =====`（带一个前导空行）。 */
export function superviseStartMarker(stamp: string): string {
  return `\r\n===== ${stamp} start bridge =====\n`;
}

/** 旧脚本写入 `===== <时间> exited (code N) =====`。 */
export function superviseExitMarker(stamp: string, code: number): string {
  return `===== ${stamp} exited (code ${code}) =====\n`;
}

/** 原 node 被 vp 清掉时的重新解析记录。 */
export function superviseNodeGoneMarker(stamp: string, resolved: string): string {
  return `===== ${stamp} 原 node 已不存在，重新解析: ${resolved} =====\n`;
}

/** 重新解析也拿不到 node 时的提示。 */
export function superviseNoNodeMarker(stamp: string): string {
  return `===== ${stamp} 没有可用的 node，60 秒后重试（跑 lceda-bridge doctor 看原因） =====\n`;
}

/** 日志超过上限就滚存为 `<log>.1`（对应旧脚本的 Move-Item）。 */
export function rotateLogIfNeeded(logFile: string, maxBytes: number): boolean {
  if (!exists(logFile)) return false;
  return rotateIfTooLarge(logFile, maxBytes);
}

/** 日志尾部 N 行（对应 Get-Content -Tail N）。 */
export function tailLog(logFile: string, lines: number): string[] {
  return tailLines(logFile, lines);
}

// ─── 纯逻辑：status 对象 / 文本 ───────────────────────────────────────

/** 旧脚本 `-Json` 输出的字段，顺序也照抄（Agent 侧可能按顺序断言）。 */
export interface BridgeStatus {
  running: boolean;
  healthy: boolean;
  port: number;
  pid: number;
  supervisor: boolean;
  supervisorPid: number;
  node: string | null;
  nodeVersion: string;
  edaConnected: boolean;
  edaWindows: number;
  activeWindow: string;
  pending: number;
  script: string | null;
  logFile: string;
}

export interface StatusInputs {
  listeners: readonly TcpListener[];
  health: BridgeHealth | null;
  saved: BridgeState | null;
  supervisorAlive: boolean;
  nodePath: string | null;
  nodeVersion: string;
  scriptPath: string | null;
  logFile: string;
  serviceId: string;
}

/** 把探测结果拼成 status 对象（与旧脚本 Get-StatusObject 的取值规则一致）。 */
export function buildStatus(inputs: StatusInputs): BridgeStatus {
  const hasListener = inputs.listeners.length > 0;
  const port = hasListener ? inputs.listeners[0].port : 0;
  const pid = hasListener ? inputs.listeners[0].pid : 0;
  const healthy = inputs.health !== null && inputs.health.service === inputs.serviceId;
  const status: BridgeStatus = {
    running: port > 0,
    healthy,
    port,
    pid,
    supervisor: inputs.supervisorAlive,
    supervisorPid: inputs.saved ? inputs.saved.supervisorPid : 0,
    node: inputs.nodePath,
    nodeVersion: inputs.nodePath ? inputs.nodeVersion : "",
    edaConnected: false,
    edaWindows: 0,
    activeWindow: "",
    pending: 0,
    script: inputs.scriptPath,
    logFile: inputs.logFile,
  };
  if (healthy) {
    const health = inputs.health;
    status.edaConnected = Boolean(health?.edaConnected);
    status.edaWindows = asInt(health?.edaWindowCount);
    status.activeWindow = asText(health?.activeWindowId);
    status.pending = asInt(health?.pendingRequests);
  }
  return status;
}

/** `--json` 模式只看「有没有在跑」（旧脚本第 407 行）；文本模式要求 running && healthy。 */
export function statusExitCode(status: BridgeStatus, json: boolean): number {
  if (json) return status.running ? 0 : 1;
  return status.running && status.healthy ? 0 : 1;
}

export function formatStatusJson(status: BridgeStatus): string {
  return JSON.stringify(status, null, 2);
}

function section(io: Io, title: string): void {
  io.out("");
  io.out(paint.cyan(`  ${title}`));
  io.out(paint.gray(`  ${hr()}`));
}

/** `  Key : value` —— 键固定深灰，值按需着色（对应旧脚本的 Row）。 */
function row(io: Io, key: string, value: string, color: PaintKey = "gray"): void {
  io.out(`${paint.gray(`  ${key} : `)}${paint[color](value)}`);
}

/** 旧脚本的 Fail：红色整行 + `  [X] ` 前缀，调用方据此设置 exit 1。 */
function fail(io: Io, text: string): void {
  io.out(paint.red(`  [X] ${text}`));
}

function printNodeFixes(io: Io): void {
  for (const line of NODE_FIX_LINES) io.out(line);
}

function reportMissingNode(io: Io): void {
  fail(io, "没有能用的 node.exe。跑 lceda-bridge doctor 看候选；修法:");
  printNodeFixes(io);
}

export interface BridgePorts {
  portFirst: number;
  portLast: number;
}

/** status 的文本输出（旧脚本 Invoke-Status 的行文案与颜色）。 */
export function statusLines(
  status: BridgeStatus,
  ports: BridgePorts,
  logSize: number | null,
): string[] {
  const lines: string[] = [];
  const add = (text: string, color: PaintKey = "gray"): void => {
    lines.push(paint[color](text));
  };
  const addRow = (key: string, value: string, color: PaintKey = "gray"): void => {
    lines.push(`${paint.gray(`  ${key} : `)}${paint[color](value)}`);
  };

  lines.push("");
  add("  嘉立创 EDA Bridge", "cyan");
  add(`  ${hr()}`, "gray");

  if (status.running) {
    addRow("服务状态", "运行中", "green");
    addRow("监听端口", `${status.port}   (pid ${status.pid})`);
  } else {
    addRow("服务状态", "未运行", "yellow");
    addRow("监听端口", `${ports.portFirst}-${ports.portLast} 全部空闲`, "gray");
  }

  if (status.running) {
    if (status.healthy) addRow("健康检查", "ok", "green");
    else addRow("健康检查", "端口有监听但 /health 无响应（进程可能卡死，试试 restart）", "red");

    if (status.healthy) {
      if (status.edaConnected) addRow("EDA 连接", `已连接 · ${status.edaWindows} 个窗口`, "green");
      else addRow("EDA 连接", "未连接 —— 到 EasyEDA Pro 里点一下扩展的「重新连接」", "yellow");
      if (status.activeWindow) addRow("活动窗口", status.activeWindow);
      addRow("待处理数", `${status.pending}`);
    }
  }

  if (status.supervisor) {
    addRow("守护进程", `运行中 (pid ${status.supervisorPid}) · 崩溃后 3 秒自动重启`, "green");
  } else if (status.running) {
    addRow("守护进程", "无 —— 由外部进程启动，stop 时会一并清掉");
  } else {
    addRow("守护进程", "无");
  }

  if (status.node) {
    const version = status.nodeVersion ? `  (${status.nodeVersion})` : "";
    addRow("运行内核", `${status.node}${version}`);
  } else {
    addRow("运行内核", "没找到能用的 node.exe —— 跑 lceda-bridge doctor 看原因", "red");
  }

  if (status.script) addRow("服务脚本", status.script);
  else addRow("服务脚本", "未找到 bridge-server.mjs（设 LCEDA_BRIDGE_SCRIPT 指定）", "red");

  if (logSize !== null) addRow("日志文件", `${status.logFile}   (${formatSize(logSize)})`);
  else addRow("日志文件", `${status.logFile}   (还没有)`);

  lines.push("");
  return lines;
}

/** 对应旧脚本 Show-Help 的正文（选项写成新 CLI 的 --flag 形式）。 */
export function bridgeActionHelpLines(bridge: BridgeConfig): string[] {
  return [
    "",
    paint.cyan("  lceda-bridge  --  嘉立创 EDA (EasyEDA Pro) AI Bridge 管理"),
    paint.gray(`  ${hr()}`),
    "  用法: lceda-bridge <动作> [选项]",
    "",
    paint.white("  动作:"),
    "    start      后台启动（隐藏窗口，崩溃 3 秒后自动重启）",
    "    stop       停止（连进程树一起清，再兜底扫端口）",
    "    restart    stop + start",
    "    status     看状态（默认动作）",
    "    logs       看日志",
    "    doctor     环境自检（node 候选、脚本、ws 依赖、端口）",
    "    run        前台运行（调试用，等同老的 start bat）",
    "    help       这个帮助",
    "",
    paint.white("  选项:"),
    "    --json     status 输出 JSON，便于脚本/Agent 解析",
    "    --lines N  logs 显示最近 N 行（默认 40）",
    "    --follow   logs 实时跟随（Ctrl+C 退出）",
    "    --once     start/run 只跑一次，不自动重启",
    "",
    paint.white("  例子:"),
    "    lceda-bridge start",
    "    lceda-bridge status",
    "    lceda-bridge status --json",
    "    lceda-bridge logs --follow",
    "    lceda-bridge restart",
    "    lceda-bridge doctor",
    "",
    paint.gray(
      `  端口: ${bridge.portFirst}-${bridge.portLast}   健康检查: http://${bridge.bindHost}:${bridge.portFirst}/health`,
    ),
    paint.gray(`  日志: ${bridge.logFile}`),
    "",
  ];
}

// ─── 运行时小工具 ────────────────────────────────────────────────────

function spawnBridge(
  file: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess | null {
  try {
    return spawn(file, [...args], options);
  } catch {
    return null;
  }
}

/** 前台跑（继承 stdio，输出直接打到当前终端），返回子进程退出码。 */
function runForeground(
  nodePath: string,
  scriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const child = spawnBridge(nodePath, [scriptPath], {
      stdio: "inherit",
      windowsHide: true,
      env,
    });
    if (!child) {
      finish(-1);
      return;
    }
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** 后台跑并把 stdout+stderr 都追加进日志（对应旧脚本 `& $node $brg *>&1 | Out-File -Append`）。 */
function runToLog(
  nodePath: string,
  scriptPath: string,
  logFile: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const child = spawnBridge(nodePath, [scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    if (!child) {
      appendLog(logFile, "spawn failed\n");
      finish(-1);
      return;
    }
    const write = (chunk: Buffer | string): void => {
      appendLog(logFile, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    child.on("error", (error: Error) => {
      appendLog(logFile, `${error.message}\n`);
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}

// ─── status ──────────────────────────────────────────────────────────

async function runStatus(options: BridgeOptions, ctx: CommandContext): Promise<number> {
  const bridge = ctx.cfg.bridge;
  const listeners = await listListeners(bridge.portFirst, bridge.portLast);
  const port = listeners.length > 0 ? listeners[0].port : 0;
  const health = port > 0 ? await probeHealth(port, bridge.bindHost) : null;
  const saved = readBridgeState(bridge.stateFile);
  const supervisorPid = saved ? saved.supervisorPid : 0;
  const node = await resolveNodeFor(bridge, ctx.env);
  const script = resolveBridgeScriptWithBuiltin(bridge, ctx.env);

  const status = buildStatus({
    listeners,
    health,
    saved,
    supervisorAlive: supervisorPid > 0 ? isPidAlive(supervisorPid) : false,
    nodePath: node ? node.path : null,
    nodeVersion: node ? node.version : "",
    scriptPath: script ? script.path : null,
    logFile: bridge.logFile,
    serviceId: bridge.serviceId,
  });

  if (options.json) {
    ctx.io.out(formatStatusJson(status));
    return statusExitCode(status, true);
  }

  const logSize = exists(bridge.logFile) ? fileSize(bridge.logFile) : null;
  for (const line of statusLines(status, bridge, logSize)) ctx.io.out(line);
  return statusExitCode(status, false);
}

// ─── stop ────────────────────────────────────────────────────────────

async function runStop(ctx: CommandContext): Promise<number> {
  const bridge = ctx.cfg.bridge;
  const io = ctx.io;
  const processes = await listProcesses();
  const targets = collectStopTargets(processes, selfEntryCandidates(selfEntryPath()), process.pid);
  const listeners = await listListeners(bridge.portFirst, bridge.portLast);

  if (targets.length === 0 && listeners.length === 0) {
    removeFile(bridge.stateFile);
    io.out("");
    io.out(
      paint.yellow(`  bridge 本来就没在跑（${bridge.portFirst}-${bridge.portLast} 全空闲）。`),
    );
    io.out("");
    return 0;
  }

  io.out("");
  io.out(paint.cyan("  正在停止 EasyEDA Bridge ..."));

  const killed: number[] = [];
  const unknownListeners: TcpListener[] = [];
  for (const target of targets) {
    io.out(
      paint.gray(
        `    - ${target.name.padEnd(10)} pid ${String(target.pid).padEnd(7)} ${target.kind}`,
      ),
    );
    await killProcessTree(target.pid);
    killed.push(target.pid);
  }
  for (const listener of listeners) {
    if (killed.includes(listener.pid)) continue;
    const health = await probeHealth(listener.port, bridge.bindHost);
    const verified = listenerStopDecision(health, bridge.serviceId) === "verified";
    if (!verified) {
      unknownListeners.push(listener);
      continue;
    }
    io.out(paint.gray(`    - port ${listener.port}  pid ${listener.pid}`));
    await killProcessTree(listener.pid);
    killed.push(listener.pid);
  }

  if (unknownListeners.length > 0) {
    io.out(
      paint.yellow(
        `    跳过未知 listener: ${unknownListeners.map((item) => `${item.port}/pid ${item.pid}`).join(", ")}`,
      ),
    );
  }

  // 兜底：等已验证 bridge 端口真正释放；未知 listener 始终跳过
  let left: TcpListener[] = [];
  for (let attempt = 0; attempt < STOP_POLL_ATTEMPTS; attempt += 1) {
    left = await listListeners(bridge.portFirst, bridge.portLast);
    if (left.length === 0) break;
    for (const listener of left) {
      if (killed.includes(listener.pid)) continue;
      if (unknownListeners.some((item) => item.pid === listener.pid)) continue;
      const health = await probeHealth(listener.port, bridge.bindHost);
      if (listenerStopDecision(health, bridge.serviceId) !== "verified") continue;
      await killProcessTree(listener.pid);
      killed.push(listener.pid);
    }
    await sleep(STOP_POLL_MS);
  }

  removeFile(bridge.stateFile);

  if (left.length === 0) {
    io.out("");
    io.out(paint.green(`  已停止（清理 ${killed.length} 个进程）。`));
    io.out(paint.yellow("  注意：EasyEDA 里的扩展已断开，下次使用前要在扩展里重新连接。"));
    io.out("");
    return 0;
  }

  io.out("");
  io.out(
    paint.red(`  端口仍被占用: ${left.map((item) => `${item.port}/pid ${item.pid}`).join(", ")}`),
  );
  io.out(paint.yellow("  可能权限不足，请用管理员身份再执行一次。"));
  io.out("");
  return 1;
}

// ─── start ───────────────────────────────────────────────────────────

async function runStart(options: BridgeOptions, ctx: CommandContext): Promise<number> {
  const bridge = ctx.cfg.bridge;
  const io = ctx.io;
  const listeners = await listListeners(bridge.portFirst, bridge.portLast);

  if (listeners.length > 0) {
    const first = listeners[0];
    const health = await probeHealth(first.port, bridge.bindHost);
    if (health !== null && health.service === bridge.serviceId) {
      // --json 时一句人类可读的话都不能混进 stdout
      if (!options.json) {
        io.out("");
        io.out(paint.yellow("  已经在跑了，不重复启动。"));
      }
      return await runStatus(options, ctx);
    }
    io.out("");
    io.out(paint.red(`  端口 ${first.port} 被 pid ${first.pid} 占着，但不是 bridge 的健康响应。`));
    io.out(paint.yellow("  先 lceda-bridge stop 清掉，或换个时间再试。"));
    io.out("");
    return 1;
  }

  const node = await resolveNodeFor(bridge, ctx.env);
  if (!node) {
    reportMissingNode(io);
    return 1;
  }

  const script = resolveBridgeScriptWithBuiltin(bridge, ctx.env);
  if (!script) {
    fail(
      io,
      "找不到 bridge-server.mjs，也没有内置服务（dist/cli-bridge-server.mjs）。用环境变量 LCEDA_BRIDGE_SCRIPT 指定。",
    );
    return 1;
  }

  ensureDir(bridge.runtimeDir);

  io.out("");
  io.out(paint.cyan("  正在后台启动 bridge ..."));
  io.out(paint.gray(`    node   : ${node.path}`));
  io.out(paint.gray(`    script : ${script.builtin ? `${script.path}（内置）` : script.path}`));
  io.out(paint.gray(`    log    : ${bridge.logFile}`));

  const command = buildSuperviseCommand(selfEntryPath(), node.path, options);
  const child = spawnDetached(command.file, command.args, {
    env: buildBridgeChildEnv(ctx.env, node.path, script.path),
  });
  const supervisorPid = child.pid ?? 0;

  // 等健康检查通过
  const deadline = Date.now() + bridge.startWaitMs;
  let port = 0;
  let health: BridgeHealth | null = null;
  do {
    await sleep(HEALTH_POLL_MS);
    const probe = await listListeners(bridge.portFirst, bridge.portLast);
    if (probe.length > 0) {
      port = probe[0].port;
      health = await probeHealth(port, bridge.bindHost);
    }
  } while (health === null && Date.now() < deadline);

  if (health === null) {
    io.out("");
    io.out(
      paint.red(
        `  启动超时（${Math.round(bridge.startWaitMs / 1000)} 秒内 /health 没起来）。日志尾部：`,
      ),
    );
    for (const line of tailLog(bridge.logFile, START_FAIL_LOG_LINES)) {
      io.out(paint.gray(`    ${line}`));
    }
    return 1;
  }

  io.out("");
  io.out(paint.green(`  已启动。端口 ${port} ，守护进程 pid ${supervisorPid} 。`));
  if (!health.edaConnected) {
    io.out(paint.yellow("  EDA 扩展还没连上 —— 到 EasyEDA Pro 里点扩展的「重新连接」。"));
  } else {
    io.out(paint.green(`  EDA 扩展已连接（${asInt(health.edaWindowCount)} 个窗口）。`));
  }
  io.out("");
  return 0;
}

// ─── restart ─────────────────────────────────────────────────────────

async function runRestart(options: BridgeOptions, ctx: CommandContext): Promise<number> {
  const stopCode = await runStop(ctx);
  if (stopCode !== 0) return stopCode;
  await sleep(RESTART_SETTLE_MS);
  // 旧脚本的 Invoke-Restart 没有把 -Once 透给 Invoke-Start，这里保持一致
  return await runStart({ ...options, once: false }, ctx);
}

// ─── logs ────────────────────────────────────────────────────────────

async function runLogs(options: BridgeOptions, ctx: CommandContext): Promise<number> {
  const io = ctx.io;
  const logFile = ctx.cfg.bridge.logFile;
  if (!exists(logFile)) {
    io.out("");
    io.out(paint.yellow(`  还没有日志文件：${logFile}`));
    io.out(paint.yellow("  先 lceda-bridge start 跑起来再来看。"));
    io.out("");
    return 1;
  }

  for (const line of tailLog(logFile, options.lines)) io.out(line);
  if (!options.follow) return 0;

  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await followLog(logFile, io, controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return 0;
}

// ─── run（前台调试模式）────────────────────────────────────────────────

async function runRun(options: BridgeOptions, ctx: CommandContext): Promise<number> {
  const bridge = ctx.cfg.bridge;
  const io = ctx.io;
  const node = await resolveNodeFor(bridge, ctx.env);
  if (!node) {
    reportMissingNode(io);
    return 1;
  }
  const script = resolveBridgeScriptWithBuiltin(bridge, ctx.env);
  if (!script) {
    fail(
      io,
      "找不到 bridge-server.mjs，也没有内置服务（dist/cli-bridge-server.mjs）。用环境变量 LCEDA_BRIDGE_SCRIPT 指定。",
    );
    return 1;
  }

  ensureDir(bridge.runtimeDir);
  const childEnv = buildBridgeChildEnv(ctx.env, node.path, script.path);

  io.out("");
  io.out(paint.cyan("  ============================================================"));
  io.out(paint.cyan("   EasyEDA Bridge Server  (前台运行)"));
  io.out(paint.cyan("  ============================================================"));
  io.out(paint.gray(`   node   : ${node.path}`));
  io.out(paint.gray(`   script : ${script.builtin ? `${script.path}（内置）` : script.path}`));
  io.out("");
  io.out(paint.gray(`   health : http://${bridge.bindHost}:${bridge.portFirst}/health`));
  io.out(paint.gray(`   ports  : ${bridge.portFirst}-${bridge.portLast}（第一个空闲的会被占用）`));
  io.out("");
  io.out(paint.gray("   平时用 lceda-bridge start 后台跑就行；这里是前台调试模式。"));
  io.out(paint.gray("   按 Ctrl+C 停止。"));
  io.out(paint.gray("  ------------------------------------------------------------"));
  io.out("");

  for (;;) {
    io.out(paint.gray(`[${localTimestamp()}] starting bridge ...`));
    const code = await runForeground(node.path, script.path, childEnv);
    io.out("");
    io.out(paint.yellow(`[${localTimestamp()}] bridge exited (code ${code})`));
    if (options.once) return code;
    io.out(paint.gray("    restarting in 3s ...   (Ctrl+C to stop)"));
    await sleep(bridge.restartDelayMs);
  }
}

// ─── supervise（内部动作：隐藏的守护进程）────────────────────────────────

async function runSupervise(options: BridgeOptions, ctx: CommandContext): Promise<number> {
  const bridge = ctx.cfg.bridge;
  let node = await resolveNodeFor(bridge, ctx.env);
  const script = resolveBridgeScriptWithBuiltin(bridge, ctx.env);

  if (!script || !node) {
    appendLog(
      path.join(os.tmpdir(), SUPERVISE_ERR_FILE),
      `[${localTimestampSeconds()}] missing node or script\n`,
    );
    return 1;
  }

  ensureDir(bridge.runtimeDir);

  writeBridgeState(bridge.stateFile, {
    supervisorPid: process.pid,
    node: node.path,
    script: script.path,
    startedAt: localTimestampSeconds(),
    log: bridge.logFile,
  });

  try {
    for (;;) {
      // vp 可能把这版 node 清掉了（vp env clean / uninstall），重启前确认一下
      if (!exists(node.path)) {
        resetNodeCache();
        const again = await resolveNodeFor(bridge, ctx.env);
        appendLog(
          bridge.logFile,
          superviseNodeGoneMarker(localTimestamp(), again ? again.path : ""),
        );
        if (!again) {
          appendLog(bridge.logFile, superviseNoNodeMarker(localTimestamp()));
          if (options.once) break;
          await sleep(SUPERVISE_RETRY_MS);
          continue;
        }
        node = again;
      }

      rotateLogIfNeeded(bridge.logFile, bridge.maxLogBytes);
      appendLog(bridge.logFile, superviseStartMarker(localTimestamp()));

      const code = await runToLog(
        node.path,
        script.path,
        bridge.logFile,
        buildBridgeChildEnv(ctx.env, node.path, script.path),
      );

      appendLog(bridge.logFile, superviseExitMarker(localTimestamp(), code));

      if (options.once) break;
      await sleep(bridge.restartDelayMs);
    }
  } finally {
    removeFile(bridge.stateFile);
  }
  return 0;
}

// ─── doctor（环境自检）─────────────────────────────────────────────────

async function runDoctor(ctx: CommandContext): Promise<number> {
  const bridge = ctx.cfg.bridge;
  const io = ctx.io;

  section(io, "嘉立创 EDA Bridge · 环境自检");
  io.out("");
  io.out(paint.white("  node 候选（按优先级，第一个真能跑的会被选中）:"));

  resetNodeCache();
  const candidates = nodeCandidates(ctx.env);
  let chosen: string | null = null;
  let chosenVersion = "";
  if (candidates.length === 0) io.out(paint.darkRed("    （一个候选都没找到）"));
  for (const candidate of candidates) {
    const version = await probeNodeVersion(candidate.path);
    if (version) {
      io.out(paint.green(`    [OK] ${version}  · ${candidate.source}  · ${candidate.path}`));
      if (!chosen) {
        chosen = candidate.path;
        chosenVersion = version;
      }
    } else {
      io.out(paint.darkRed(`    [X ] --         · ${candidate.source}  · ${candidate.path}`));
    }
  }

  io.out("");
  if (chosen) {
    row(io, "选用 node", `${chosen}  (${chosenVersion})`, "green");
  } else {
    row(io, "选用 node", "没有可用的，bridge 起不来", "red");
    io.out("");
    io.out(paint.white("  修法（任选一种）:"));
    printNodeFixes(io);
  }

  const script = resolveBridgeScriptWithBuiltin(bridge, ctx.env);
  if (script) {
    row(io, "服务脚本", script.builtin ? `${script.path}  （内置）` : script.path, "green");
    if (script.builtin) {
      // 内置服务随包发布，ws 已经在 dependencies 里，不需要外部技能的 node_modules
      row(io, "依赖 ws", "内置服务自带，无需外部 node_modules", "green");
    } else {
      const skillRoot = path.dirname(path.dirname(script.path));
      const wsDir = path.join(skillRoot, "node_modules", "ws");
      if (exists(wsDir)) row(io, "依赖 ws", wsDir, "green");
      else row(io, "依赖 ws", `缺 ${wsDir}（在 easyeda-api 目录跑 npm install）`, "red");
    }
  } else {
    row(io, "服务脚本", "找不到 bridge-server.mjs，也没有内置服务", "red");
    io.out(paint.gray("              设 LCEDA_BRIDGE_SCRIPT 指向它的绝对路径"));
  }

  const listeners = await listListeners(bridge.portFirst, bridge.portLast);
  if (listeners.length > 0) {
    row(io, "当前实例", `在跑 · 端口 ${listeners[0].port} · pid ${listeners[0].pid}`, "green");
  } else {
    row(io, "当前实例", "没在跑");
  }

  row(io, "日志目录", bridge.runtimeDir);
  row(io, "宿主 shell", `Node ${process.version}  ${process.execPath}`);
  if (ctx.env.LCEDA_NODE) row(io, "环境覆盖", `LCEDA_NODE = ${ctx.env.LCEDA_NODE}`, "yellow");
  if (ctx.env.LCEDA_BRIDGE_SCRIPT) {
    row(io, "环境覆盖", `LCEDA_BRIDGE_SCRIPT = ${ctx.env.LCEDA_BRIDGE_SCRIPT}`, "yellow");
  }
  io.out("");

  return chosen !== null && script !== null ? 0 : 1;
}

// ─── help ────────────────────────────────────────────────────────────

function runHelp(ctx: CommandContext): number {
  for (const line of bridgeActionHelpLines(ctx.cfg.bridge)) ctx.io.out(line);
  return 0;
}

// ─── 入口：动作 → 实现（含别名映射）───────────────────────────────────

/**
 * Bridge 命令入口。返回值就是进程退出码。
 * 别名与旧脚本一致：kill→stop、st/health→status、log→logs、check/env→doctor。
 */
export async function runBridgeAction(
  action: BridgeAction,
  options: BridgeOptions,
  ctx: CommandContext,
): Promise<number> {
  switch (action.trim().toLowerCase()) {
    case "start":
      return await runStart(options, ctx);
    case "stop":
    case "kill":
      return await runStop(ctx);
    case "restart":
      return await runRestart(options, ctx);
    case "status":
    case "st":
    case "health":
      return await runStatus(options, ctx);
    case "logs":
    case "log":
      return await runLogs(options, ctx);
    case "doctor":
    case "check":
    case "env":
      return await runDoctor(ctx);
    case "run":
      return await runRun(options, ctx);
    case "supervise":
      return await runSupervise(options, ctx);
    case "help":
    case "--help":
    case "-h":
      return runHelp(ctx);
    default:
      ctx.io.out("");
      ctx.io.out(paint.red(`  不认识的命令: ${action}`));
      for (const line of bridgeActionHelpLines(ctx.cfg.bridge)) ctx.io.out(line);
      return 1;
  }
}
