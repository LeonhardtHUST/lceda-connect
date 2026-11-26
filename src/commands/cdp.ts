import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { AppConfig, CdpConfig } from "../core/config.ts";
import { parseBrowserUuidLine } from "../cdp/discover.ts";
import { run } from "../core/exec.ts";
import { ensureDir, exists, listDirs, readText, removeFile, writeText } from "../core/fsx.ts";
import type { Io } from "../core/io.ts";
import { parseDevToolsActivePort, probeCdpVersion } from "../core/netprobe.ts";
import { paint } from "../core/term.ts";
import type { ProcInfo } from "../core/types.ts";
import { isPidAlive, listProcesses, sleep, terminateProcess } from "../core/windows.ts";
import type { CdpAction, CdpOptions, CommandContext } from "./types.ts";

/**
 * CDP 子命令实现。
 * 对应旧脚本：C:\Users\Leon\.lceda-cdp\lceda-cdp.ps1（action: start|ensure|status|endpoint|stop）。
 *
 * 只管理本工具自己启动的实例：pid 记在 cfg.cdp.pidFile（第 1 行 pid，第 2 行镜像绝对路径），
 * 停止 / 判活前校验镜像路径，避免 PID 复用误杀别的进程。
 *
 * 安全边界：本模块不修改注册表、不改系统设置、不结束非受管进程；
 * 唯一的破坏性动作是 stop --yes 结束 pid 文件里记录且镜像校验通过的那个进程。
 */

// ─── 常量（与旧脚本保持同一套时序） ────────────────────────────────────

/** 启动前探「客户端真正要用的那条网络」：冷启动并发拉的就是这条线路。 */
const NET_PROBE_URL = "https://pro.lceda.cn/favicon.ico";
const NET_PROBE_TIMEOUT_MS = 6_000;
const NET_WAIT_INTERVAL_MS = 2_000;
/** 端点轮询间隔（旧脚本 Start-Sleep -Milliseconds 500）。 */
const ENDPOINT_POLL_MS = 500;
/** ensure 给客户端自重启留的窗口（旧脚本 30 秒）。 */
const ENSURE_WAIT_MS = 30_000;
/** stop 等进程退出的次数：40 × 500ms = 20 秒。 */
const STOP_WAIT_ATTEMPTS = 40;

/**
 * 会盖掉 Windows「系统代理」的进程级环境变量（大小写不敏感）。
 * Chromium 的代理优先级是：命令行开关 > 代理环境变量 > 系统代理；
 * 只要这几个里有一个非空，客户端就完全不理系统代理。
 */
export const PROXY_ENV_NAMES: readonly string[] = [
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "ftp_proxy",
  "no_proxy",
];

// ─── pid 文件 ────────────────────────────────────────────────────────

export interface PidRecord {
  pid: number;
  /** 记录当时的客户端镜像绝对路径，用于避开 PID 复用误杀。 */
  exe: string;
}

export interface ManagedPidFile {
  record: PidRecord;
  /** 记录实际来自哪个文件：新路径优先，旧版 pid 文件只读兼容。 */
  source: "current" | "legacy";
  file: string;
}

/** 解析两行式 pid 文件；首行必须是正整数，否则视为损坏。 */
export function parsePidRecord(text: string): PidRecord | null {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const head = (lines[0] ?? "").trim();
  if (!/^\d+$/.test(head)) return null;
  const pid = Number.parseInt(head, 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return { pid, exe: (lines[1] ?? "").trim() };
}

export function readPidRecord(file: string): PidRecord | null {
  const text = readText(file);
  return text === null ? null : parsePidRecord(text);
}

export function writePidRecord(file: string, record: PidRecord): void {
  ensureDir(path.dirname(file));
  writeText(file, `${record.pid}\n${record.exe}\n`);
}

/**
 * 读受管 pid 记录：新路径 cfg.cdp.pidFile 优先；它整个不存在时才回落到旧版
 * easyeda-cdp-connect 的 pid 文件（迁移期只读兼容，写回一律写新路径）。
 * 新文件存在但解析不出来时视为「没有受管实例」，不再回落到旧文件。
 */
export function readManagedPidFile(
  cfg: Pick<CdpConfig, "pidFile" | "legacyPidFile">,
): ManagedPidFile | null {
  if (exists(cfg.pidFile)) {
    const record = readPidRecord(cfg.pidFile);
    return record ? { record, source: "current", file: cfg.pidFile } : null;
  }
  if (exists(cfg.legacyPidFile)) {
    const record = readPidRecord(cfg.legacyPidFile);
    if (record) return { record, source: "legacy", file: cfg.legacyPidFile };
  }
  return null;
}

function normalizeExePath(value: string): string {
  return value.replace(/\//g, "\\").toLowerCase();
}

/**
 * exe 校验：镜像路径与记录不一致或镜像路径不可读都不算匹配，避免 PID 复用误杀。
 */
export function exeMatches(imagePath: string | null, recordedExe: string): boolean {
  if (!imagePath) return false;
  if (!recordedExe) return true;
  return normalizeExePath(imagePath) === normalizeExePath(recordedExe);
}

/** 清理过期 pid 文件时该动哪个（新路径优先，其次旧版只读兼容路径）。 */
export function stalePidFile(cfg: Pick<CdpConfig, "pidFile" | "legacyPidFile">): string | null {
  if (exists(cfg.pidFile)) return cfg.pidFile;
  if (exists(cfg.legacyPidFile)) return cfg.legacyPidFile;
  return null;
}

export interface ManagedProcess {
  pid: number;
  exe: string;
  /** 实际镜像路径；权限不足时为 null（此时不做路径比对）。 */
  imagePath: string | null;
}

/**
 * 读进程镜像路径。
 * core/windows.ts 目前只提供 pid 判活与进程列表（Name/CommandLine），没有镜像路径，
 * 所以这里单独查一次 Win32_Process 的 ExecutablePath 等价信息。失败一律返回 null。
 */
async function readProcessImagePath(pid: number): Promise<string | null> {
  const script =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
    `try { $p = Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop; ` +
    "if ($p -and $p.Path) { $p.Path } } catch { }";
  const result = await run(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: 10_000 },
  );
  if (result.code !== 0) return null;
  const text = result.stdout.replace(/^\uFEFF/, "").trim();
  return text === "" ? null : text;
}

/** 受管实例：pid 活着 + 镜像路径与记录一致。任一不满足都算「没在管理」。 */
async function resolveManagedProcess(cfg: CdpConfig): Promise<ManagedProcess | null> {
  const managed = readManagedPidFile(cfg);
  if (!managed) return null;
  const { pid, exe } = managed.record;
  if (!isPidAlive(pid)) return null;
  const imagePath = await readProcessImagePath(pid);
  if (!exeMatches(imagePath, exe)) return null;
  return { pid, exe, imagePath };
}

// ─── 进程列表（主实例 / 调试参数） ───────────────────────────────────

/**
 * 实际可执行的客户端路径：环境发现优先（WSL2 下是 /mnt/d/...），
 * 找不到时才退回显式/历史路径，让报错信息保持原样。
 */
export function clientExecutable(cfg: AppConfig): string {
  return cfg.client.exe?.path ?? cfg.cdp.exePath;
}

/** WMI 的 Name 带扩展名：exe 路径 → "lceda-pro.exe"。 */
export function processNameFilter(exePath: string): string {
  const base = path.win32.basename(exePath);
  return `${base.replace(/\.exe$/i, "")}.exe`;
}

/** 同一个 exe 会以 --type=renderer 等身份跑多个子进程，它们属于同一个实例。 */
function isSubProcess(commandLine: string): boolean {
  return /--type=/.test(commandLine);
}

/**
 * 只数主实例 pid：同名进程里排除命令行带 `--type=` 的子进程；
 * 一个主进程都认不出来时退回全部 pid（旧脚本同样的兜底）。
 */
export function mainInstancePids(processes: readonly ProcInfo[]): number[] {
  const mains = processes.filter(
    (proc) => proc.commandLine !== "" && !isSubProcess(proc.commandLine),
  );
  const rows = mains.length > 0 ? mains : processes;
  return rows.map((proc) => proc.pid);
}

export interface DebugFlagRow {
  pid: number;
  /** 命令行里的端口；动态端口（=0 或解析不出来）记 0。 */
  port: number;
}

/**
 * 只列「命令行里带了调试端口」的主实例。端点没了要靠它区分两类成因：
 * 一类根本没带参数（图标启动 / 升级后自重启丢参），一类带了但端口没起来。
 */
export function debugFlagRows(processes: readonly ProcInfo[]): DebugFlagRow[] {
  const rows: DebugFlagRow[] = [];
  for (const proc of processes) {
    if (!proc.commandLine) continue;
    if (isSubProcess(proc.commandLine)) continue;
    if (!/--remote-debugging-port=/.test(proc.commandLine)) continue;
    const match = /--remote-debugging-port=(\d+)/.exec(proc.commandLine);
    const port = match ? Number.parseInt(match[1] ?? "", 10) : 0;
    rows.push({ pid: proc.pid, port: Number.isFinite(port) && port > 0 ? port : 0 });
  }
  return rows;
}

/** 诊断文案里的 "PID 44012→9222, PID 44216→动态"。 */
export function formatDebugFlagRows(rows: readonly DebugFlagRow[]): string {
  return rows.map((row) => `PID ${row.pid}→${row.port > 0 ? String(row.port) : "动态"}`).join(", ");
}

async function instanceProcesses(cfg: CdpConfig): Promise<ProcInfo[]> {
  return await listProcesses(processNameFilter(cfg.exePath));
}

async function instancePids(cfg: CdpConfig): Promise<number[]> {
  return mainInstancePids(await instanceProcesses(cfg));
}

// ─── 代理环境变量 ────────────────────────────────────────────────────

/**
 * 清掉进程级代理环境变量，返回被清掉的 "name=value"（用于逐条回显）。
 *
 * 为什么默认清：这些变量通常不是用户自己设的，而是某个终端或工具临时塞进环境的，
 * 只对那个终端及其子进程有效。从这个环境里拉起客户端，它会去连一个只给那个终端
 * 开的代理：冷启动并发十几个请求全部连不上 → 白屏，和「网络断了」长得一模一样。
 * 需要沿用的用户加 --keep-proxy-env。
 *
 * 传进来的 env 对象会被就地修改（生产环境里它就是 process.env，子进程才能继承到
 * 清理后的环境）；测试请传入自己的对象，不要传真实 process.env。
 */
export function clearProxyEnvironment(env: NodeJS.ProcessEnv): string[] {
  const cleared: string[] = [];
  // 先取快照再删，等价于旧脚本的 `@($snapshot.Keys)`。
  for (const key of Object.keys(env)) {
    if (!PROXY_ENV_NAMES.includes(key.toLowerCase())) continue;
    cleared.push(`${key}=${env[key] ?? ""}`);
    delete env[key];
  }
  return cleared;
}

// ─── 启动参数 ────────────────────────────────────────────────────────

/**
 * 调试端口放在第一位，兼容只透传 process.argv[1] 的客户端重启路径。
 * 为兼容不识别 --remote-debugging-address 的客户端，监听地址交由 Chromium 默认处理。
 */
export function buildStartArgs(port: number, proxyServer?: string): string[] {
  const args = [`--remote-debugging-port=${port}`];
  if (proxyServer) {
    // 显式代理优先：绕开「系统代理尚未生效」的启动窗口期。
    args.push(`--proxy-server=${proxyServer}`);
  }
  return args;
}

// ─── 网络预检 / 端点解析 ─────────────────────────────────────────────

/**
 * 探「客户端真正要用的那条网络」。客户端冷启动时会并发拉十来个 API / 图片，
 * 一旦那一刻网络没通，每个请求都要挂到 TCP 超时（实测 ~80 s、transferSize=0），
 * 用户看到的就是「窗口 30 s 不出 + 出来以后白屏」。这里提前说清楚。
 */
export async function probeNetReady(
  timeoutMs = NET_PROBE_TIMEOUT_MS,
  url = NET_PROBE_URL,
): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

export function endpointUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

/**
 * 扫描 %LOCALAPPDATA% 下名字以 LCEDA / EasyEDA 开头的目录，找其 cache.* 子目录里的
 * DevToolsActivePort（Chromium 自己写下来的实际端口）。只在 port<=0（让客户端
 * 自己挑端口）时用得上。
 */
export function listDevToolsActivePortFiles(localAppData: string): string[] {
  if (!localAppData) return [];
  const files: string[] = [];
  for (const root of listDirs(localAppData)) {
    if (!/^(LCEDA|EasyEDA)/i.test(path.basename(root))) continue;
    for (const cache of listDirs(root)) {
      if (!/^cache\./i.test(path.basename(cache))) continue;
      const portFile = path.join(cache, "DevToolsActivePort");
      if (!exists(portFile)) continue;
      files.push(portFile);
    }
  }
  return files;
}

/** DevToolsActivePort 的两行内容：第 1 行端口，第 2 行 `/devtools/browser/<uuid>`。 */
export interface DevToolsActivePortRecord {
  port: number;
  /** 文件记录的 browser uuid；第二行缺失或不是标准路径时为空串。 */
  uuid: string;
}

/**
 * 解析 DevToolsActivePort：端口沿用 core/netprobe 的实现（保持既有行为），
 * uuid 取第二行 `/devtools/browser/<uuid>` 的最后一段。
 *
 * 为什么要 uuid：端口文件可能是上次运行、甚至另一个 profile 留下的过期文件；
 * 只有 uuid 与 `/json/version` 返回的一致，才能确认是当前实例。
 */
export function parseDevToolsActivePortRecord(text: string): DevToolsActivePortRecord {
  return { port: parseDevToolsActivePort(text), uuid: parseBrowserUuidLine(secondLine(text)) };
}

/** 取第 2 行（保留空行语义：只有一行时返回空串），去掉 BOM。 */
function secondLine(text: string): string {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  return lines[1] ?? "";
}

/**
 * 解析当前活动端口：先探配置端口（/json/version 里有 Browser 才算），
 * 否则再扫 DevToolsActivePort。探不到返回 0。
 */
async function resolveActivePort(cfg: CdpConfig, env: NodeJS.ProcessEnv): Promise<number> {
  if (cfg.port > 0) {
    const info = await probeCdpVersion(cfg.port, cfg.bindHost);
    return info ? cfg.port : 0;
  }
  for (const file of listDevToolsActivePortFiles(env.LOCALAPPDATA ?? "")) {
    const record = parseDevToolsActivePortRecord(readText(file) ?? "");
    if (record.port <= 0) continue;
    const info = await probeCdpVersion(record.port, cfg.bindHost);
    if (info) return record.port;
  }
  return 0;
}

/** start 用：先等 500ms 再探（给客户端一个起端口的时间）。 */
async function waitForActivePort(
  cfg: CdpConfig,
  env: NodeJS.ProcessEnv,
  budgetMs: number,
): Promise<number> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(ENDPOINT_POLL_MS);
    const port = await resolveActivePort(cfg, env);
    if (port > 0) return port;
  }
  return 0;
}

/** ensure 用：先探一次，不行再等，直到预算用完。 */
async function waitForEndpoint(
  cfg: CdpConfig,
  env: NodeJS.ProcessEnv,
  budgetMs: number,
): Promise<number> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const port = await resolveActivePort(cfg, env);
    if (port > 0) return port;
    if (Date.now() >= deadline) return 0;
    await sleep(ENDPOINT_POLL_MS);
  }
}

// ─── 启动客户端 ──────────────────────────────────────────────────────

interface LaunchResult {
  pid: number | null;
  /** stderr 是否落到了日志文件；false 表示走了兼容路径。 */
  redirected: boolean;
}

function spawnClient(
  exePath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdio: "ignore" | readonly ["ignore", "ignore", number],
): number | null {
  try {
    const child = spawn(exePath, [...args], {
      detached: true,
      stdio: stdio === "ignore" ? "ignore" : [...stdio],
      windowsHide: true,
      cwd: path.dirname(exePath),
      env,
    });
    // 启动失败（ENOENT 等）走 error 事件；不挂监听会变成未捕获异常。
    child.on("error", () => {});
    child.unref();
    return typeof child.pid === "number" ? child.pid : null;
  } catch {
    return null;
  }
}

/**
 * 隐藏子进程启动，stderr 重定向到日志文件。
 * 打不开日志或 spawn 直接失败时，退回「不重定向」的兼容路径（等价旧脚本的 .NET 分支），
 * 并提示 stderr 未落盘——只影响日志，不影响连接。
 */
function launchClient(
  exePath: string,
  args: readonly string[],
  logFile: string,
  env: NodeJS.ProcessEnv,
): LaunchResult {
  let fd: number | null = null;
  try {
    ensureDir(path.dirname(logFile));
    fd = fs.openSync(logFile, "a");
  } catch {
    fd = null;
  }

  if (fd !== null) {
    const pid = spawnClient(exePath, args, env, ["ignore", "ignore", fd]);
    try {
      // 子进程已复制 fd，关掉自己的副本。
      fs.closeSync(fd);
    } catch {
      // 忽略：关不掉不影响客户端运行
    }
    if (pid !== null) return { pid, redirected: true };
  }

  return { pid: spawnClient(exePath, args, env, "ignore"), redirected: false };
}

// ─── 输出 ────────────────────────────────────────────────────────────

type Painter = (text: string) => string;

const identity: Painter = (text) => text;

/**
 * 输出出口：人类文案走 io.out（对齐旧脚本的 Write-Host），
 * --json 模式下人类文案全部闭嘴，stdout 里只留一份 JSON。
 */
class Reporter {
  private readonly io: Io;
  private readonly json: boolean;

  constructor(io: Io, json: boolean) {
    this.io = io;
    this.json = json;
  }

  say(line: string, painter: Painter = identity): void {
    if (this.json) return;
    this.io.out(painter(line));
  }

  emit(value: unknown): void {
    if (!this.json) return;
    this.io.out(JSON.stringify(value, null, 2));
  }
}

// ─── start ───────────────────────────────────────────────────────────

async function runStart(
  options: CdpOptions,
  ctx: CommandContext,
  label: "start" | "ensure" = "start",
): Promise<number> {
  const { cfg, env } = ctx;
  const reporter = new Reporter(ctx.io, options.json);

  // WSL2 NAT 下客户端在 Windows 宿主、MCP 在 Linux 虚拟机：能拉起进程但探测不到端点，
  // 与其等 60 秒超时，不如直接把可执行的下一步说清楚。
  const chosenLocation = cfg.client.exe?.location ?? cfg.environment.clientLocations[0] ?? "host";
  if (
    cfg.environment.kind === "wsl2" &&
    cfg.environment.networkingMode !== "mirrored" &&
    chosenLocation === "host"
  ) {
    const reason =
      "WSL2 NAT + 客户端在 Windows 宿主：跨命名空间，CDP 端点不可达，start/ensure 无法完成握手";
    reporter.say(reason, paint.red);
    reporter.say(
      "可选：① 在 Windows 侧运行 MCP（npm i -g lceda-connect）；② 启用 WSL mirrored 网络；③ 客户端装进 WSL VM 后按 --lceda-in vm 使用。",
      paint.yellow,
    );
    reporter.emit({ action: label, ok: false, reason, reason_code: "CROSS_OS_LOOPBACK" });
    return 2;
  }

  const exePath = clientExecutable(cfg);
  const managed = await resolveManagedProcess(cfg.cdp);
  if (managed) {
    reporter.say(`已经在运行（PID ${managed.pid}）。先执行 stop --yes。`, paint.yellow);
    reporter.emit({ action: label, ok: false, reason: `已经在运行（PID ${managed.pid}）` });
    return 1;
  }

  const processes = await instanceProcesses(cfg.cdp);
  const instances = mainInstancePids(processes);
  if (instances.length > 0 && !options.force) {
    const reason = `检测到已有客户端实例在运行（PID ${instances.join(", ")}）。`;
    reporter.say(reason, paint.yellow);
    reporter.say(
      "客户端是单实例的：新启动的参数会被转交给已有实例后丢弃，端口不会开。",
      paint.yellow,
    );
    if (debugFlagRows(processes).length === 0) {
      reporter.say(
        "这个实例的命令行里没有 --remote-debugging-port：从图标启动的，或自重启时参数丢了。",
        paint.yellow,
      );
    }
    reporter.say(
      "请先完全退出客户端再 start。确实要并行开一个时加 --force，但两个实例会争抢同一份数据。",
    );
    reporter.emit({ action: label, ok: false, reason });
    return 1;
  }
  if (instances.length > 0) {
    reporter.say(
      `警告：已有客户端实例（PID ${instances.join(", ")}），仍按 --force 继续。数据可能互相覆盖。`,
      paint.yellow,
    );
  }

  if (!exists(exePath)) {
    const reason = `找不到客户端主程序：${exePath}`;
    reporter.say(reason, paint.red);
    reporter.say("用 --exe 传入实际路径（或设置环境变量 LCEDA_PRO_EXE）。");
    reporter.emit({ action: label, ok: false, reason });
    return 1;
  }

  ensureDir(cfg.cdp.runtimeDir);

  // 先处理代理环境变量再拼参数：环境变量会盖掉系统代理，是白屏的头号嫌疑人。
  // 注意顺序——必须在 spawn 之前清，否则客户端已经继承到了。
  if (options.keepProxyEnv) {
    reporter.say("按 --keep-proxy-env 保留继承来的代理环境变量。", paint.yellow);
  } else {
    const cleared = clearProxyEnvironment(env);
    if (cleared.length > 0) {
      reporter.say("已清掉进程级代理环境变量（客户端改走 Windows 系统代理）：", paint.green);
      for (const item of cleared) reporter.say(`    ${item}`);
    }
  }

  const startArgs = buildStartArgs(cfg.cdp.port, options.proxyServer);

  let ready = await probeNetReady();
  if (!ready && options.waitOnlineSec > 0) {
    reporter.say(
      `网络未就绪，最多等 ${options.waitOnlineSec} 秒（先让代理 / 校园网连上）…`,
      paint.yellow,
    );
    const onlineDeadline = Date.now() + options.waitOnlineSec * 1000;
    while (Date.now() < onlineDeadline) {
      await sleep(NET_WAIT_INTERVAL_MS);
      if (await probeNetReady()) {
        ready = true;
        break;
      }
    }
  }
  if (ready) {
    if (options.waitOnlineSec > 0) reporter.say("网络已就绪。", paint.green);
  } else {
    reporter.say(
      "警告：pro.lceda.cn 当前连不上。启动后界面会白屏 30~80 秒等 TCP 超时。",
      paint.yellow,
    );
    reporter.say("      网络恢复后点一下界面即可，不必重启客户端。", paint.yellow);
    reporter.say(
      "      若系统代理还没生效，可加：--proxy-server http://127.0.0.1:7897",
      paint.yellow,
    );
  }

  reporter.say(`启动：${exePath} ${startArgs.join(" ")}`);
  const launched = launchClient(exePath, startArgs, cfg.cdp.logFile, env);
  if (launched.pid === null) {
    const reason = `启动失败：无法拉起 ${exePath}`;
    reporter.say(reason, paint.red);
    reporter.emit({ action: label, ok: false, reason });
    return 1;
  }
  if (!launched.redirected) {
    reporter.say(
      "提示：走的是兼容启动路径，客户端 stderr 未落盘，只影响日志不影响连接。",
      paint.yellow,
    );
  }

  writePidRecord(cfg.cdp.pidFile, { pid: launched.pid, exe: exePath });

  const activePort = await waitForActivePort(cfg.cdp, env, cfg.cdp.startWaitMs);
  if (activePort <= 0) {
    const reason = `${Math.round(cfg.cdp.startWaitMs / 1000)} 秒内没等到 CDP 端点。`;
    reporter.say(`${reason}日志：${cfg.cdp.logFile}`, paint.yellow);
    if (!isPidAlive(launched.pid)) {
      reporter.say(
        "客户端启动后自己退出了。常见原因：未激活、显卡驱动异常，或已有实例把参数接走了。",
        paint.yellow,
      );
    } else {
      reporter.say(
        "进程还在但端口没起来，多半是端口被占用。换一个端口，或改用 --port 0 让客户端自己挑端口。",
        paint.yellow,
      );
    }
    reporter.emit({ action: label, ok: false, pid: launched.pid, reason });
    return 1;
  }

  const info = await probeCdpVersion(activePort, cfg.cdp.bindHost);

  // 校准 pid：Electron 启动器进程可能在 fork 后自己退出，真正持有窗口的是另一个主进程。
  // 不校准的话 status 会一直报「pid 文件已过期」、stop 也停不掉。
  const live = await instancePids(cfg.cdp);
  let finalPid = launched.pid;
  if (live.length > 0 && !live.includes(launched.pid)) {
    finalPid = live[0];
    writePidRecord(cfg.cdp.pidFile, { pid: finalPid, exe: exePath });
    reporter.say(`pid 已校准：${launched.pid} → ${finalPid}（启动器进程已退出，实际主进程是它）`);
  }

  const endpoint = endpointUrl(cfg.cdp.bindHost, activePort);
  reporter.say(`端点就绪：${endpoint}`, paint.green);
  reporter.say(`Browser：${info?.Browser ?? "未知"}`);
  reporter.emit({
    action: label,
    ok: true,
    pid: finalPid,
    exe: exePath,
    endpoint,
    browser: info?.Browser ?? null,
    webSocketDebuggerUrl: info?.webSocketDebuggerUrl ?? null,
    reason: null,
  });
  return 0;
}

// ─── ensure ──────────────────────────────────────────────────────────

async function runEnsure(options: CdpOptions, ctx: CommandContext): Promise<number> {
  const { cfg, env } = ctx;
  const reporter = new Reporter(ctx.io, options.json);

  const instances = mainInstancePids(await instanceProcesses(cfg.cdp));
  if (instances.length === 0) {
    reporter.say("没有在跑的客户端，按 start 起一个。", paint.yellow);
    return await runStart(options, ctx, "ensure");
  }

  // 有进程就给它一个自重启窗口：客户端自重启是「先让旧进程退出、再拉起新进程」，
  // 期间端口由旧进程持有；新进程若绑不上会静默降级（Chromium 只记一条警告）。
  const activePort = await waitForEndpoint(cfg.cdp, env, ENSURE_WAIT_MS);
  if (activePort > 0) {
    const info = await probeCdpVersion(activePort, cfg.cdp.bindHost);
    const endpoint = endpointUrl(cfg.cdp.bindHost, activePort);
    reporter.say(`端点可用：${endpoint}`, paint.green);
    reporter.say(`Browser：${info?.Browser ?? "未知"}`);
    reporter.say(
      "提示：若刚才是设置变更导致的自重启，页面 target id、windowId、撤销栈都换了，重新发现再操作。",
      paint.yellow,
    );
    reporter.emit({
      action: "ensure",
      ok: true,
      started: false,
      endpoint,
      browser: info?.Browser ?? null,
      webSocketDebuggerUrl: info?.webSocketDebuggerUrl ?? null,
      reason: null,
    });
    return 0;
  }

  const flagged = debugFlagRows(await instanceProcesses(cfg.cdp));
  let reason: string;
  if (flagged.length === 0) {
    reason = `客户端在跑（PID ${instances.join(", ")}），但命令行里没有 --remote-debugging-port。`;
    reporter.say(reason, paint.red);
    reporter.say(
      "  这个实例是「不带端口」起来的：从桌面/开始菜单直接打开的，或者升级后自重启把参数丢了。",
    );
    reporter.say("  端口开不出来。先让用户保存工程、彻底退出客户端，再执行 start。");
  } else {
    reason = `命令行带了端口（${formatDebugFlagRows(flagged)}），但 ${Math.round(ENSURE_WAIT_MS / 1000)} 秒内端点没起来。`;
    reporter.say(reason, paint.red);
    reporter.say(
      "  常见原因：老进程还没释放端口，新进程绑不上（Chromium 只记警告，界面照常能用）。",
    );
    reporter.say("  彻底退出后重新 start 一次即可；不要在同端口上强行再拉一个实例。");
  }
  reporter.emit({ action: "ensure", ok: false, started: false, reason });
  return 2;
}

// ─── status ──────────────────────────────────────────────────────────

async function runStatus(options: CdpOptions, ctx: CommandContext): Promise<number> {
  const { cfg, env } = ctx;
  const reporter = new Reporter(ctx.io, options.json);
  const chosenLocation = cfg.client.exe?.location ?? cfg.environment.clientLocations[0] ?? "host";
  if (
    cfg.environment.kind === "wsl2" &&
    cfg.environment.networkingMode !== "mirrored" &&
    chosenLocation === "host"
  ) {
    reporter.say(
      "提示：WSL2 NAT + 客户端在 Windows 宿主，本机回环看不到端点；status/endpoint 结果只代表 WSL 侧。",
      paint.gray,
    );
  }

  const managed = await resolveManagedProcess(cfg.cdp);
  const managedFile = readManagedPidFile(cfg.cdp);
  const processes = await instanceProcesses(cfg.cdp);
  const instances = mainInstancePids(processes);
  const flagged = debugFlagRows(processes);

  if (managed) {
    reporter.say(`实例运行中：PID ${managed.pid}`, paint.green);
    reporter.say(`镜像：${managed.imagePath ?? managed.exe}`);
  } else {
    reporter.say("本工具没有在管理的实例。", paint.yellow);
    const stale = stalePidFile(cfg.cdp);
    if (stale) reporter.say(`pid 文件已过期：${stale}`);
  }

  const activePort = await resolveActivePort(cfg.cdp, env);
  const info = activePort > 0 ? await probeCdpVersion(activePort, cfg.cdp.bindHost) : null;
  let reason: string | null = null;

  if (activePort > 0) {
    reporter.say(`端点：${endpointUrl(cfg.cdp.bindHost, activePort)}`, paint.green);
    reporter.say(`Browser：${info?.Browser ?? "未知"}`);
    reporter.say(`WebSocket：${info?.webSocketDebuggerUrl ?? "未知"}`);
  } else {
    reporter.say("没有可用的 CDP 端点。");
    // 端点没了先分清是哪一类，否则「再启动一次」会撞上单实例保护白跑。
    if (instances.length === 0) {
      reason = "客户端没有在运行。";
    } else if (flagged.length === 0) {
      reason = "客户端进程没带 --remote-debugging-port：这个实例开不出端口。";
    } else {
      reason = `客户端进程带了端口（${formatDebugFlagRows(flagged)}）但没响应：可能还在自重启，或端口被占。`;
    }
    reporter.say(`  ${reason}`, paint.yellow);
  }

  const reportedPid = managed?.pid ?? managedFile?.record.pid ?? null;
  const reportedExe = managed?.exe ?? managedFile?.record.exe ?? null;
  reporter.emit({
    managed: managed !== null,
    pid: reportedPid,
    exe: reportedExe,
    running: reportedPid !== null && isPidAlive(reportedPid),
    endpoint: activePort > 0 ? endpointUrl(cfg.cdp.bindHost, activePort) : null,
    browser: info?.Browser ?? null,
    webSocketDebuggerUrl: info?.webSocketDebuggerUrl ?? null,
    instances,
    debugFlagged: flagged,
    reason,
  });
  // status 是只读诊断，无论成败都返回 0。
  return 0;
}

// ─── endpoint ────────────────────────────────────────────────────────

async function runEndpoint(options: CdpOptions, ctx: CommandContext): Promise<number> {
  const { cfg, env } = ctx;
  const reporter = new Reporter(ctx.io, options.json);

  const activePort = await resolveActivePort(cfg.cdp, env);
  if (activePort <= 0) {
    reporter.say("没有可用的 CDP 端点。");
    reporter.emit({ endpoint: null, webSocketDebuggerUrl: null, reason: "没有可用的 CDP 端点。" });
    return 2;
  }

  const info = await probeCdpVersion(activePort, cfg.cdp.bindHost);
  const endpoint = endpointUrl(cfg.cdp.bindHost, activePort);
  reporter.say(endpoint);
  reporter.say(info?.webSocketDebuggerUrl ?? "");
  reporter.emit({
    endpoint,
    webSocketDebuggerUrl: info?.webSocketDebuggerUrl ?? null,
    reason: null,
  });
  return 0;
}

// ─── stop ────────────────────────────────────────────────────────────

async function runStop(options: CdpOptions, ctx: CommandContext): Promise<number> {
  const { cfg } = ctx;
  const reporter = new Reporter(ctx.io, options.json);

  let managed = await resolveManagedProcess(cfg.cdp);
  if (!managed) {
    const record = readManagedPidFile(cfg.cdp);
    if (record && isPidAlive(record.record.pid)) {
      const imagePath = await readProcessImagePath(record.record.pid);
      if (imagePath === null) {
        if (options.force) {
          managed = { pid: record.record.pid, exe: record.record.exe, imagePath: null };
        } else {
          const reason = `无法读取 PID ${record.record.pid} 的可执行路径，拒绝 stop 以避免 PID 复用误杀；请使用 --force 或手动处理。`;
          reporter.say(reason, paint.yellow);
          reporter.emit({
            action: "stop",
            ok: false,
            stopped: false,
            pid: record.record.pid,
            reason,
          });
          return 2;
        }
      }
    }
  }
  if (!managed) {
    const stale = stalePidFile(cfg.cdp);
    if (stale) {
      reporter.say(`记录的进程已经不在了，清理过期 pid 文件：${stale}`);
      removeFile(stale);
    } else {
      reporter.say("本工具没有在管理的实例。");
    }
    reporter.emit({
      action: "stop",
      ok: true,
      stopped: false,
      pid: null,
      reason: stale ? `清理过期 pid 文件：${stale}` : "本工具没有在管理的实例。",
    });
    return 0;
  }

  if (!options.yes) {
    reporter.say(
      `即将结束进程 PID ${managed.pid}（${managed.imagePath ?? managed.exe}）。`,
      paint.yellow,
    );
    reporter.say("先确认客户端里的工程已保存——未保存的修改会丢。", paint.yellow);
    reporter.say("确认后执行：lceda-cdp stop --yes", paint.yellow);
    reporter.emit({
      action: "stop",
      ok: false,
      stopped: false,
      pid: managed.pid,
      reason: "需要 --yes 确认",
    });
    return 2;
  }

  terminateProcess(managed.pid);

  let alive = true;
  for (let attempt = 0; attempt < STOP_WAIT_ATTEMPTS; attempt += 1) {
    await sleep(ENDPOINT_POLL_MS);
    if (!isPidAlive(managed.pid)) {
      alive = false;
      break;
    }
  }

  if (alive) {
    // 只在真停不掉时报错，不升级成强杀：杀进程树会丢掉更多东西。
    reporter.say("进程仍在运行，未强杀。请在客户端里正常退出。", paint.yellow);
    reporter.emit({
      action: "stop",
      ok: false,
      stopped: false,
      pid: managed.pid,
      reason: "进程仍在运行，未强杀。",
    });
    return 1;
  }

  removeFile(cfg.cdp.pidFile);
  // 旧版 pid 文件也一并清掉，否则下次 status 还会把它读回来当成受管实例。
  if (exists(cfg.cdp.legacyPidFile)) removeFile(cfg.cdp.legacyPidFile);
  reporter.say("已停止。", paint.green);
  reporter.emit({ action: "stop", ok: true, stopped: true, pid: managed.pid, reason: null });
  return 0;
}

// ─── 入口 ────────────────────────────────────────────────────────────

/**
 * CDP 子命令入口。返回进程退出码：
 *   0 成功 / 1 失败 / 2 需要确认或端点不可用（与旧脚本一致）。
 */
export async function runCdpAction(
  action: CdpAction,
  options: CdpOptions,
  ctx: CommandContext,
): Promise<number> {
  switch (action) {
    case "start":
      return await runStart(options, ctx);
    case "ensure":
      return await runEnsure(options, ctx);
    case "status":
      return await runStatus(options, ctx);
    case "endpoint":
      return await runEndpoint(options, ctx);
    case "stop":
      return await runStop(options, ctx);
    default: {
      const unknown: string = action;
      ctx.io.err(paint.red(`  不认识的 cdp 动作: ${unknown}`));
      return 1;
    }
  }
}
