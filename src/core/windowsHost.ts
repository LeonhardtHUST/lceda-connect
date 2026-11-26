import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { networkInterfaces } from "node:os";

import { windowsPathToWslPath, wslPathToWindowsPath } from "./environment.ts";

/**
 * WSL → Windows 的互操作辅助。
 *
 * 两个用途：
 *   1. `mcp host`：在 WSL 里用 stdio 拉起 **Windows 侧**的 lceda-connect MCP
 *      （Windows node + Windows 安装的 dist），这样 live 工具和客户端共享回环。
 *   2. `mcp http --host wsl`：解析「WSL 能访问到的宿主地址」——WSL 里取 eth0，
 *      Windows 里取 WSL 默认网关（即宿主 vEthernet 地址）。
 *
 * 所有外部探测都可注入，测试不依赖真实 Windows。
 */

export interface InteropProbes {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runText?: (command: string, args: readonly string[], timeoutMs: number) => string | null;
  exists?: (file: string) => boolean;
  interfaces?: () => NodeJS.Dict<ReturnType<typeof networkInterfaces>[string]>;
}

function resolveProbes(probes: InteropProbes = {}): Required<InteropProbes> {
  return {
    platform: probes.platform ?? process.platform,
    env: probes.env ?? process.env,
    runText:
      probes.runText ??
      ((command, args, timeoutMs) => {
        try {
          const result = spawnSync(command, [...args], {
            timeout: timeoutMs,
            encoding: "utf8",
            windowsHide: true,
          });
          if (result.status !== 0) return null;
          return `${result.stdout ?? ""}`.trim() || null;
        } catch {
          return null;
        }
      }),
    exists: probes.exists ?? ((file) => fs.existsSync(file)),
    interfaces: probes.interfaces ?? (() => networkInterfaces()),
  };
}

/** 解析 `cmd.exe /d /c set` 的输出；跳过 `=C:=...` 这类驱动器当前目录项。 */
export function parseWindowsEnvSet(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("=")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_()#@]*$/.test(key)) continue;
    env[key] = line.slice(index + 1);
  }
  return env;
}

export interface WindowsEnvResult {
  env: NodeJS.ProcessEnv;
  warnings: string[];
  source: "windows-set" | "translated-only";
}

const TRANSLATE_ENV_KEYS = [
  "LCEDA_CONFIG",
  "LCEDA_ENV_FILE",
  "LCEDA_PRO_EXE",
  "LCEDA_NODE",
  "LCEDA_BRIDGE_SCRIPT",
  "LCEDA_CONNECT_HOME",
  "LCEDA_CONNECT_ASSETS",
  "LCEDA_BRIDGE_RUNTIME",
  "LCEDA_ALLOWED_ROOTS",
];

const OVERLAY_ENV_KEYS = [
  "LCEDA_ENV",
  "LCEDA_ENV_SOURCE",
  "LCEDA_LEDA_IN",
  "LCEDA_LEDA_IN_SOURCE",
  "LCEDA_WINDOWS_HOST",
  "LCEDA_WINDOWS_HOST_SOURCE",
  "LCEDA_CDP_HOST",
  "LCEDA_CDP_PORT",
  "LCEDA_CDP_SCAN",
  "LCEDA_BRIDGE_HOST",
  "LCEDA_BRIDGE_PORT_FIRST",
  "LCEDA_BRIDGE_PORT_LAST",
  "LCEDA_TOOLSETS",
  "EASYEDA_CDP_TIMEOUT",
  "LCEDA_PYTHON",
  "NGSPICE_BIN",
];

/** 这些 WSL 专用配置在 Windows 子进程里没有意义，强制丢弃。 */
const WSL_ONLY_ENV_KEYS = [
  "LCEDA_LEDA_IN",
  "LCEDA_LEDA_IN_SOURCE",
  "LCEDA_WINDOWS_HOST",
  "LCEDA_WINDOWS_HOST_SOURCE",
];

function translateValueForWindows(value: string): string | null {
  if (!value) return value;
  if (value.startsWith("/mnt/")) return wslPathToWindowsPath(value);
  if (value.startsWith("/")) return null;
  return value;
}

/**
 * 为 Windows 子进程准备环境：优先用 `cmd.exe /d /c set` 的真实 Windows 环境，
 * 再把当前进程里显式设置的 LCEDA_* 覆盖进去（/mnt 路径转 Windows 路径）。
 * 这样从 WSL 互操作拉起 Windows MCP 时，不会把 POSIX PATH/HOME 带过去。
 */
export function resolveWindowsEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  probes: InteropProbes = {},
): WindowsEnvResult {
  const resolved = resolveProbes({ ...probes, env });
  const warnings: string[] = [];
  const raw = resolved.runText("cmd.exe", ["/d", "/c", "set"], 8_000);
  const windowsEnv = raw ? parseWindowsEnvSet(raw) : null;
  let base: NodeJS.ProcessEnv;
  let source: WindowsEnvResult["source"];
  if (windowsEnv && Object.keys(windowsEnv).length > 0) {
    base = { ...windowsEnv };
    source = "windows-set";
  } else {
    warnings.push("读不到 Windows 环境变量（cmd.exe set 失败）；只传递显式 LCEDA_* 配置");
    base = {};
    source = "translated-only";
  }
  for (const key of WSL_ONLY_ENV_KEYS) delete base[key];
  for (const key of [...TRANSLATE_ENV_KEYS, ...OVERLAY_ENV_KEYS]) {
    const value = env[key];
    if (value === undefined) continue;
    let translated: string | null;
    if (key === "LCEDA_ALLOWED_ROOTS") {
      // 逗号分隔的根目录列表：逐项翻译，纯 WSL 路径丢掉。
      const items = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const kept: string[] = [];
      for (const item of items) {
        const one = translateValueForWindows(item);
        if (one === null) {
          warnings.push(
            `LCEDA_ALLOWED_ROOTS 中的 ${item} 是 WSL 内部路径，Windows 进程不可读，已移除`,
          );
        } else {
          kept.push(one);
        }
      }
      translated = kept.join(";");
    } else {
      translated = translateValueForWindows(value);
      if (translated === null) {
        warnings.push(`${key}=${value} 是 WSL 内部路径，Windows 进程不可读，已从子进程环境移除`);
        continue;
      }
    }
    base[key] = translated;
  }
  // Windows 子进程就是原生 Windows：显式环境必须覆盖掉调用方可能带来的 wsl2 语义。
  if (base.LCEDA_ENV && base.LCEDA_ENV !== "windows-native") {
    warnings.push(
      `Windows 子进程强制使用 windows-native（原 LCEDA_ENV=${base.LCEDA_ENV}，WSL 位置/宿主配置已丢弃）`,
    );
  }
  base.LCEDA_ENV = "windows-native";
  delete base.LCEDA_ENV_SOURCE;
  // Node 在 Windows 上不区分 Path/PATH，但代码里有只读 env.PATH 的地方，补齐两种写法。
  const pathValue = base.Path ?? base.PATH;
  if (pathValue) {
    base.Path = pathValue;
    base.PATH = pathValue;
  }
  return { env: base, warnings, source };
}

/**
 * 在 Windows 上被 WSL 互操作直接拉起时，继承来的是 WSL 的 POSIX 环境（PATH/HOME 等）。
 * 检测到 WSL 标记就换回真实 Windows 环境，避免 exe 发现、运行态目录被 /root、/mnt 带偏。
 */
export function normalizeMcpEnv(
  env: NodeJS.ProcessEnv = process.env,
  probes: InteropProbes = {},
): { env: NodeJS.ProcessEnv; warnings: string[] } {
  const platform = probes.platform ?? process.platform;
  const looksWsl =
    (env.WSL_INTEROP ?? "").trim() !== "" || (env.WSL_DISTRO_NAME ?? "").trim() !== "";
  if (platform !== "win32" || !looksWsl) return { env, warnings: [] };
  const resolved = resolveWindowsEnvironment(env, probes);
  return { env: resolved.env, warnings: resolved.warnings };
}

export interface WindowsExecutable {
  /** 当前 Linux 进程可直接执行的路径（/mnt/...）。 */
  wslPath: string;
  /** Windows 进程使用的路径（C:\...）。 */
  winPath: string;
  source: string;
}

function executableOf(value: string, source: string): WindowsExecutable | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Windows 进程只能读 Windows 路径或 /mnt 挂载；/tmp、/root 等纯 WSL 路径直接拒绝。
  if (trimmed.startsWith("/") && !trimmed.startsWith("/mnt/")) return null;
  const winPath = trimmed.startsWith("/mnt/")
    ? (wslPathToWindowsPath(trimmed) ?? trimmed)
    : trimmed;
  const wslPath = trimmed.startsWith("/mnt/") ? trimmed : windowsPathToWslPath(trimmed);
  return { wslPath, winPath, source };
}

/** 找 Windows node.exe：显式 env > where.exe > 常见安装位置。 */
export function resolveWindowsNode(
  env: NodeJS.ProcessEnv = process.env,
  probes: InteropProbes = {},
): WindowsExecutable | null {
  const resolved = resolveProbes({ ...probes, env });
  const explicit = env.LCEDA_WINDOWS_NODE?.trim();
  if (explicit) {
    const item = executableOf(explicit, "env:LCEDA_WINDOWS_NODE");
    if (item && resolved.exists(item.wslPath)) return item;
  }
  const where = resolved.runText("cmd.exe", ["/d", "/c", "where node.exe"], 8_000);
  if (where) {
    for (const line of where.split(/\r?\n/)) {
      const value = line.trim();
      if (!value) continue;
      const item = executableOf(value, "where.exe node");
      if (item && resolved.exists(item.wslPath)) return item;
    }
  }
  const candidates: string[] = [];
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  candidates.push(`${programFiles}\\nodejs\\node.exe`);
  if (env.LOCALAPPDATA) candidates.push(`${env.LOCALAPPDATA}\\vite-plus\\bin\\node.exe`);
  for (const candidate of candidates) {
    const item = executableOf(candidate, "常见安装位置");
    if (item && resolved.exists(item.wslPath)) return item;
  }
  return null;
}

const PACKAGE_ENTRY = "lceda-connect\\dist\\cli-mcp.mjs";

/** 找 Windows 侧安装的 lceda-connect 入口：显式配置 > 全局 pnpm/npm root > %APPDATA%\npm。 */
export function resolveWindowsMcpEntry(
  env: NodeJS.ProcessEnv = process.env,
  probes: InteropProbes = {},
  explicit?: string,
): WindowsExecutable | null {
  const resolved = resolveProbes({ ...probes, env });
  const requested = explicit?.trim() || env.LCEDA_WINDOWS_MCP?.trim();
  if (requested) {
    const item = executableOf(requested, "显式指定");
    return item && resolved.exists(item.wslPath) ? item : null;
  }
  const roots: string[] = [];
  for (const command of ["pnpm", "npm"]) {
    const root = resolved.runText("cmd.exe", ["/d", "/c", `${command} root -g`], 15_000);
    if (root) {
      for (const line of root.split(/\r?\n/)) {
        const value = line.trim();
        if (value && /^[A-Za-z]:[\\/]/.test(value)) roots.push(value);
      }
    }
  }
  if (env.APPDATA) roots.push(`${env.APPDATA}\\npm\\node_modules`);
  const seen = new Set<string>();
  for (const root of roots) {
    const entry = `${root}\\${PACKAGE_ENTRY}`;
    if (seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    const item = executableOf(entry, `全局安装（${root}）`);
    if (item && resolved.exists(item.wslPath)) return item;
  }
  return null;
}

export interface WslFacingHostResult {
  host: string;
  source: string;
  warnings: string[];
}

/**
 * 解析 `--host wsl`：
 *   - 在 WSL 里：取 eth0 的 IPv4（Windows 可经这个地址访问 WSL）；
 *   - 在 Windows 里：取 WSL 默认网关（即宿主 vEthernet 地址，WSL 可访问它）。
 */
export function resolveWslFacingHost(
  env: NodeJS.ProcessEnv = process.env,
  probes: InteropProbes = {},
): WslFacingHostResult | null {
  const resolved = resolveProbes({ ...probes, env });
  const warnings: string[] = [];
  if (resolved.platform === "linux") {
    const interfaces = resolved.interfaces();
    const preferred = interfaces.eth0 ?? interfaces.eth1;
    const candidates = preferred ?? Object.values(interfaces).flat().filter(Boolean);
    for (const item of candidates ?? []) {
      if (!item || item.internal) continue;
      if (item.family === "IPv4") {
        return { host: item.address, source: "WSL eth0", warnings };
      }
    }
    warnings.push("找不到 WSL eth0 的 IPv4 地址");
    return null;
  }
  if (resolved.platform === "win32") {
    const output = resolved.runText(
      "wsl.exe",
      ["-e", "sh", "-lc", "ip route show default 2>/dev/null | awk '{print $3}'"],
      10_000,
    );
    const host = output?.split(/\r?\n/)[0]?.trim() ?? "";
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      const mode = resolved.runText("wsl.exe", ["-e", "wslinfo", "--networking-mode"], 8_000);
      if ((mode ?? "").trim().toLowerCase() === "mirrored") {
        warnings.push(
          "WSL 处于 mirrored 网络模式：WSL 与宿主共享回环，默认网关可能是 LAN 地址；优先考虑 --host 127.0.0.1",
        );
      }
      return { host, source: "WSL 默认网关", warnings };
    }
    warnings.push("无法从 WSL 读取默认网关；请直接传 --host <宿主 vEthernet IP>");
    return null;
  }
  warnings.push(`平台 ${resolved.platform} 不支持 --host wsl`);
  return null;
}
