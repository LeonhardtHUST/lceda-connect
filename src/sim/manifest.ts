/**
 * simulation_manifest.json 与 fidelity 展示（源仓库 scripts/sim_manifest.py）。
 *
 * 目的：让下一个 agent（或三个月后的自己）一眼看出"这次的波形到底基于什么假设"——
 * 用了哪些厂商模型、哪些器件被排除、地怎么接的、电源是谁供的。
 * fidelity 措辞统一按 Level 0-3 逐块标注，禁止"已成功仿真整个 PCB"这种含糊说法。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SKILL_VERSION } from "./config.ts";
import { getNgspiceVersion } from "./ngspice.ts";
import type { NetlistReport, SimManifest, SimRunRecord } from "./types.ts";

export const LEVEL_NAMES: Record<number, string> = {
  0: "Level 0 — topology only (R/C/L + generic)",
  1: "Level 1 — behavioral placeholders",
  2: "Level 2 — vendor SPICE (.SUBCKT/.MODEL)",
  3: "Level 3 — PCB parasitic (trace/via/RLC/transmission line)",
};

/** 文件 sha256（不存在返回 null）。 */
export function fileHash(file: string | null | undefined, algo = "sha256"): string | null {
  if (!file || !existsSync(file)) return null;
  return createHash(algo).update(readFileSync(file)).digest("hex");
}

/** ngspice 二进制版本：跑 `-v` 并解析 "ngspice-47"。 */
export async function ngspiceVersion(binPath: string | null | undefined): Promise<string | null> {
  if (!binPath || !existsSync(binPath)) return null;
  return await getNgspiceVersion(binPath);
}

/** 把 fidelity 表渲染成 SKILL.md 要求的那种段落。 */
export function fidelityLines(report: NetlistReport | null | undefined): string[] {
  const fidelity = report?.fidelity;
  const blocks = fidelity?.blocks ?? {};
  const lines = ["Simulation fidelity:"];
  if (Object.keys(blocks).length === 0) lines.push("  (no components included)");
  const sorted = Object.entries(blocks).sort((a, b) => {
    const levelDiff = (b[1]?.level ?? 0) - (a[1]?.level ?? 0);
    if (levelDiff !== 0) return levelDiff;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  for (const [name, info] of sorted) lines.push(`  ${name}: Level ${info.level}`);
  const overall = fidelity?.overall_level ?? 0;
  lines.push(`  overall: Level ${overall} — ${LEVEL_NAMES[overall] ?? ""}`);
  lines.push("  注意：未列出的网络/器件没有寄生建模；本结果不代表整块 PCB 已被仿真。");
  return lines;
}

export interface BuildManifestOptions {
  project?: string | null;
  sourceHash?: string | null;
  ngspice?: string | null;
  workdir?: string | null;
  runs?: SimRunRecord[];
  errors?: Record<string, unknown>[];
}

/** 组装 manifest（字段与源仓库 sim_manifest.build 对齐，另加少量扩展）。 */
export function buildManifest(
  netlistReport: NetlistReport | null | undefined,
  analysis: Record<string, unknown>,
  options: BuildManifestOptions = {},
): SimManifest {
  const report = netlistReport ?? ({} as NetlistReport);
  return {
    source_project: options.project ?? null,
    source_hash: options.sourceHash ?? null,
    skill_version: SKILL_VERSION,
    ngspice_version: options.ngspice ?? null,
    analysis,
    workdir: options.workdir ?? null,
    models: (report.models ?? []).map((model) => ({
      designator: model["designator"],
      part: model["mpn"] ?? model["key"],
      type: model["type"],
      source: model["file_display"],
      subckt: model["subckt"] ?? model["model"],
      pin_mapping: model["pin_mapping"],
      pin_mapping_status: model["status"],
      matched_by: model["matched_by"],
      levels: "Level 2",
    })),
    behavioral_models: (report.behavioral ?? []).map((item) => ({
      designator: item["designator"],
      part: item["part"],
      type: item["type"],
      level: item["level"],
      models: item["models"],
      not_simulated: item["not_simulated"],
      elements: item["elements"],
    })),
    excluded_components: (report.excluded ?? []).map((item) => ({
      designator: item["designator"],
      part: item["mpn"] ?? item["title"],
      reason: item["reason"],
      level: "EXCLUDED",
    })),
    ground_mapping: report.ground_mapping ?? {},
    power_sources: report.powers ?? [],
    overrides: report.overrides ?? [],
    net_segments: report.net_segments ?? [],
    virtual_nodes: report.virtual_nodes ?? [],
    includes: report.includes ?? [],
    fidelity: report.fidelity ?? {},
    power_policy: report.power_policy ?? undefined,
    strict: report.strict ?? undefined,
    warnings: [
      ...(report.warnings ?? []),
      ...(options.errors ?? []).map((item) => JSON.stringify(item)),
    ],
    errors: [...(report.errors ?? []), ...(options.errors ?? [])],
    runs: options.runs ?? [],
  };
}

export function writeManifest(manifest: SimManifest, file: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(manifest, null, 1) + "\n", "utf8");
  return file;
}

/** 给 stdout 的 manifest 摘要（不打印全部细节）。 */
export function manifestSummaryLines(manifest: SimManifest): string[] {
  const lines = [
    `skill: ${manifest.skill_version}   ngspice: ${manifest.ngspice_version ?? "-"}`,
    `power policy: ${manifest.power_policy ?? "-"}   strict: ${String(manifest.strict)}`,
  ];
  const ground = manifest.ground_mapping ?? {};
  if (Object.keys(ground).length > 0) {
    lines.push(
      "ground: " +
        Object.entries(ground)
          .map(([from, to]) => `${from}->${to}`)
          .join(", "),
    );
  }
  if (manifest.models.length > 0) {
    lines.push(
      `vendor models: ${manifest.models.map((model) => String(model["designator"])).join(", ")}`,
    );
  }
  if (manifest.behavioral_models.length > 0) {
    lines.push(
      "behavioral: " +
        manifest.behavioral_models
          .map((item) => `${String(item["designator"])} (${String(item["type"])})`)
          .join(", "),
    );
  }
  if (manifest.excluded_components.length > 0) {
    lines.push(
      `excluded: ${manifest.excluded_components
        .map((item) => String(item["designator"]))
        .join(", ")}`,
    );
  }
  return lines;
}
