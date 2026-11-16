/**
 * 共用配置与命名工具（源仓库 scripts/sim_config.py）。
 *
 * 节点命名约定（实测结论，勿改）：ngspice-47 把 `$` 当作行内注释起始符，
 * `V1 $SRC 0 1` 会报 "Not enough parameters for v source"。用户侧写 `$CLK_ADC`，
 * 落到 deck 时统一转成 `__CLK_ADC`；报告与 manifest 保留用户写法。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { assetPath } from "../core/assets.ts";
import { asText, type SimConfig } from "./types.ts";

/**
 * 与源仓库 sim_config.py 的 SKILL_VERSION 保持一致。
 * 源仓库 tag 是 v2.6.1，但脚本里这个常量停在 2.6.0——deck 头与 manifest 都写它，
 * 为保持逐字节可比，这里不擅自升级。
 */
export const SKILL_VERSION = "2.6.0";

export const DEFAULTS: SimConfig = {
  power_policy: "auto", // auto | explicit
  strict: false,
  allow_partial_model: false,
  behavioral: true,
  max_cases: 200,
  ground_aliases: null,
  models: null,
  behavioral_models: null,
  override: null,
  external_supplies: [],
  analysis: {},
  metrics: [],
  sweep: null,
  _dir: "",
  _path: null,
};

/** sidecar 脚本目录（assets/sidecar/ngspice-sim/scripts）。 */
export function simScriptsDir(): string {
  return assetPath("sidecar", "ngspice-sim", "scripts");
}

/** 模型库目录（scripts/models，discrete.json / generic.json / model_map.json）。 */
export function simModelsDir(): string {
  return assetPath("sidecar", "ngspice-sim", "scripts", "models");
}

/** 知识文档目录（assets/skills/ngspice-sim）。 */
export function simSkillDocsDir(): string {
  return assetPath("skills", "ngspice-sim");
}

export function loadJsonFile<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** 深合并：对象递归合并，其余值直接覆盖（与 Python 版一致，原地修改 base）。 */
export function deepMerge(
  base: Record<string, unknown>,
  extra: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(extra ?? {})) {
    const current = base[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      deepMerge(current, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 按 bases 顺序解析相对路径；绝对路径直接返回（不存在也返回原值）。
 * 全部候选都不存在时返回第一个 base 下的规范化路径。
 */
export function resolvePath(
  file: string | null | undefined,
  bases: readonly (string | null | undefined)[],
): string | null {
  if (!file) return null;
  if (path.isAbsolute(file)) return file;
  for (const base of bases) {
    if (!base) continue;
    const candidate = path.normalize(path.join(base, file));
    if (existsSync(candidate)) return candidate;
  }
  const first = bases[0] || process.cwd();
  return path.normalize(path.join(first, file));
}

/**
 * 加载 sim_config.json，返回带 DEFAULTS 的完整配置。
 *
 * 配置里的相对路径统一转成绝对路径，另外保存 `_dir`（config 所在目录）与 `_path`，
 * 供 model_map 内的 `external/xxx.lib` 解析。
 */
export function loadSimConfig(
  file?: string | null,
  overrides: Record<string, unknown> = {},
): SimConfig {
  const cfg = cloneJson(DEFAULTS);
  cfg["_dir"] = process.cwd();
  cfg["_path"] = null;
  if (file) {
    const raw = loadJsonFile<Record<string, unknown>>(file);
    cfg["_dir"] = path.dirname(path.resolve(file));
    cfg["_path"] = path.resolve(file);
    deepMerge(cfg as unknown as Record<string, unknown>, raw);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== null && value !== undefined) cfg[key] = value;
  }
  const bases = [cfg["_dir"], simModelsDir(), simScriptsDir()];
  for (const key of ["models", "behavioral_models", "override", "ibis"]) {
    const value = cfg[key];
    if (typeof value === "string" && value) cfg[key] = resolvePath(value, bases);
  }
  return cfg;
}

/** 元件位号 / 元件名 → SPICE 安全标识符（撇号会破坏 ngspice 解析）。 */
export function spiceIdent(name: unknown, fallback = "X"): string {
  let text = asText(name, fallback).replace(/[^0-9A-Za-z_]/g, "_");
  if (!text) text = fallback;
  if (!/^[A-Za-z]/.test(text)) text = fallback[0]!.toUpperCase() + text;
  return text;
}

export const VIRTUAL_PREFIXES = ["$", "__AUTO_"] as const;

/** 虚拟节点写法：`$FOO`（手写）或 `__AUTO_FOO`（PCB 自动生成）。 */
export function isVirtual(name: unknown): boolean {
  if (typeof name !== "string") return false;
  return VIRTUAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const RESERVED_NET_CHARS = /[^0-9A-Za-z_.+-]/g;

/**
 * 网络名 / 节点名 → deck 里的节点标识符。
 *
 * - `$FOO`  → `__FOO`（虚拟节点；`$` 在 ngspice 里是注释符）
 * - 其他    → 非法字符换 `_`，数字开头补 `N_`
 */
export function spiceNode(name: unknown): string | null {
  if (name === null || name === undefined) return null;
  const text = asText(name).trim();
  if (!text) return "N_unnamed";
  if (text === "0") return "0";
  if (text.startsWith("__AUTO_")) return text.replace(RESERVED_NET_CHARS, "_");
  if (text.startsWith("$")) {
    const body = text.slice(1).replace(RESERVED_NET_CHARS, "_");
    return "__" + (body || "V");
  }
  let safe = text.replace(RESERVED_NET_CHARS, "_");
  if (/^[0-9]/.test(safe)) safe = "N_" + safe;
  return safe || "N_unnamed";
}

/** deck 节点名 → 报告里的可读写法（`__FOO` → `$FOO`）。 */
export function displayNode(node: unknown): unknown {
  if (typeof node === "string" && node.startsWith("__")) return "$" + node.slice(2);
  return node;
}

/**
 * 生成 .include 用路径：Windows 安全、尽量相对 deck 目录、含空格加引号。
 * 注意不做 realpath：用户给的符号链接路径要原样保留。
 */
export function quotePath(file: string | null | undefined, baseDir?: string | null): string {
  if (!file) return '""';
  let target = path.resolve(file).replace(/\\/g, "/");
  if (baseDir) {
    const rel = path.relative(path.resolve(baseDir), target).replace(/\\/g, "/");
    if (!rel.startsWith("..")) target = rel;
  }
  return '"' + target + '"';
}

/** 元件名分配器：保证唯一，并按类型前缀生成可读名字。 */
export class Namer {
  private readonly used = new Set<string>();

  take(name: unknown): string {
    const base = spiceIdent(name);
    let candidate = base;
    let index = 2;
    while (this.used.has(candidate.toUpperCase())) {
      candidate = `${base}_${index}`;
      index += 1;
    }
    this.used.add(candidate.toUpperCase());
    return candidate;
  }

  call(prefix: string, hint: string | null | undefined): string {
    return this.take(hint ? `${prefix}_${hint}` : prefix);
  }
}
