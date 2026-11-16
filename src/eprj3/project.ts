/**
 * `.eprj3` 文件夹工程：索引（`<name>.eprj3`）与文档文件清单。
 *
 * 索引是 JSON，`profile` 里按 boards / schematics / sheets / pcbs / panels
 * 列出工程成员。原理图文档在 `sch/<原理图名>/`：`.ecfg` 是原理图容器（DOCHEAD
 * + META），`.evar` 是变体数据（可以是空文件），每页 `.esch2`。PCB 文档是
 * `pcb/<标题>.epcb2`，面板是 `panel/<标题>.epan2`。库文档（SYMBOL /
 * FOOTPRINT / DEVICE）嵌在对应容器的前面，主文档在最后。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  clientIdFrom,
  readDocumentFile,
  readTextBomSafe,
  reduceDocSection,
  type DocSection,
  type ReducedRecordSet,
} from "./records.ts";

export interface BoardEntry {
  uuid?: string;
  title?: string;
  zIndex?: number | null;
  [key: string]: unknown;
}

export interface SchematicEntry {
  uuid?: string;
  name?: string;
  board?: string;
  [key: string]: unknown;
}

export interface SheetEntry {
  uuid?: string;
  title?: string;
  schematic_uuid?: string;
  zIndex?: number | null;
  [key: string]: unknown;
}

export interface PcbEntry {
  uuid?: string;
  title?: string;
  board?: string;
  [key: string]: unknown;
}

export interface PanelEntry {
  uuid?: string;
  title?: string;
  zIndex?: number | null;
  [key: string]: unknown;
}

export interface Eprj3Profile {
  boards: Record<string, BoardEntry>;
  schematics: Record<string, SchematicEntry>;
  sheets: Record<string, SheetEntry>;
  pcbs: Record<string, PcbEntry>;
  panels: Record<string, PanelEntry>;
  owner?: { uuid?: string; [key: string]: unknown };
  blockSymbols?: Record<string, unknown>;
  simSchematics?: Record<string, unknown>;
  simulations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Eprj3Index {
  name?: string;
  format?: string;
  owner_uuid?: string;
  creator_uuid?: string;
  modifier_uuid?: string;
  created_at?: string;
  updated_at?: string;
  profile: Eprj3Profile;
  [key: string]: unknown;
}

export interface Eprj3Project {
  /** 工程根目录（绝对路径）。 */
  rootDir: string;
  /** 工程名：优先用索引里的 name，没有时用目录名。 */
  name: string;
  /** 索引文件绝对路径。 */
  indexFile: string;
  index: Eprj3Index;
  profile: Eprj3Profile;
  /** owner uuid 推导出的客户端 id。 */
  client: string | null;
}

export class Eprj3ProjectError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "Eprj3ProjectError";
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asEntries<T>(value: unknown): Record<string, T> | null {
  if (!isPlainObject(value)) return null;
  const out: Record<string, T> = {};
  for (const [uuid, entry] of Object.entries(value)) {
    if (isPlainObject(entry)) out[uuid] = entry as T;
  }
  return out;
}

function asProfile(value: unknown): Eprj3Profile | null {
  if (!isPlainObject(value)) return null;
  const boards = asEntries<BoardEntry>(value.boards);
  const schematics = asEntries<SchematicEntry>(value.schematics);
  const sheets = asEntries<SheetEntry>(value.sheets);
  const pcbs = asEntries<PcbEntry>(value.pcbs);
  const panels = asEntries<PanelEntry>(value.panels);
  if (
    boards === null ||
    schematics === null ||
    sheets === null ||
    pcbs === null ||
    panels === null
  ) {
    return null;
  }
  const result: Eprj3Profile = { boards, schematics, sheets, pcbs, panels };
  if (isPlainObject(value.owner)) result.owner = value.owner;
  if (isPlainObject(value.blockSymbols)) result.blockSymbols = value.blockSymbols;
  if (isPlainObject(value.simSchematics)) result.simSchematics = value.simSchematics;
  if (isPlainObject(value.simulations)) result.simulations = value.simulations;
  return result;
}

/** 在目录里找唯一的 `.eprj3` 索引；没有或不止一个时返回 null。 */
export function findIndexFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => name.endsWith(".eprj3"));
  const name = files[0];
  return files.length === 1 && name !== undefined ? path.join(dir, name) : null;
}

function readIndex(filePath: string): Eprj3Index {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readTextBomSafe(filePath)) as unknown;
  } catch (error) {
    throw new Eprj3ProjectError(
      "EPRJ3_INDEX_JSON",
      `索引不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Eprj3ProjectError("EPRJ3_INDEX_SHAPE", "索引顶层必须是 JSON 对象");
  }
  if (parsed.format !== "folder") {
    throw new Eprj3ProjectError("EPRJ3_INDEX_FORMAT", '索引 format 必须是 "folder"');
  }
  const profile = asProfile(parsed.profile);
  if (profile === null) {
    throw new Eprj3ProjectError(
      "EPRJ3_INDEX_PROFILE",
      "索引缺少 profile，或 profile 的 boards/schematics/sheets/pcbs/panels 不是对象",
    );
  }
  const index = parsed as unknown as Eprj3Index;
  index.profile = profile;
  return index;
}

/** 加载工程。索引名不必等于目录名：先试 `<目录名>.eprj3`，再找目录里唯一的 `.eprj3`。 */
export function loadEprj3Project(dir: string): Eprj3Project {
  const rootDir = path.resolve(dir);
  if (!existsSync(rootDir)) {
    throw new Eprj3ProjectError("EPRJ3_NOT_FOUND", `工程目录不存在：${rootDir}`);
  }
  const defaultIndex = path.join(rootDir, `${path.basename(rootDir)}.eprj3`);
  const indexFile = existsSync(defaultIndex) ? defaultIndex : findIndexFile(rootDir);
  if (indexFile === null) {
    throw new Eprj3ProjectError("EPRJ3_INDEX_MISSING", `找不到唯一的 .eprj3 索引：${rootDir}`);
  }
  const index = readIndex(indexFile);
  const ownerUuid = typeof index.owner_uuid === "string" ? index.owner_uuid : null;
  return {
    rootDir,
    name: typeof index.name === "string" && index.name !== "" ? index.name : path.basename(rootDir),
    indexFile,
    index,
    profile: index.profile,
    client: ownerUuid === null || ownerUuid === "" ? null : clientIdFrom(ownerUuid),
  };
}

function entryUuid(uuid: string, entry: Record<string, unknown>): string {
  return typeof entry.uuid === "string" && entry.uuid !== "" ? entry.uuid : uuid;
}

function entryTitle(uuid: string, entry: Record<string, unknown>, fallback: string): string {
  return typeof entry.title === "string" && entry.title !== "" ? entry.title : fallback;
}

export function schematicDir(project: Eprj3Project, schematic: SchematicEntry): string | null {
  return typeof schematic.name === "string" && schematic.name !== ""
    ? path.join(project.rootDir, "sch", schematic.name)
    : null;
}

export function ecfgFile(project: Eprj3Project, schematic: SchematicEntry): string | null {
  const dir = schematicDir(project, schematic);
  return dir === null ? null : path.join(dir, `${schematic.name ?? ""}.ecfg`);
}

export function evarFile(project: Eprj3Project, schematic: SchematicEntry): string | null {
  const dir = schematicDir(project, schematic);
  return dir === null ? null : path.join(dir, `${schematic.name ?? ""}.evar`);
}

/** 原理图页文件；`schematic_uuid` 指向不存在的原理图时返回 null。 */
export function sheetFile(project: Eprj3Project, sheet: SheetEntry): string | null {
  const schematicUuid = typeof sheet.schematic_uuid === "string" ? sheet.schematic_uuid : "";
  const schematic = project.profile.schematics[schematicUuid];
  const dir = schematic === undefined ? null : schematicDir(project, schematic);
  if (dir === null || typeof sheet.title !== "string" || sheet.title === "") return null;
  return path.join(dir, `${sheet.title}.esch2`);
}

export function pcbFile(project: Eprj3Project, pcb: PcbEntry): string | null {
  return typeof pcb.title === "string" && pcb.title !== ""
    ? path.join(project.rootDir, "pcb", `${pcb.title}.epcb2`)
    : null;
}

export function panelFile(project: Eprj3Project, panel: PanelEntry): string | null {
  return typeof panel.title === "string" && panel.title !== ""
    ? path.join(project.rootDir, "panel", `${panel.title}.epan2`)
    : null;
}

/**
 * 把用户给的工程内相对路径解析成绝对路径，并拒绝跳出工程目录。
 * MCP / CLI 的 `--file` 参数都走这里。
 */
export function resolveProjectPath(
  project: Eprj3Project,
  filePath: string,
): { absolute: string; relative: string } {
  const absolute = path.resolve(project.rootDir, filePath);
  const relative = path.relative(project.rootDir, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Eprj3ProjectError("EPRJ3_PATH_OUTSIDE", `文件必须在工程目录内：${filePath}`);
  }
  return { absolute, relative: relative.split(path.sep).join("/") };
}

export type DocumentFileRole = "ecfg" | "evar" | "sheet" | "pcb" | "panel" | "extra";

export interface DocumentDocInfo {
  docType: string | null;
  uuid: string | null;
  client: string | null;
  recordCount: number;
  tombstoneCount: number;
  reducedRecordCount: number;
  metaEmpty: boolean;
  unparsed: number;
  typeCounts: Record<string, number>;
  reducedTypeCounts: Record<string, number>;
}

export interface DocumentFileInfo {
  file: string;
  /** 工程内相对路径，用 `/` 分隔。 */
  relPath: string;
  role: DocumentFileRole;
  exists: boolean;
  bytes: number;
  /** 索引/文件名要求的主文档 uuid；`.evar` 与额外文件为 null。 */
  expectedUuid: string | null;
  docs: DocumentDocInfo[];
  recordCount: number;
  tombstoneCount: number;
  reducedRecordCount: number;
  typeCounts: Record<string, number>;
  reducedTypeCounts: Record<string, number>;
  orphans: number;
  unparsed: number;
  /** 读文件或解析失败时的说明。 */
  warning?: string;
}

export interface DocumentFileInput {
  file: string;
  role: DocumentFileRole;
  expectedUuid?: string | null;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function summarizeSection(section: DocSection, reduced: ReducedRecordSet): DocumentDocInfo {
  const typeCounts: Record<string, number> = {};
  const reducedTypeCounts: Record<string, number> = {};
  for (const record of section.records) bump(typeCounts, record.type);
  for (const record of reduced.records) bump(reducedTypeCounts, record.type);
  return {
    docType: section.docType,
    uuid: section.uuid,
    client: section.client,
    recordCount: section.records.length,
    tombstoneCount: section.records.filter((record) => record.tombstone).length,
    reducedRecordCount: reduced.records.length,
    metaEmpty: reduced.metaEmpty,
    unparsed: section.unparsed,
    typeCounts,
    reducedTypeCounts,
  };
}

/** 读一个文档文件并汇总（文档清单、记录类型计数、墓碑数、归约后计数）。 */
export function describeDocumentFile(
  project: Eprj3Project,
  input: DocumentFileInput,
): DocumentFileInfo {
  const relative = path.relative(project.rootDir, input.file).split(path.sep).join("/");
  const base: DocumentFileInfo = {
    file: input.file,
    relPath: relative,
    role: input.role,
    exists: existsSync(input.file),
    bytes: 0,
    expectedUuid: input.expectedUuid ?? null,
    docs: [],
    recordCount: 0,
    tombstoneCount: 0,
    reducedRecordCount: 0,
    typeCounts: {},
    reducedTypeCounts: {},
    orphans: 0,
    unparsed: 0,
  };
  if (!base.exists) return base;

  try {
    base.bytes = statSync(input.file).size;
  } catch {
    // 大小读不到不影响后续内容汇总。
  }

  // `.evar` 是变体数据，不是记录流；空文件也合法。
  if (input.role === "evar") return base;

  let split;
  try {
    split = readDocumentFile(input.file);
  } catch (error) {
    base.warning = `读取失败：${error instanceof Error ? error.message : String(error)}`;
    return base;
  }
  base.orphans = split.orphans;
  base.unparsed = split.unparsed;
  for (const section of split.sections) {
    const reduced = reduceDocSection(section);
    const info = summarizeSection(section, reduced);
    base.docs.push(info);
    base.recordCount += info.recordCount;
    base.tombstoneCount += info.tombstoneCount;
    base.reducedRecordCount += info.reducedRecordCount;
    for (const [type, count] of Object.entries(info.typeCounts)) {
      base.typeCounts[type] = (base.typeCounts[type] ?? 0) + count;
    }
    for (const [type, count] of Object.entries(info.reducedTypeCounts)) {
      base.reducedTypeCounts[type] = (base.reducedTypeCounts[type] ?? 0) + count;
    }
  }
  return base;
}

function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b)));
}

function knownFileNames(project: Eprj3Project, schematic: SchematicEntry): Set<string> {
  const known = new Set<string>();
  if (typeof schematic.name === "string" && schematic.name !== "") {
    known.add(`${schematic.name}.ecfg`);
    known.add(`${schematic.name}.evar`);
  }
  for (const sheet of Object.values(project.profile.sheets)) {
    if (sheet.schematic_uuid !== schematic.uuid) continue;
    if (typeof sheet.title === "string") known.add(`${sheet.title}.esch2`);
  }
  return known;
}

/**
 * 工程的全部文档文件（按原理图 / 页 / PCB / 面板排序）。
 *
 * 索引里登记了但磁盘上缺失的文件也会出现（`exists:false`），让 inspect 和格式门
 * 能直接报出来；`sch/`、`pcb/`、`panel/` 里没登记的记录文件作为 `extra` 收进来。
 */
export function documentFiles(project: Eprj3Project): DocumentFileInfo[] {
  const out: DocumentFileInfo[] = [];

  const schematics = sortBy(Object.entries(project.profile.schematics), ([, entry]) =>
    typeof entry.name === "string" ? entry.name : "",
  );
  for (const [uuid, schematic] of schematics) {
    const dir = schematicDir(project, schematic);
    const ecfg = ecfgFile(project, schematic);
    const evar = evarFile(project, schematic);
    if (ecfg !== null)
      out.push(
        describeDocumentFile(project, {
          file: ecfg,
          role: "ecfg",
          expectedUuid: entryUuid(uuid, schematic),
        }),
      );
    if (evar !== null) out.push(describeDocumentFile(project, { file: evar, role: "evar" }));

    const sheets = sortBy(
      Object.entries(project.profile.sheets).filter(([, sheet]) => sheet.schematic_uuid === uuid),
      ([, sheet]) =>
        (typeof sheet.zIndex === "number" ? String(sheet.zIndex).padStart(8, "0") : "99999999") +
        (sheet.title ?? ""),
    );
    for (const [sheetUuid, sheet] of sheets) {
      const file = sheetFile(project, sheet);
      if (file === null) continue;
      out.push(
        describeDocumentFile(project, {
          file,
          role: "sheet",
          expectedUuid: entryUuid(sheetUuid, sheet),
        }),
      );
    }

    if (dir !== null && existsSync(dir)) {
      const known = knownFileNames(project, schematic);
      for (const name of sortBy(readdirSync(dir), (value) => value)) {
        if (known.has(name) || !/\.(esch2|ecfg|evar)$/i.test(name)) continue;
        out.push(describeDocumentFile(project, { file: path.join(dir, name), role: "extra" }));
      }
    }
  }

  const pcbs = sortBy(Object.entries(project.profile.pcbs), ([, entry]) =>
    typeof entry.title === "string" ? entry.title : "",
  );
  for (const [uuid, pcb] of pcbs) {
    const file = pcbFile(project, pcb);
    if (file === null) continue;
    out.push(
      describeDocumentFile(project, { file, role: "pcb", expectedUuid: entryUuid(uuid, pcb) }),
    );
  }
  const pcbDir = path.join(project.rootDir, "pcb");
  if (existsSync(pcbDir)) {
    const known = new Set(
      Object.values(project.profile.pcbs)
        .map((pcb) => (typeof pcb.title === "string" ? `${pcb.title}.epcb2` : ""))
        .filter((name) => name !== ""),
    );
    for (const name of sortBy(readdirSync(pcbDir), (value) => value)) {
      if (known.has(name) || !/\.epcb2$/i.test(name)) continue;
      out.push(describeDocumentFile(project, { file: path.join(pcbDir, name), role: "extra" }));
    }
  }

  const panels = sortBy(Object.entries(project.profile.panels), ([, entry]) =>
    typeof entry.title === "string" ? entry.title : "",
  );
  for (const [uuid, panel] of panels) {
    const file = panelFile(project, panel);
    if (file === null) continue;
    out.push(
      describeDocumentFile(project, { file, role: "panel", expectedUuid: entryUuid(uuid, panel) }),
    );
  }
  const panelDir = path.join(project.rootDir, "panel");
  if (existsSync(panelDir)) {
    const known = new Set(
      Object.values(project.profile.panels)
        .map((panel) => (typeof panel.title === "string" ? `${panel.title}.epan2` : ""))
        .filter((name) => name !== ""),
    );
    for (const name of sortBy(readdirSync(panelDir), (value) => value)) {
      if (known.has(name) || !/\.epan2$/i.test(name)) continue;
      out.push(describeDocumentFile(project, { file: path.join(panelDir, name), role: "extra" }));
    }
  }

  return out;
}

export interface InspectSheet {
  uuid: string;
  title: string;
  schematic: string | null;
  file: string | null;
  exists: boolean;
}

export interface InspectPcb {
  uuid: string;
  title: string;
  board: string | null;
  file: string | null;
  exists: boolean;
}

export interface Eprj3Inspect {
  dir: string;
  name: string;
  indexFile: string;
  format: string | null;
  ownerUuid: string | null;
  client: string | null;
  profile: {
    boards: number;
    schematics: number;
    sheets: number;
    pcbs: number;
    panels: number;
    blockSymbols: number;
    simSchematics: number;
    simulations: number;
  };
  boards: { uuid: string; title: string }[];
  schematics: { uuid: string; name: string; board: string | null; dir: string | null }[];
  sheets: InspectSheet[];
  pcbs: InspectPcb[];
  files: DocumentFileInfo[];
  totals: {
    files: number;
    presentFiles: number;
    docs: number;
    records: number;
    tombstones: number;
    reducedRecords: number;
    types: Record<string, number>;
  };
  warnings: string[];
}

/** 工程检视：profile、每个文件的文档清单、记录类型计数、墓碑数。 */
export function inspectEprj3Project(dir: string): Eprj3Inspect {
  const project = loadEprj3Project(dir);
  const warnings: string[] = [];
  const files = documentFiles(project);

  const boards = sortBy(Object.entries(project.profile.boards), ([, entry]) =>
    entryTitle("", entry, ""),
  ).map(([uuid, entry]) => ({
    uuid: entryUuid(uuid, entry),
    title: entryTitle(uuid, entry, "(未命名)"),
  }));

  const schematics = sortBy(Object.entries(project.profile.schematics), ([, entry]) =>
    typeof entry.name === "string" ? entry.name : "",
  ).map(([uuid, entry]) => ({
    uuid: entryUuid(uuid, entry),
    name: typeof entry.name === "string" ? entry.name : "(未命名)",
    board: typeof entry.board === "string" ? entry.board : null,
    dir: schematicDir(project, entry),
  }));

  const sheets: InspectSheet[] = sortBy(Object.entries(project.profile.sheets), ([, entry]) =>
    typeof entry.title === "string" ? entry.title : "",
  ).map(([uuid, entry]) => {
    const schematicUuid = typeof entry.schematic_uuid === "string" ? entry.schematic_uuid : "";
    const schematic = project.profile.schematics[schematicUuid];
    if (schematic === undefined) {
      warnings.push(
        `页 ${typeof entry.title === "string" ? entry.title : uuid} 的 schematic_uuid ${schematicUuid} 不在 profile.schematics 里`,
      );
    }
    const file = sheetFile(project, entry);
    return {
      uuid: entryUuid(uuid, entry),
      title: typeof entry.title === "string" ? entry.title : "(未命名)",
      schematic: schematic && typeof schematic.name === "string" ? schematic.name : null,
      file,
      exists: file !== null && existsSync(file),
    };
  });

  const pcbs: InspectPcb[] = sortBy(Object.entries(project.profile.pcbs), ([, entry]) =>
    typeof entry.title === "string" ? entry.title : "",
  ).map(([uuid, entry]) => {
    const file = pcbFile(project, entry);
    return {
      uuid: entryUuid(uuid, entry),
      title: typeof entry.title === "string" ? entry.title : "(未命名)",
      board: typeof entry.board === "string" ? entry.board : null,
      file,
      exists: file !== null && existsSync(file),
    };
  });

  const totals = {
    files: files.length,
    presentFiles: files.filter((file) => file.exists).length,
    docs: files.reduce((sum, file) => sum + file.docs.length, 0),
    records: files.reduce((sum, file) => sum + file.recordCount, 0),
    tombstones: files.reduce((sum, file) => sum + file.tombstoneCount, 0),
    reducedRecords: files.reduce((sum, file) => sum + file.reducedRecordCount, 0),
    types: {} as Record<string, number>,
  };
  for (const file of files) {
    for (const [type, count] of Object.entries(file.typeCounts)) {
      totals.types[type] = (totals.types[type] ?? 0) + count;
    }
  }

  for (const file of files) {
    // `.evar` 缺失有单独的提示（变体数据本来就可以不存在），这里不重复报。
    if (!file.exists && file.role !== "evar") warnings.push(`缺少文档文件：${file.relPath}`);
    else if (file.warning !== undefined) warnings.push(`${file.relPath}：${file.warning}`);
    if (file.role === "extra") warnings.push(`索引未登记的文件：${file.relPath}`);
  }
  for (const schematic of schematics) {
    if (schematic.dir === null) continue;
    const evar = path.join(schematic.dir, `${schematic.name}.evar`);
    if (!existsSync(evar)) warnings.push(`${schematic.name}.evar 缺失（变体数据，客户端可接受）`);
  }

  return {
    dir: project.rootDir,
    name: project.name,
    indexFile: project.indexFile,
    format: typeof project.index.format === "string" ? project.index.format : null,
    ownerUuid: typeof project.index.owner_uuid === "string" ? project.index.owner_uuid : null,
    client: project.client,
    profile: {
      boards: Object.keys(project.profile.boards).length,
      schematics: Object.keys(project.profile.schematics).length,
      sheets: Object.keys(project.profile.sheets).length,
      pcbs: Object.keys(project.profile.pcbs).length,
      panels: Object.keys(project.profile.panels).length,
      blockSymbols: Object.keys(project.profile.blockSymbols ?? {}).length,
      simSchematics: Object.keys(project.profile.simSchematics ?? {}).length,
      simulations: Object.keys(project.profile.simulations ?? {}).length,
    },
    boards,
    schematics,
    sheets,
    pcbs,
    files,
    totals,
    warnings,
  };
}
