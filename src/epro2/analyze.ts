/**
 * 统一入口：把一个 .epro2 解析成结构化产物 + 可读报告。
 *
 * 与 Python 版 analyze.py 对齐：collect / check_consistency / find_floating /
 * render_report / run_single / run_diff 各自独立，CLI 与 MCP 只调用这一层。
 */
import path from "node:path";

import { ensureSafeOutputDir, safeWriteJson, safeWriteText } from "../core/pathPolicy.ts";
import type {
  AmbiguousMap,
  Artifacts,
  ConsistencyStats,
  DiffResult,
  FloatingNet,
  Mismatch,
  NetsDump,
  ParsedDoc,
  PcbRow,
  PinNetMap,
  SchematicIr,
} from "./contract.ts";
import { Project, ProjectError, openProject, type ProjectMember } from "./container.ts";
import { compare, summarize } from "./diff.ts";
import { buildDevices, buildFootprints, buildSymbols } from "./library.ts";
import { buildGeometry, buildNetlist, formatNetlistCsv } from "./pcb.ts";
import { docTitle, parseRecords, type ParseStats } from "./records.ts";
import { renderReport } from "./report.ts";
import { buildNets, pageToIr, pinKey, splitPinKey } from "./schematic.ts";
import { scalarText } from "./text.ts";

export function slug(text: unknown, fallback = "page"): string {
  const value = scalarText(text)
    .replace(/[^\p{L}\p{N}_.-]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return value || fallback;
}

export function writeJson(filePath: string, value: unknown): string {
  return safeWriteJson(filePath, value);
}

export function writeText(filePath: string, text: string): string {
  return safeWriteText(filePath, text);
}

export interface Collected {
  artifacts: Artifacts;
  docs: ParsedDoc[];
  proj: Project;
  stats: ParseStats;
}

/** 解析一个工程，返回 (artifacts, docs, project)。 */
export function collect(projectPath: string, pageKey?: string | null): Collected {
  const proj = openProject(projectPath);
  const stats: ParseStats = { total: 0, unparsed: 0 };
  const docs = parseRecords(proj.epruText, stats);
  if (docs.length === 0) {
    throw new ProjectError("记录流里没有文档段（DOCHEAD 缺失）");
  }
  const ratio = stats.total ? stats.unparsed / stats.total : 0;
  if (ratio > 0.05) {
    throw new ProjectError(
      `记录行解析失败 ${(ratio * 100).toFixed(1)}%（${stats.unparsed}/${stats.total}），` +
        "解析规则与文件版本不匹配",
    );
  }

  const symbols = buildSymbols(docs);
  const devices = buildDevices(docs);
  const footprints = buildFootprints(docs);

  const pages = docs.filter((doc) => doc.docType === "SCH_PAGE" || doc.docType === "SIMULATION");
  const pageList = pages.map((doc) => ({
    uuid: doc.uuid,
    name: docTitle(doc) || "(未命名)",
    docType: doc.docType,
  }));

  let targets: ParsedDoc[];
  if (pageKey) {
    targets = pages.filter((doc) => doc.uuid === pageKey || docTitle(doc) === pageKey);
    if (targets.length === 0) {
      throw new ProjectError(
        `找不到页「${pageKey}」。可用页：${pageList.map((page) => page.name).join("、") || "无"}`,
      );
    }
  } else {
    const schPages = pages.filter((doc) => doc.docType === "SCH_PAGE");
    targets = schPages.length > 0 ? schPages : pages.slice(0, 1);
  }

  const pagesIr: SchematicIr[] = [];
  const netsByKey = new Map<string, Set<string>>();
  for (const doc of targets) {
    const ir = pageToIr(doc, symbols, devices, proj.title);
    for (const [key, value] of buildNets(ir)) {
      const set = netsByKey.get(key) ?? new Set<string>();
      set.add(value);
      netsByKey.set(key, set);
    }
    pagesIr.push(ir);
  }

  // 同名页去重：多页可能都叫 P1。
  const seenTitles = new Map<string, number>();
  for (const ir of pagesIr) {
    const base = ir.page.name || "(未命名)";
    const count = (seenTitles.get(base) ?? 0) + 1;
    seenTitles.set(base, count);
    ir.page.label = count === 1 ? base : `${base}#${count}`;
  }

  // 跨页同位号会把不同网络叠在一起，只保留各页一致的引脚。
  const pinNet: PinNetMap = new Map();
  const ambiguous: AmbiguousMap = new Map();
  for (const [key, values] of netsByKey) {
    if (values.size === 1) {
      pinNet.set(key, [...values][0] ?? "");
    } else {
      ambiguous.set(key, [...values].sort());
    }
  }

  // 同一位号出现在多个页时，无法判断 PCB 上那颗属于哪一页，整体排除比对。
  const desPages = new Map<string, Set<string>>();
  for (const ir of pagesIr) {
    const label = ir.page.label || ir.page.name;
    for (const comp of ir.components) {
      if (comp.designator && comp.componentType === "part") {
        const set = desPages.get(comp.designator) ?? new Set<string>();
        set.add(label);
        desPages.set(comp.designator, set);
      }
    }
  }
  const multiPage: Record<string, string[]> = {};
  for (const [designator, labels] of desPages) {
    if (labels.size > 1) multiPage[designator] = [...labels].sort();
  }

  const { rows, warnings } = buildNetlist(docs, symbols, devices);
  const geo = buildGeometry(docs);

  const meta: Artifacts["meta"] = {
    project: proj.title,
    source: path.basename(projectPath),
    epru: proj.epruName,
    record_lines: stats.total,
    record_unparsed: stats.unparsed,
    project_meta: proj.projectMeta,
    documents: docs.map((doc) => ({
      docType: doc.docType,
      uuid: doc.uuid,
      title: docTitle(doc),
    })),
    library: {
      symbols: symbols.size,
      devices: devices.size,
      footprints: footprints.size,
    },
    pages: pageList,
    pages_analyzed: pagesIr.map((ir) => ir.page.label || ir.page.name),
    // 按 uuid 记录真正解析过的页：同名页会有 P1 / P1#2 两个 label，
    // 用 label（或 name）比对会把同名页判错，uuid 才是唯一键。
    pages_analyzed_uuids: pagesIr.map((ir) => ir.page.uuid),
  };

  const artifacts: Artifacts = {
    meta,
    pages_ir: pagesIr,
    pin_net: pinNet,
    ambiguous,
    multi_page_designators: multiPage,
    pcb_rows: rows,
    pcb_warnings: warnings,
    geometry: geo,
  };
  return { artifacts, docs, proj, stats };
}

/** PCB 上同一位号挂在多个元件上的情况：这类位号的引脚无法唯一对应，不能参与比对。 */
export function duplicateDesignators(rows: readonly PcbRow[]): Record<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = seen.get(row.designator) ?? new Set<string>();
    set.add(row.component);
    seen.set(row.designator, set);
  }
  const out: Record<string, number> = {};
  for (const [designator, comps] of seen) {
    if (comps.size > 1) out[designator] = comps.size;
  }
  return out;
}

/** 原理图侧与 PCB 侧逐脚比对，返回 (mismatches, stats)。 */
export function checkConsistency(artifacts: Artifacts): {
  mismatches: Mismatch[];
  stats: ConsistencyStats;
} {
  const rows = artifacts.pcb_rows;
  const pinNetMap = artifacts.pin_net ?? new Map();
  const dup = duplicateDesignators(rows);
  const multiPage = artifacts.multi_page_designators ?? {};
  const pcbMap = new Map<string, string>();
  const duplicatePinKeys = new Set<string>();
  const duplicatePinConflicts = new Set<string>();

  for (const row of rows) {
    const key = pinKey(row.designator, row.pinNumber);
    if (row.pinNumber === null) continue;
    if (Object.hasOwn(dup, row.designator) || Object.hasOwn(multiPage, row.designator)) continue;
    const net = row.net || "";
    if (pcbMap.has(key)) {
      // 同一 (位号, 引脚号) 出现多行：不再静默留首行。
      duplicatePinKeys.add(key);
      if (pcbMap.get(key) !== net) duplicatePinConflicts.add(key);
      continue;
    }
    pcbMap.set(key, net);
  }
  // 网络互相矛盾的键连“信哪条”都定不了，只能排除比对并报出来。
  for (const key of duplicatePinConflicts) pcbMap.delete(key);

  const mismatches: Mismatch[] = [];
  let compared = 0;
  let skipped = 0;
  for (const [key, net] of pinNetMap) {
    const [designator, pinNumber] = splitPinKey(key);
    if (!designator || pinNumber === null) continue;
    if (!pcbMap.has(key)) continue;
    const pcbNet = pcbMap.get(key) ?? "";
    if (net.startsWith("N$") || !pcbNet) {
      skipped += 1;
      continue;
    }
    compared += 1;
    if (net !== pcbNet) {
      mismatches.push({ designator, pin: pinNumber, schematic: net, pcb: pcbNet });
    }
  }
  const stats: ConsistencyStats = {
    compared,
    mismatch: mismatches.length,
    skipped_unnamed: skipped,
    ambiguous: artifacts.ambiguous?.size ?? 0,
    duplicate_designators: Object.keys(dup).length,
    duplicate_pin_keys: duplicatePinKeys.size,
    duplicate_pin_conflicts: duplicatePinConflicts.size,
    multi_page: Object.keys(multiPage).length,
    pcb_rows: rows.length,
    schematic_nets: pinNetMap.size,
  };
  return { mismatches, stats };
}

/**
 * 只连了一个实体引脚的命名网络，通常是悬空或绘图残留。
 *
 * 返回 (列表, 是否被截断)。截断时报告里必须注明“仅列前 N 条”，
 * 否则会被当成全部结果。
 */
export function findFloating(
  pagesIr: readonly SchematicIr[],
  limit = 40,
): { floating: FloatingNet[]; truncated: boolean } {
  const out: FloatingNet[] = [];
  for (const ir of pagesIr) {
    for (const net of ir.nets) {
      if (!net.named) continue;
      const real = net.pins.filter((pin) => pin.componentType === "part");
      if (real.length <= 1) {
        out.push({ net: net.name, page: ir.page.name, pins: real });
      }
      if (out.length >= limit) return { floating: out, truncated: true };
    }
  }
  return { floating: out, truncated: false };
}

export interface AnalyzeRun {
  artifacts: Artifacts;
  docs: ParsedDoc[];
  proj: Project;
  stats: ParseStats;
  mismatches: Mismatch[];
  consistency: ConsistencyStats;
  floating: FloatingNet[];
  floatingTruncated: boolean;
  report: string;
  files: string[];
}

function netsDump(pagesIr: readonly SchematicIr[]): NetsDump {
  return {
    pages: pagesIr.map((ir) => ({ page: ir.page, nets: ir.nets })),
  };
}

/** 全量解析并写出产物。返回产物路径与关键统计，CLI/MCP 复用。 */
export function runSingle(
  projectPath: string,
  outDir: string,
  pageKey?: string | null,
): AnalyzeRun {
  const collected = collect(projectPath, pageKey);
  const { artifacts, docs, proj, stats } = collected;
  const safeOutDir = ensureSafeOutputDir(outDir);
  const files: string[] = [];

  files.push(writeJson(path.join(safeOutDir, "meta.json"), artifacts.meta));

  const usedNames = new Set<string>();
  for (const ir of artifacts.pages_ir) {
    const base = slug(ir.page.name);
    let name = base;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${base}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    files.push(writeJson(path.join(safeOutDir, `schematic_${name}.json`), ir));
  }
  files.push(writeJson(path.join(safeOutDir, "nets.json"), netsDump(artifacts.pages_ir)));

  files.push(
    writeText(
      path.join(safeOutDir, "pcb_netlist.csv"),
      `\uFEFF${formatNetlistCsv(artifacts.pcb_rows)}`,
    ),
  );
  files.push(writeJson(path.join(safeOutDir, "pcb_geometry.json"), artifacts.geometry));

  const { mismatches, stats: consistency } = checkConsistency(artifacts);
  const { floating, truncated } = findFloating(artifacts.pages_ir);
  const report = renderReport(artifacts, mismatches, consistency, floating, truncated);
  files.push(writeText(path.join(safeOutDir, "report.md"), report));

  return {
    artifacts,
    docs,
    proj,
    stats,
    mismatches,
    consistency,
    floating,
    floatingTruncated: truncated,
    report,
    files,
  };
}

export interface DiffRun {
  result: DiffResult;
  summary: string;
  files: string[];
}

/** 两版比较并写出 diff.json / diff.md。 */
export function runDiff(oldPath: string, newPath: string, outDir: string): DiffRun {
  const result = compare(oldPath, newPath);
  const safeOutDir = ensureSafeOutputDir(outDir);
  const writtenSummary = summarize(result);
  const files = [
    writeJson(path.join(safeOutDir, "diff.json"), result),
    writeText(
      path.join(safeOutDir, "diff.md"),
      `# 版本差异\n\n\`\`\`\n${writtenSummary}\n\`\`\`\n`,
    ),
  ];
  return { result, summary: writtenSummary, files };
}

/** 工程检视：不构建网表，只报告容器/记录层信息。 */
export interface InspectResult {
  title: string;
  source: string;
  path: string;
  epru: string;
  recordLines: number;
  recordUnparsed: number;
  projectMeta: Record<string, unknown>;
  members: ProjectMember[];
  documents: { docType: string | null; uuid: string | null; title: string }[];
  library: { symbols: number; devices: number; footprints: number };
}

export function inspectProject(projectPath: string): InspectResult {
  const proj = openProject(projectPath);
  const stats: ParseStats = { total: 0, unparsed: 0 };
  const docs = parseRecords(proj.epruText, stats);
  const symbols = buildSymbols(docs);
  const devices = buildDevices(docs);
  const footprints = buildFootprints(docs);
  return {
    title: proj.title,
    source: path.basename(projectPath),
    path: projectPath,
    epru: proj.epruName,
    recordLines: proj.lineCount(),
    recordUnparsed: stats.unparsed,
    projectMeta: proj.projectMeta,
    members: proj.members,
    documents: docs.map((doc) => ({
      docType: doc.docType,
      uuid: doc.uuid,
      title: docTitle(doc),
    })),
    library: { symbols: symbols.size, devices: devices.size, footprints: footprints.size },
  };
}

/** 从解析结果里挑出报告摘要需要的数字，MCP/CLI 共用。 */
export function analyzeSummary(run: AnalyzeRun): Record<string, unknown> {
  const pages = run.artifacts.pages_ir.map((ir) => ({
    uuid: ir.page.uuid,
    name: ir.page.name,
    label: ir.page.label ?? ir.page.name,
    components: ir.components.length,
    parts: ir.components.filter((comp) => comp.componentType === "part").length,
    wires: ir.wires.length,
    nets: ir.nets.length,
    warnings: ir.warnings,
  }));
  return {
    project: run.artifacts.meta.project,
    source: run.artifacts.meta.source,
    documents: run.artifacts.meta.documents.length,
    library: run.artifacts.meta.library,
    pages,
    pcb: {
      netlistRows: run.artifacts.pcb_rows.length,
      warnings: run.artifacts.pcb_warnings,
      outline: run.artifacts.geometry.outline,
      traces: (run.artifacts.geometry.traces ?? []).length,
      vias: (run.artifacts.geometry.vias ?? []).length,
    },
    consistency: run.consistency,
    floating: run.floating.length,
    floatingTruncated: run.floatingTruncated,
    files: run.files,
  };
}
