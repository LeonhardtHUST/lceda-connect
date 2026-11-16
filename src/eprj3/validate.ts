/**
 * `.eprj3` 格式门（移植自源仓库 `scripts/lib/checks.js`）。
 *
 * 检查内容：索引形状、`.ecfg` / `.evar`、文档 uuid 与 ticket 唯一性、
 * Device / Symbol / Footprint 引用、PCB 的 NET / BOARD_OUTLINE / LAYER /
 * PAD_NET 引用、面板文件、未登记文件。
 *
 * 与原版的差异（都是对真实工程误报的修正）：
 * 1. 先归约再检查：空体是墓碑（删除语义），墓碑记录不参与引用检查；
 * 2. `LINE.lineGroup` 指向已删除的 WIRE 时降级为 warning（真机删除残留很常见）；
 * 3. `ATTR.parentId` 允许 `<元件id>-<符号引脚元素id>` 形式，引脚 id 不一定是
 *    `eN`（真机里有 16-hex 随机原子）；
 * 4. PCB 板框除了单个 `polyType:"BOARD_OUTLINE"` 的 POLY，也接受画在
 *    `layerType:"OUTLINE"` 图层上的 POLY / ARC / LINE（真机就是这样存的）。
 *
 * `strict` 模式额外对每条存活记录调用 `src/format` 的整行校验；schema 缺类型
 * 之类的误报不算错误，只统计跳过数量。
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { isKnownDocType, validateLine, type ValidationIssue } from "../format/index.ts";
import {
  ecfgFile,
  evarFile,
  loadEprj3Project,
  panelFile,
  pcbFile,
  schematicDir,
  sheetFile,
  type Eprj3Project,
} from "./project.ts";
import {
  readDocumentFile,
  reduceDocSection,
  type DocSection,
  type Eprj3Record,
  type ReducedRecordSet,
} from "./records.ts";

export interface StrictIssue {
  file: string;
  docType: string | null;
  type: string;
  field: string;
  message: string;
}

export interface StrictValidation {
  checked: number;
  /** 没有 schema / 未知文档类型而跳过的条数（不算错误）。 */
  skippedUnknownTypes: number;
  errorCount: number;
  warningCount: number;
  errors: StrictIssue[];
  warnings: StrictIssue[];
}

export interface Eprj3ValidateResult {
  dir: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  strict?: StrictValidation;
  stats: {
    files: number;
    docs: number;
    records: number;
    tombstones: number;
    reducedRecords: number;
  };
}

export interface ValidateOptions {
  strict?: boolean;
}

/** 实例路径：元件元素 id 连符号引脚元素 id，例如 e21050-e31、e55-ie307。 */
const INSTANCE_PATH = /^e\d+(?:-i?e\d+)+$/;
/** 引脚元素 id：真机里既有 eN，也有 16-hex 随机原子。 */
const PIN_ELEMENT = /^i?e\d+(?:-i?e\d+)*$/;

function hex(value: unknown, length: number): boolean {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function hexUuid(value: unknown): boolean {
  return hex(value, 16) || hex(value, 32);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonArray(value: string | null): unknown[] | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function relativeFile(rootDir: string, file: string): string {
  return path.relative(rootDir, file).split(path.sep).join("/");
}

interface DeviceNameInfo {
  uuid: string | null;
  malformed: boolean;
}

function parseDeviceName(body: Record<string, unknown>): DeviceNameInfo {
  const attrs = body.attrs;
  if (!isPlainObject(attrs)) return { uuid: null, malformed: false };
  const raw = attrs.DeviceName;
  if (typeof raw !== "string" || raw === "") return { uuid: null, malformed: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed) && typeof parsed.uuid === "string") {
      return { uuid: parsed.uuid, malformed: false };
    }
    return { uuid: null, malformed: true };
  } catch {
    return { uuid: null, malformed: true };
  }
}

function layerIdsOfType(records: readonly Eprj3Record[], layerType: string): Set<number> {
  const out = new Set<number>();
  for (const record of records) {
    if (record.type !== "LAYER") continue;
    if (record.body.layerType !== layerType) continue;
    if (typeof record.body.layerId === "number") out.add(record.body.layerId);
  }
  return out;
}

/** 校验一个工程；不抛工程不存在之外的异常。 */
export function validateEprj3Project(
  dir: string,
  options: ValidateOptions = {},
): Eprj3ValidateResult {
  const rootDir = path.resolve(dir);
  const errors: string[] = [];
  const warnings: string[] = [];
  const check = (condition: boolean, message: string): void => {
    if (!condition) errors.push(message);
  };
  const warn = (condition: boolean, message: string): void => {
    if (!condition) warnings.push(message);
  };
  const emptyStats = { files: 0, docs: 0, records: 0, tombstones: 0, reducedRecords: 0 };
  const fail = (): Eprj3ValidateResult => ({
    dir: rootDir,
    ok: false,
    errors,
    warnings,
    stats: emptyStats,
  });

  if (!existsSync(rootDir)) {
    errors.push(`工程目录不存在：${rootDir}`);
    return fail();
  }
  const indexFiles = readdirSync(rootDir).filter((name) => name.endsWith(".eprj3"));
  if (indexFiles.length !== 1) {
    errors.push(`应恰好有一个 .eprj3 索引，实际：${indexFiles.join(", ") || "没有"}`);
    return fail();
  }

  let project: Eprj3Project;
  try {
    project = loadEprj3Project(rootDir);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return fail();
  }

  // ---------------------------------------------------------------- 索引
  const index = project.index;
  check(index.format === "folder", '索引 format 必须是 "folder"');
  check(
    hex(index.owner_uuid, 32) && hex(index.creator_uuid, 32) && hex(index.modifier_uuid, 32),
    "owner / creator / modifier uuid 必须是 32 位十六进制",
  );
  check(
    typeof index.created_at === "string" && typeof index.updated_at === "string",
    "created_at / updated_at 必须是字符串",
  );
  if (isPlainObject(index.profile.owner)) {
    const ownerUuid = index.profile.owner.uuid;
    warn(
      hexUuid(ownerUuid),
      "profile.owner.uuid 不是十六进制 uuid（本地/旧版工程会存目录路径，客户端接受）",
    );
  } else {
    check(false, "profile.owner.uuid 必须是 uuid 或路径字符串");
  }
  for (const key of ["boards", "schematics", "sheets", "pcbs"] as const) {
    check(isPlainObject(index.profile[key]), `index.profile.${key} 必须是对象`);
  }

  const sectionsCache = new Map<string, DocSection[]>();
  const reducedCache = new WeakMap<DocSection, ReducedRecordSet>();
  const reducedOf = (section: DocSection): ReducedRecordSet => {
    let reduced = reducedCache.get(section);
    if (reduced === undefined) {
      reduced = reduceDocSection(section);
      reducedCache.set(section, reduced);
    }
    return reduced;
  };
  const sectionsOf = (file: string): DocSection[] | null => {
    const cached = sectionsCache.get(file);
    if (cached !== undefined) return cached;
    if (!existsSync(file)) return null;
    try {
      const split = readDocumentFile(file);
      sectionsCache.set(file, split.sections);
      return split.sections;
    } catch (error) {
      errors.push(
        `${relativeFile(rootDir, file)}: 读取失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };

  function checkDocDupes(sections: readonly DocSection[], label: string): void {
    const uuids = new Set<string>();
    for (const section of sections) {
      check(
        section.uuid !== null && !uuids.has(section.uuid),
        `${label}: 文档 uuid 缺失或重复 ${section.uuid ?? "null"}`,
      );
      if (section.uuid !== null) uuids.add(section.uuid);
    }
  }

  function checkTicketsAndRecords(section: DocSection, label: string): void {
    for (const record of section.records) {
      if (record.bodyInvalid) {
        check(
          false,
          `${label}: ${record.type} 记录内层不是合法 JSON（${record.bodyRaw.slice(0, 60)}…）`,
        );
      }
    }
    const reduced = reducedOf(section);
    const seen = new Set<string>();
    for (const record of [...reduced.records, ...reduced.tombstones]) {
      if (record.ticket !== null) {
        const key = `${record.ticket}|${record.id ?? ""}`;
        check(
          !seen.has(key),
          `${label}: ticket ${record.ticket} + id ${record.id ?? "null"} 重复（${record.type}）`,
        );
        seen.add(key);
      }
      if ((record.type === "COMPONENT" || record.type === "WIRE") && record.id === null) {
        check(false, `${label}: ${record.type} 记录没有 id`);
      }
    }
    check(!reduced.metaEmpty, `${label}: META 载荷是空串（删 META 要用 DELETE_DOC）`);
  }

  function checkAttrParents(sections: readonly DocSection[], label: string): void {
    const perDoc = sections.map((section) => {
      const reduced = reducedOf(section);
      const ids = new Set<string>();
      if (section.uuid !== null) ids.add(section.uuid);
      for (const record of [...reduced.records, ...reduced.tombstones]) {
        if (record.id !== null) ids.add(record.id);
      }
      return { section, reduced, ids };
    });
    const allIds = new Set<string>();
    for (const entry of perDoc) for (const id of entry.ids) allIds.add(id);

    for (const entry of perDoc) {
      for (const record of entry.reduced.records) {
        if (record.type !== "ATTR") continue;
        const parentId = record.body.parentId;
        if (typeof parentId !== "string" || parentId === "") continue;
        if (INSTANCE_PATH.test(parentId)) continue;
        const cut = parentId.indexOf("-");
        if (cut > 0) {
          const owner = parentId.slice(0, cut);
          const rest = parentId.slice(cut + 1);
          const ownerKnown = entry.ids.has(owner);
          const pinKnown = allIds.has(rest) || PIN_ELEMENT.test(rest);
          if (ownerKnown && pinKnown) continue;
        }
        if (entry.ids.has(parentId) || allIds.has(parentId)) continue;
        check(
          false,
          `${label}: ATTR ${typeof record.body.key === "string" ? record.body.key : ""} parentId ${parentId} 在容器内找不到对应记录`,
        );
      }
    }
  }

  function collectTypes(sections: readonly DocSection[]): {
    devUuids: Set<string>;
    symUuids: Set<string>;
    fpUuids: Set<string>;
  } {
    const devUuids = new Set<string>();
    const symUuids = new Set<string>();
    const fpUuids = new Set<string>();
    for (const section of sections) {
      if (section.docType === null || section.uuid === null) continue;
      if (section.docType === "DEVICE") devUuids.add(section.uuid);
      if (section.docType === "SYMBOL") symUuids.add(section.uuid);
      if (section.docType === "FOOTPRINT") fpUuids.add(section.uuid);
    }
    return { devUuids, symUuids, fpUuids };
  }

  // -------------------------------------------------------------- 原理图
  for (const [uuid, schematic] of Object.entries(project.profile.schematics)) {
    check(
      hexUuid(schematic.uuid) && typeof schematic.name === "string" && schematic.name !== "",
      `原理图条目非法：${JSON.stringify(schematic)}`,
    );
    const board = typeof schematic.board === "string" ? schematic.board : "";
    check(
      board !== "" && project.profile.boards[board] !== undefined,
      `原理图 ${schematic.name ?? uuid} 的 board ${board} 不在 profile.boards 里`,
    );
    const dir = schematicDir(project, schematic);
    check(dir !== null && existsSync(dir), `缺少原理图目录 ${dir ?? "(无名)"}`);
    const ecfg = ecfgFile(project, schematic);
    if (ecfg === null) {
      errors.push(`原理图 ${uuid} 没有名字，无法定位 .ecfg`);
      continue;
    }
    const ecfgLabel = relativeFile(rootDir, ecfg);
    if (!existsSync(ecfg)) {
      errors.push(`缺少 ${ecfgLabel}`);
    } else {
      const sections = sectionsOf(ecfg);
      if (sections !== null) {
        check(
          sections.length === 1 &&
            sections[0]?.docType === "SCH" &&
            sections[0]?.uuid === schematic.uuid,
          `${ecfgLabel}: 期望单个 SCH 文档且 uuid 为 ${schematic.uuid ?? "?"}`,
        );
        const recordCount = sections.reduce(
          (sum, section) => sum + 1 + section.records.length + section.unparsed,
          0,
        );
        check(
          recordCount === 2 || recordCount === 4,
          `${ecfgLabel}: 期望 2 或 4 条记录（DOCHEAD META [RULE RULE]），实际 ${recordCount}`,
        );
        if (sections.length === 1) {
          const only = sections[0];
          if (only !== undefined) {
            checkTicketsAndRecords(only, ecfgLabel);
            checkAttrParents(sections, ecfgLabel);
          }
        }
      }
    }
    const evar = evarFile(project, schematic);
    warn(evar !== null && existsSync(evar), `${schematic.name ?? uuid}.evar 缺失（变体数据）`);
  }

  // ------------------------------------------------------------------ 页
  for (const [uuid, sheet] of Object.entries(project.profile.sheets)) {
    const schematicUuid = typeof sheet.schematic_uuid === "string" ? sheet.schematic_uuid : "";
    const schematic = project.profile.schematics[schematicUuid];
    check(
      schematic !== undefined,
      `页 ${sheet.title ?? uuid} 的 schematic_uuid ${schematicUuid} 不在 profile 里`,
    );
    if (schematic === undefined) continue;
    const file = sheetFile(project, sheet);
    if (file === null) {
      errors.push(`页 ${sheet.title ?? uuid} 没有标题，无法定位 .esch2`);
      continue;
    }
    const label = relativeFile(rootDir, file);
    if (!existsSync(file)) {
      errors.push(`缺少页文档 ${label}`);
      continue;
    }
    const sections = sectionsOf(file);
    if (sections === null) continue;
    if (sections.length === 0) {
      errors.push(`${label}: 文件里没有 DOCHEAD（空文件或写了一半）`);
      continue;
    }
    check(
      sections.length >= 3,
      `${label}: 至少要有 3 个文档（图框符号、器件、页），实际 ${sections.length}`,
    );
    checkDocDupes(sections, label);
    for (const section of sections) {
      checkTicketsAndRecords(section, `${label}[${section.docType ?? "?"}]`);
    }
    checkAttrParents(sections, label);

    const main = sections[sections.length - 1];
    if (main === undefined) continue;
    check(
      main.docType === "SCH_PAGE" && main.uuid === sheet.uuid,
      `${label}: 最后一个文档必须是 uuid ${sheet.uuid ?? "?"} 的 SCH_PAGE，实际 ${main.docType} ${main.uuid ?? "null"}`,
    );
    const { devUuids, symUuids } = collectTypes(sections);
    const mainRecords = main === undefined ? [] : reducedOf(main).records;
    const wireIds = new Set(
      mainRecords
        .filter((record) => record.type === "WIRE" && record.id !== null)
        .map((record) => record.id as string),
    );
    for (const record of mainRecords) {
      if (record.type === "COMPONENT") {
        const deviceName = parseDeviceName(record.body);
        if (deviceName.malformed) {
          check(false, `${label}: 元件 ${record.id ?? "?"} 的 DeviceName 不是合法 JSON`);
        } else if (deviceName.uuid !== null) {
          check(
            devUuids.has(deviceName.uuid),
            `${label}: 元件 ${record.id ?? "?"} 的 DeviceName uuid ${deviceName.uuid} 没有对应 DEVICE 文档`,
          );
        }
      }
      if (record.type === "ATTR" && record.body.parentId !== undefined) {
        const key = record.body.key;
        const value = record.body.value;
        if (key === "Symbol" && typeof value === "string") {
          check(symUuids.has(value), `${label}: Symbol 属性引用了不存在的 SYMBOL 文档 ${value}`);
        }
        if (key === "Device" && typeof value === "string") {
          check(devUuids.has(value), `${label}: Device 属性引用了不存在的 DEVICE 文档 ${value}`);
        }
      }
      if (record.type === "LINE") {
        const lineGroup = record.body.lineGroup;
        if (typeof lineGroup === "string" && lineGroup !== "" && !wireIds.has(lineGroup)) {
          warnings.push(
            `${label}: LINE 引用的 WIRE ${lineGroup} 不存在（按删除残留降级为 warning）`,
          );
        }
      }
    }
  }

  // ----------------------------------------------------------------- PCB
  for (const [uuid, pcb] of Object.entries(project.profile.pcbs)) {
    const board = typeof pcb.board === "string" ? pcb.board : "";
    check(
      board !== "" && project.profile.boards[board] !== undefined,
      `PCB ${pcb.title ?? uuid} 的 board ${board} 不在 profile.boards 里`,
    );
    const file = pcbFile(project, pcb);
    if (file === null) {
      errors.push(`PCB ${uuid} 没有标题，无法定位 .epcb2`);
      continue;
    }
    const label = relativeFile(rootDir, file);
    if (!existsSync(file)) {
      errors.push(`缺少 PCB 文档 ${label}`);
      continue;
    }
    const sections = sectionsOf(file);
    if (sections === null) continue;
    if (sections.length === 0) {
      errors.push(`${label}: 文件里没有 DOCHEAD（空文件或写了一半）`);
      continue;
    }
    checkDocDupes(sections, label);
    for (const section of sections)
      checkTicketsAndRecords(section, `${label}[${section.docType ?? "?"}]`);
    checkAttrParents(sections, label);

    const main = sections[sections.length - 1];
    if (main === undefined) continue;
    check(
      main.docType === "PCB" && main.uuid === pcb.uuid,
      `${label}: 最后一个文档必须是 uuid ${pcb.uuid ?? "?"} 的 PCB，实际 ${main.docType} ${main.uuid ?? "null"}`,
    );
    const mainRecords = reducedOf(main).records;
    check(
      mainRecords.some((record) => record.type === "NET" && record.id === '["NET",""]'),
      `${label}: 主文档缺少空 NET 记录（id ["NET",""]）`,
    );
    const outlineLayers = layerIdsOfType(mainRecords, "OUTLINE");
    const hasOutline =
      mainRecords.some(
        (record) => record.type === "POLY" && record.body.polyType === "BOARD_OUTLINE",
      ) ||
      mainRecords.some(
        (record) =>
          (record.type === "POLY" || record.type === "ARC" || record.type === "LINE") &&
          typeof record.body.layerId === "number" &&
          outlineLayers.has(record.body.layerId),
      );
    check(hasOutline, `${label}: 主文档缺少板框（BOARD_OUTLINE 的 POLY，或 OUTLINE 图层上的图形）`);
    check(
      mainRecords.some((record) => record.type === "LAYER"),
      `${label}: 主文档缺少 LAYER 记录`,
    );

    const { devUuids, fpUuids } = collectTypes(sections);
    const netNames = new Set<string>();
    for (const record of mainRecords) {
      if (record.type !== "NET" || record.id === '["NET",""]') continue;
      const parts = parseJsonArray(record.id);
      const name = parts?.[1];
      if (typeof name === "string") netNames.add(name);
    }
    const compIds = new Set(
      mainRecords
        .filter((record) => record.type === "COMPONENT" && record.id !== null)
        .map((record) => record.id as string),
    );
    for (const record of mainRecords) {
      if (record.type === "COMPONENT") {
        const deviceName = parseDeviceName(record.body);
        if (deviceName.malformed) {
          check(false, `${label}: 元件 ${record.id ?? "?"} 的 DeviceName 不是合法 JSON`);
        } else if (deviceName.uuid !== null) {
          check(
            devUuids.has(deviceName.uuid),
            `${label}: 元件 ${record.id ?? "?"} 的 DeviceName uuid ${deviceName.uuid} 没有对应 DEVICE 文档`,
          );
        }
      }
      if (record.type === "ATTR" && record.body.key === "Footprint") {
        const value = record.body.value;
        if (typeof value === "string") {
          check(
            fpUuids.has(value),
            `${label}: Footprint 属性引用了不存在的 FOOTPRINT 文档 ${value}`,
          );
        }
      }
      if (record.type === "PAD_NET") {
        const parts = parseJsonArray(record.id);
        const component = parts?.[1];
        check(
          parts !== null &&
            parts[0] === "PAD_NET" &&
            typeof component === "string" &&
            compIds.has(component),
          `${label}: PAD_NET ${record.id ?? "null"} 引用了不存在的 COMPONENT ${typeof component === "string" ? component : "?"}`,
        );
        const padNet = record.body.padNet;
        if (typeof padNet === "string" && padNet !== "") {
          check(netNames.has(padNet), `${label}: PAD_NET 使用了没有 NET 记录的网名 "${padNet}"`);
        }
      }
      if (
        (record.type === "POUR" || record.type === "VIA" || record.type === "FILL") &&
        typeof record.body.netName === "string" &&
        record.body.netName !== ""
      ) {
        const netName = record.body.netName;
        check(
          netNames.has(netName),
          `${label}: ${record.type} ${record.id ?? "?"} 使用了没有 NET 记录的网名 "${netName}"`,
        );
      }
      if (record.type === "POUR" || record.type === "FILL" || record.type === "REGION") {
        const polygonPath = record.body.path;
        check(
          Array.isArray(polygonPath) &&
            polygonPath.length > 0 &&
            polygonPath.every((entry) => Array.isArray(entry)),
          `${label}: ${record.type} ${record.id ?? "?"} 的 path 必须是多边形数组的数组`,
        );
      }
    }
  }

  // ---------------------------------------------------------------- 面板
  const panelDir = path.join(rootDir, "panel");
  for (const [uuid, panel] of Object.entries(project.profile.panels)) {
    const file = panelFile(project, panel);
    check(
      file !== null && existsSync(file),
      `缺少面板 ${file === null ? uuid : relativeFile(rootDir, file)}`,
    );
  }
  if (existsSync(panelDir) && !readdirSync(panelDir).some((name) => name.endsWith(".epan2"))) {
    warnings.push(`panel 目录是空的：${relativeFile(rootDir, panelDir)}`);
  }

  // ------------------------------------------------------- 未登记文件
  for (const schematic of Object.values(project.profile.schematics)) {
    const dir = schematicDir(project, schematic);
    if (dir === null || !existsSync(dir)) continue;
    const known = new Set<string>();
    if (typeof schematic.name === "string" && schematic.name !== "") {
      known.add(`${schematic.name}.ecfg`);
      known.add(`${schematic.name}.evar`);
    }
    for (const sheet of Object.values(project.profile.sheets)) {
      if (sheet.schematic_uuid !== schematic.uuid) continue;
      if (typeof sheet.title === "string") known.add(`${sheet.title}.esch2`);
    }
    for (const name of readdirSync(dir)) {
      warn(known.has(name), `${relativeFile(rootDir, dir)}: 未登记的文件 ${name}`);
    }
  }

  // -------------------------------------------------------------- strict
  let strict: StrictValidation | undefined;
  if (options.strict === true) {
    const sampleLimit = 100;
    const result: StrictValidation = {
      checked: 0,
      skippedUnknownTypes: 0,
      errorCount: 0,
      warningCount: 0,
      errors: [],
      warnings: [],
    };
    const recordIssue = (
      file: string,
      section: DocSection,
      type: string,
      issue: ValidationIssue,
    ): StrictIssue => ({
      file: relativeFile(rootDir, file),
      docType: section.docType,
      type,
      field: issue.field,
      message: issue.message,
    });
    for (const [file, sections] of sectionsCache) {
      for (const section of sections) {
        const docType =
          section.docType !== null && isKnownDocType(section.docType) ? section.docType : undefined;
        for (const record of reducedOf(section).records) {
          result.checked += 1;
          const validation = validateLine(record.raw, docType);
          for (const issue of validation.errors) {
            if (issue.keyword === "unknown-type" || issue.keyword === "docType") {
              result.skippedUnknownTypes += 1;
              continue;
            }
            result.errorCount += 1;
            if (result.errors.length < sampleLimit) {
              result.errors.push(recordIssue(file, section, record.type, issue));
            }
          }
          for (const issue of validation.warnings) {
            if (issue.keyword === "empty-payload") continue;
            result.warningCount += 1;
            if (result.warnings.length < sampleLimit) {
              result.warnings.push(recordIssue(file, section, record.type, issue));
            }
          }
        }
      }
    }
    strict = result;
  }

  // --------------------------------------------------------------- stats
  const stats = {
    files: sectionsCache.size,
    docs: 0,
    records: 0,
    tombstones: 0,
    reducedRecords: 0,
  };
  for (const sections of sectionsCache.values()) {
    for (const section of sections) {
      stats.docs += 1;
      stats.records += section.records.length;
      stats.tombstones += section.records.filter((record) => record.tombstone).length;
      stats.reducedRecords += reducedOf(section).records.length;
    }
  }

  const ok = errors.length === 0 && (strict === undefined || strict.errorCount === 0);
  return { dir: rootDir, ok, errors, warnings, strict, stats };
}
