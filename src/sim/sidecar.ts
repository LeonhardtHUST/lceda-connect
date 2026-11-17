/**
 * Python sidecar 封装。
 *
 * 依赖 numpy / scipy / scikit-rf 的脚本（rf_network、vector_fit、network_validate、
 * deembed、diff_port、coupled_line、parameter_fit、correlate、measurement_import、
 * em_bridge、pcb_em）以及规则密集、本轮未移植的 override_apply、behavioral_models、
 * IBIS 相关、pcb_geometry、pcb_to_override、pdn_multiport、sweep_runner、monte_carlo、
 * sim_exec 等，原样放在 assets/sidecar/ngspice-sim/scripts/，由这里用子进程调用。
 *
 * Python 探测顺序：LCEDA_PYTHON → python → py -3；都没有时抛
 * ToolError("PY_SIDECAR_UNAVAILABLE")。
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { run } from "../core/exec.ts";
import { ToolError } from "../mcp/types.ts";
import { simScriptsDir } from "./config.ts";
import { asText } from "./types.ts";

export const SIDECAR_TIMEOUT_MS = 600_000;
const PYTHON_PROBE_TIMEOUT_MS = 15_000;

export interface PythonCandidate {
  command: string;
  prefix: string[];
}

export interface PythonProbeCandidate extends PythonCandidate {
  ok: boolean;
  version: string | null;
  error?: string;
}

export interface PythonProbeResult {
  available: boolean;
  command: string | null;
  prefix: string[];
  version: string | null;
  source: "env" | "path" | null;
  candidates: PythonProbeCandidate[];
  hint: string;
}

/** sidecar 脚本目录。 */
export function simSidecarDir(): string {
  return simScriptsDir();
}

/** 候选 Python 解释器：LCEDA_PYTHON → python → py -3。 */
export function pythonCandidates(env: NodeJS.ProcessEnv = process.env): PythonCandidate[] {
  const candidates: PythonCandidate[] = [];
  if (env.LCEDA_PYTHON) candidates.push({ command: env.LCEDA_PYTHON, prefix: [] });
  candidates.push({ command: "python", prefix: [] });
  candidates.push({ command: "py", prefix: ["-3"] });
  return candidates.filter((candidate) => {
    if (
      !candidate.command.toLowerCase().endsWith(".bat") &&
      !candidate.command.toLowerCase().endsWith(".cmd")
    )
      return true;
    return Boolean(env.LCEDA_PYTHON && candidate.command === env.LCEDA_PYTHON);
  });
}

function parseVersion(text: string): string | null {
  const match = /Python\s+([0-9][0-9A-Za-z.-]*)/i.exec(text);
  return match ? (match[1] ?? null) : null;
}

/** 探测可用的 Python 解释器（逐个跑 `-V`）。 */
export async function probePython(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PythonProbeResult> {
  const candidates = pythonCandidates(env);
  const probes: PythonProbeCandidate[] = [];
  for (const candidate of candidates) {
    const result = await run(candidate.command, [...candidate.prefix, "-V"], {
      timeoutMs: PYTHON_PROBE_TIMEOUT_MS,
      env,
    });
    const version = parseVersion(result.stdout + result.stderr);
    const ok = !result.error && result.code === 0;
    probes.push({
      ...candidate,
      ok,
      version,
      error: result.error ?? (ok ? undefined : result.stderr.trim().slice(0, 2000)),
    });
    if (ok) {
      return {
        available: true,
        command: candidate.command,
        prefix: candidate.prefix,
        version,
        source: candidate.command === env.LCEDA_PYTHON ? "env" : "path",
        candidates: probes,
        hint: "",
      };
    }
  }
  return {
    available: false,
    command: null,
    prefix: [],
    version: null,
    source: null,
    candidates: probes,
    hint:
      "没有找到 Python。安装 Python 3 后设置 LCEDA_PYTHON（指向 python.exe），" +
      "或把 python 放进 PATH。若候选是批处理壳，请把 LCEDA_PYTHON 指向 python.exe。RF/拟合类 sidecar 还需要 pip install -r requirements-rf.txt。",
  };
}

/** 列出 sidecar 目录下允许调用的脚本名（只认顶层 .py）。 */
export function listSimSidecarScripts(): string[] {
  try {
    return readdirSync(simSidecarDir())
      .filter((name) => name.toLowerCase().endsWith(".py"))
      .sort();
  } catch {
    return [];
  }
}

/** 校验脚本名：必须是 sidecar 目录下的裸文件名且存在。 */
export function resolveSimSidecarScript(script: string): string {
  const name = asText(script).trim();
  if (!name || path.basename(name) !== name || !name.toLowerCase().endsWith(".py")) {
    throw new ToolError(
      "SIM_SIDECAR_SCRIPT_UNKNOWN",
      `sidecar 脚本名必须是 ${simSidecarDir()} 下的 .py 文件名（不带路径），收到 ${JSON.stringify(script)}`,
    );
  }
  const full = path.join(simSidecarDir(), name);
  if (!existsSync(full)) {
    throw new ToolError("SIM_SIDECAR_SCRIPT_UNKNOWN", `sidecar 目录里没有脚本 ${name}`, {
      available: listSimSidecarScripts(),
    });
  }
  return full;
}

export interface RunSimSidecarOptions {
  /** 显式指定解释器（配置里给的值优先于环境探测）。 */
  python?: string | null;
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, message: string) => void | Promise<void>;
}

export interface SimSidecarResult {
  script: string;
  scriptPath: string;
  python: string;
  argv: string[];
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ok: boolean;
}

/**
 * 运行 sidecar 脚本。属"执行外部程序"，MCP 层需 confirm:true 才会调用到这里。
 * 解释器缺失抛 ToolError("PY_SIDECAR_UNAVAILABLE")；脚本名越界抛
 * ToolError("SIM_SIDECAR_SCRIPT_UNKNOWN")；脚本自身非零退出不算工具错误，原样返回。
 */
export async function runSimSidecar(
  script: string,
  args: readonly string[] = [],
  options: RunSimSidecarOptions = {},
): Promise<SimSidecarResult> {
  const scriptPath = resolveSimSidecarScript(script);
  const env = options.env ?? process.env;
  let command: string;
  let prefix: string[] = [];
  if (options.python) {
    command = options.python;
  } else {
    const probe = await probePython(env);
    if (!probe.available || !probe.command) {
      throw new ToolError("PY_SIDECAR_UNAVAILABLE", probe.hint, { candidates: probe.candidates });
    }
    command = probe.command;
    prefix = probe.prefix;
  }
  const isBatch = process.platform === "win32" && /\.(?:bat|cmd)$/i.test(command);
  const allArgs = [...prefix, scriptPath, ...args.map((arg) => String(arg))];
  if (isBatch) {
    const unsafe = /["&|<>^%!\r\n]/;
    if (allArgs.some((arg) => unsafe.test(arg))) {
      throw new ToolError("UNSAFE_ARGUMENT", "批处理解释器参数包含不安全字符");
    }
  }
  const argv = isBatch
    ? ["/d", "/s", "/c", `"${[command, ...allArgs].map((arg) => `"${arg}"`).join(" ")}"`]
    : allArgs;
  const result = await run(isBatch ? "cmd.exe" : command, argv, {
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? SIDECAR_TIMEOUT_MS,
    env,
    signal: options.signal,
    windowsVerbatimArguments: isBatch,
  });
  if (result.error && /ENOENT|EACCES/i.test(result.error)) {
    throw new ToolError("PY_SIDECAR_UNAVAILABLE", `找不到 Python 解释器: ${command}`, {
      error: result.error,
    });
  }
  return {
    script,
    scriptPath,
    python: command,
    argv,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    ok: result.code === 0 && !result.timedOut,
  };
}
