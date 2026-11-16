/**
 * eprj3 sidecar：源仓库 `easyeda-eprj3-skill` 的 CommonJS 脚本收在
 * `assets/sidecar/eprj3/`，由这里用 `node` 子进程调用。
 *
 * 为什么是 sidecar：声明式建工程（`build.js`）、原子编辑（`add-*.js`）、
 * 门禁（ERC / DRC / 布局 lint / design intent）和历史模板这一层体量大、跟
 * 源技能的命令行约定绑得紧，本轮直接原样收进来；记录解析、归约、格式门和
 * 网表已经 TS 化（`records.ts` / `validate.ts` / `netlist.ts`）。
 *
 * sidecar 自带 `package.json`（没有 `"type"` 字段 = CommonJS），所以根仓库是
 * `"type":"module"` 也不影响它按 CJS 跑。脚本名只能取白名单里的顶层脚本，
 * 不接受路径；`eval.js` / `make-board.js` 依赖源仓库的 `test/capture.js`，
 * 没有复制 `test/`，因此不在白名单里。
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { assetsDir } from "../core/assets.ts";
import { run } from "../core/exec.ts";
import { ToolError } from "../mcp/types.ts";

/** sidecar 顶层脚本白名单（不带 `.js`）。 */
export const EPRJ3_SCRIPTS = [
  "add-footprint",
  "add-netlabel",
  "add-pcb-shape",
  "add-pcb-text",
  "add-region",
  "add-shape",
  "add-symbol",
  "add-text",
  "add-wire",
  "autofix",
  "build",
  "cleanup",
  "depcheck",
  "drc",
  "eda",
  "erc",
  "floorplan",
  "generate-footprint",
  "generate-symbol",
  "init",
  "intake",
  "intent",
  "lint-layout",
  "load-library",
  "netcheck",
  "netlist",
  "open",
  "pack",
  "pattern-coverage",
  "pins",
  "recipe",
  "report",
  "set-refdes",
  "validate",
] as const;

export type Eprj3ScriptName = (typeof EPRJ3_SCRIPTS)[number];

const scriptSet = new Set<string>(EPRJ3_SCRIPTS);

/** 写操作脚本：`eprj3_edit` 只放行这些。 */
export const EPRJ3_EDIT_OPS = [
  "add-footprint",
  "add-netlabel",
  "add-pcb-shape",
  "add-pcb-text",
  "add-region",
  "add-shape",
  "add-symbol",
  "add-text",
  "add-wire",
  "set-refdes",
  "generate-symbol",
  "generate-footprint",
] as const;

export type Eprj3EditOp = (typeof EPRJ3_EDIT_OPS)[number];

const editSet = new Set<string>(EPRJ3_EDIT_OPS);

/** 审计门禁到 sidecar 脚本的映射；`intent` 需要 design.json，而不是工程目录。 */
export const EPRJ3_GATES = {
  erc: "erc",
  drc: "drc",
  lint: "lint-layout",
  intent: "intent",
} as const;

export type Eprj3Gate = keyof typeof EPRJ3_GATES;
export const EPRJ3_GATE_NAMES = Object.keys(EPRJ3_GATES) as Eprj3Gate[];

export function isEprj3ScriptName(name: string): name is Eprj3ScriptName {
  return scriptSet.has(name);
}

export function isEprj3EditOp(name: string): name is Eprj3EditOp {
  return editSet.has(name);
}

/** `assets/sidecar/eprj3` 目录。 */
export function eprj3SidecarDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(assetsDir(env), "sidecar", "eprj3");
}

/** `assets/sidecar/eprj3/scripts` 目录。 */
export function eprj3ScriptsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(eprj3SidecarDir(env), "scripts");
}

/** 实际存在且在白名单里的顶层脚本名。 */
export function listEprj3Scripts(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = eprj3ScriptsDir(env);
  if (!existsSync(dir)) return [];
  const present = new Set(
    readdirSync(dir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => name.slice(0, -3)),
  );
  return EPRJ3_SCRIPTS.filter((name) => present.has(name));
}

function normalizeScriptName(name: string): string {
  const trimmed = name.trim();
  return trimmed.endsWith(".js") ? trimmed.slice(0, -3) : trimmed;
}

/** 解析脚本名：只接受白名单里的裸文件名，且文件必须存在。 */
export function resolveEprj3ScriptPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): { name: Eprj3ScriptName; file: string } {
  const normalized = normalizeScriptName(name);
  if (normalized === "" || path.basename(normalized) !== normalized) {
    throw new ToolError(
      "EPRJ3_SCRIPT_UNKNOWN",
      `sidecar 脚本名必须是不带路径的裸文件名，收到 ${JSON.stringify(name)}`,
      { available: listEprj3Scripts(env) },
    );
  }
  if (!isEprj3ScriptName(normalized)) {
    throw new ToolError("EPRJ3_SCRIPT_UNKNOWN", `sidecar 没有放行脚本 ${normalized}`, {
      available: listEprj3Scripts(env),
    });
  }
  const file = path.join(eprj3ScriptsDir(env), `${normalized}.js`);
  if (!existsSync(file)) {
    throw new ToolError("EPRJ3_SCRIPT_MISSING", `sidecar 目录里没有 ${normalized}.js`, {
      path: file,
      available: listEprj3Scripts(env),
    });
  }
  return { name: normalized, file };
}

export interface Eprj3ScriptResult {
  script: string;
  scriptPath: string;
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ok: boolean;
  /** stdout 整体就是 JSON（`--json` 类脚本）时顺便解析出来。 */
  json?: unknown;
}

export interface RunEprj3ScriptOptions {
  /** 子进程工作目录；相对路径参数以它为准。默认 `process.cwd()`。 */
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** sidecar 默认超时：建工程 / 跑门禁在几十 MB 的工程上也要给足。 */
export const EPRJ3_SIDECAR_TIMEOUT_MS = 600_000;

function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 跑一个 sidecar 脚本。
 *
 * 脚本不存在 / 名字越界抛 `ToolError`；脚本自己非零退出不是工具错误，原样把
 * `exitCode` / `stdout` / `stderr` 返回给调用方判断。
 */
export async function runEprj3Script(
  name: string,
  args: readonly string[] = [],
  options: RunEprj3ScriptOptions = {},
): Promise<Eprj3ScriptResult> {
  const env = options.env ?? process.env;
  const resolved = resolveEprj3ScriptPath(name, env);
  const argv = [resolved.file, ...args.map((arg) => String(arg))];
  const result = await run(process.execPath, argv, {
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? EPRJ3_SIDECAR_TIMEOUT_MS,
    env,
  });
  if (result.error !== undefined) {
    throw new ToolError("EPRJ3_SCRIPT_SPAWN_FAILED", `启动 sidecar 脚本失败：${result.error}`, {
      script: `${resolved.name}.js`,
      argv,
    });
  }
  const parsedJson = parseJsonOutput(result.stdout);
  const output: Eprj3ScriptResult = {
    script: `${resolved.name}.js`,
    scriptPath: resolved.file,
    argv,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    ok: result.code === 0 && !result.timedOut,
  };
  if (parsedJson !== undefined) output.json = parsedJson;
  return output;
}

/**
 * 门禁参数：`erc` / `drc` / `lint` 用 `--dir`；`intent` 检查的是 design.json，
 * 必须显式给 `design`。`--json` 全部加上。`--design` 只有 `erc` 与 `drc`
 * 接受（`lint-layout` 没有这个选项，传了会报未知参数）。
 */
export function eprj3GateArgs(gate: Eprj3Gate, dir: string, design?: string | null): string[] {
  if (gate === "intent") {
    if (design === undefined || design === null || design === "") {
      throw new ToolError(
        "EPRJ3_GATE_DESIGN_REQUIRED",
        "intent 门禁校验 design.json，需要同时给 design 路径",
      );
    }
    return ["--design", design, "--json"];
  }
  const args = ["--dir", dir, "--json"];
  if (
    (gate === "erc" || gate === "drc") &&
    design !== undefined &&
    design !== null &&
    design !== ""
  ) {
    args.push("--design", design);
  }
  return args;
}
