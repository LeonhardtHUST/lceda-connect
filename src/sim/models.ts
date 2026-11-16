/**
 * 外部 SPICE 模型映射（源仓库 scripts/model_resolver.py）。
 *
 * 匹配优先级（严格按此顺序）：
 *   designator override > 精确 MPN > 精确 DeviceName > alias > generic
 *
 * IC 引脚映射必须是**可验证**的，禁止"按 1,2,3,4 塞进 .SUBCKT"或按几何猜。
 * 任何 pin 缺失 / 重复 / subckt pin 数不符 / mapping 不完整，直接产出
 * `MODEL_MAPPING_ERROR`；只有显式 allow_partial_model 才降级为警告。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadJsonFile, quotePath, spiceIdent } from "./config.ts";
import type { SimIrComponent, SimError } from "./types.ts";
import { SimError as SimErrorBase, asText } from "./types.ts";

export const ROLE_VOCAB = [
  "power_input",
  "power_output",
  "signal_input",
  "signal_output",
  "digital_input",
  "digital_output",
  "analog_input",
  "analog_output",
  "open_drain_output",
  "ground",
  "passive",
] as const;

export class MappingError extends SimErrorBase {
  readonly designator?: string;
  readonly detail: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    designator?: string,
    detail?: Record<string, unknown>,
  ) {
    super(code, message);
    this.name = "MappingError";
    this.designator = designator;
    this.detail = detail ?? {};
  }
}

function up(value: unknown): string {
  return asText(value).trim().toUpperCase();
}

/** 从 lib 文本里解析 `.SUBCKT <name> pin...` 的引脚顺序。 */
export function parseSubcktPins(text: string, subckt: string): string[] | null {
  const want = up(subckt);
  const pattern = /^[ \t]*\.subckt[ \t]+(\S+)([^\n]*)/gim;
  for (const match of text.matchAll(pattern)) {
    if (up(match[1]) !== want) continue;
    let tail = (match[2] ?? "").split("$")[0]?.split(";")[0] ?? "";
    // 去掉可能出现的参数段（params: / PARAMS:）
    tail = tail.split(/\bparams?\b\s*[:=]?/i)[0] ?? "";
    return tail.trim().split(/\s+/).filter(Boolean);
  }
  return null;
}

export function parseModelNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/^[ \t]*\.model[ \t]+(\S+)/gim)) {
    names.add(up(match[1]));
  }
  return names;
}

export interface ModelMapEntry {
  key: string;
  match?: {
    designator?: string[];
    mpn?: string[];
    device?: string[];
    aliases?: string[];
    /** generics 专用。 */
    pin_prefix?: string[];
    title_contains?: string[];
  };
  type?: string;
  file?: string;
  subckt?: string;
  model?: string;
  card?: string;
  pins?: Record<string, string>;
  subckt_order?: string[];
  node_order?: string[];
  roles?: Record<string, string>;
  nc_pins?: string[];
  lib_section?: string;
  device_letter?: string;
  mpn?: string;
  [key: string]: unknown;
}

export interface ModelResolution {
  designator: string;
  key: string | undefined;
  matched_by: string | null;
  type: string;
  roles: Record<string, string>;
  pin_mapping: Record<string, string>;
  pin_mapping_auto?: boolean;
  nodes: string[];
  status: "VERIFIED" | "PARTIAL";
  fallback: "no" | "yes";
  file: string | null;
  file_display: string | null;
  subckt: string | undefined;
  model?: string;
  card?: string;
  device_letter?: string;
  derivation: string[];
  subckt_order?: string[];
  nc_nodes?: { pin: string; node: string }[];
  include?: string;
  mpn?: string;
  [key: string]: unknown;
}

type NodeLookup = (comp: SimIrComponent, pin: string | null) => string | null;

function numKey(value: string): [number, number | string] {
  return /^\d+$/.test(value) ? [0, Number.parseInt(value, 10)] : [1, value];
}

function compareNumKey(a: string, b: string): number {
  const [ka, va] = numKey(a);
  const [kb, vb] = numKey(b);
  if (ka !== kb) return ka - kb;
  if (ka === 0) return Number(va) - Number(vb);
  return String(va) < String(vb) ? -1 : String(va) > String(vb) ? 1 : 0;
}

export interface ModelResolverOptions {
  allowPartial?: boolean;
  strict?: boolean;
  /** deck 输出目录：决定 .include 用相对路径还是绝对路径。 */
  deckDir?: string | null;
}

export class ModelResolver {
  readonly path: string | null;
  readonly baseDir: string;
  readonly allowPartial: boolean;
  readonly strict: boolean;
  readonly entries = new Map<string, ModelMapEntry>();
  generics: ModelMapEntry[] = [];
  readonly errors: SimError[] = [];
  readonly warnings: string[] = [];
  deckDir: string | null;
  private readonly byDes = new Map<string, string>();
  private readonly byMpn = new Map<string, string>();
  private readonly byDevice = new Map<string, string>();
  private readonly byAlias = new Map<string, string>();
  private readonly fileCache = new Map<string, string | null>();
  private readonly includes: { key: string; line: string }[] = [];

  constructor(mapPath?: string | null, options: ModelResolverOptions = {}) {
    this.path = mapPath ? path.resolve(mapPath) : null;
    this.baseDir = this.path ? path.dirname(this.path) : process.cwd();
    this.allowPartial = Boolean(options.allowPartial);
    this.strict = Boolean(options.strict);
    this.deckDir = options.deckDir ?? null;
    if (mapPath && existsSync(mapPath)) {
      this.load(mapPath);
    } else if (mapPath) {
      this.errors.push(new SimErrorBase("MODEL_MAP_MISSING", `model_map 文件不存在: ${mapPath}`));
    }
  }

  private load(mapPath: string): void {
    const config = loadJsonFile<{
      parts?: Record<string, ModelMapEntry>;
      generics?: ModelMapEntry[];
    }>(mapPath);
    for (const [key, raw] of Object.entries(config.parts ?? {})) {
      const entry: ModelMapEntry = Object.assign({}, raw, { key }) as ModelMapEntry;
      this.entries.set(key, entry);
      const match = entry.match ?? {};
      for (const designator of match.designator ?? []) {
        this.byDes.set(up(designator), key);
      }
      for (const mpn of [...(match.mpn ?? []), key]) {
        if (!this.byMpn.has(up(mpn))) this.byMpn.set(up(mpn), key);
      }
      for (const device of match.device ?? []) {
        if (!this.byDevice.has(up(device))) this.byDevice.set(up(device), key);
      }
      for (const alias of match.aliases ?? []) {
        if (!this.byAlias.has(up(alias))) this.byAlias.set(up(alias), key);
      }
    }
    this.generics = config.generics ?? [];
  }

  private readFile(file: string): string | null {
    const absolute = path.resolve(file);
    if (!this.fileCache.has(absolute)) {
      let text: string | null = null;
      try {
        text = readFileSync(absolute, "utf8");
      } catch {
        text = null;
      }
      this.fileCache.set(absolute, text);
    }
    return this.fileCache.get(absolute) ?? null;
  }

  private absoluteFile(rel: string | null | undefined): string | null {
    if (!rel) return null;
    if (path.isAbsolute(rel)) return path.normalize(rel);
    return path.normalize(path.join(this.baseDir, rel));
  }

  /** 返回 [entry, matchedBy] 或 [null, null]。 */
  match(comp: SimIrComponent): [ModelMapEntry | null, string | null] {
    const designator = up(comp.designator);
    if (designator && this.byDes.has(designator)) {
      return [this.entries.get(this.byDes.get(designator)!) ?? null, "designator"];
    }
    const mpn = up(comp.manufacturerPart);
    if (mpn && this.byMpn.has(mpn)) {
      return [this.entries.get(this.byMpn.get(mpn)!) ?? null, "mpn"];
    }
    const device = up(comp.deviceTitle);
    if (device && this.byDevice.has(device)) {
      return [this.entries.get(this.byDevice.get(device)!) ?? null, "device"];
    }
    for (const candidate of [mpn, device, up(comp.name)]) {
      if (candidate && this.byAlias.has(candidate)) {
        return [this.entries.get(this.byAlias.get(candidate)!) ?? null, "alias"];
      }
    }
    const generic = this.matchGeneric(comp);
    if (generic) return [generic, "generic"];
    return [null, null];
  }

  private matchGeneric(comp: SimIrComponent): ModelMapEntry | null {
    const prefix = up(comp.pinPrefix);
    const haystack = up(comp.deviceTitle) + " " + up(comp.manufacturerPart);
    for (const generic of this.generics) {
      const match = generic.match ?? {};
      if (match.pin_prefix && !(match.pin_prefix as unknown as string[]).map(up).includes(prefix)) {
        continue;
      }
      const patterns = (match.title_contains as string[] | undefined) ?? [];
      if (patterns.length > 0 && !patterns.some((pattern) => haystack.includes(up(pattern)))) {
        continue;
      }
      if (Object.keys(match).length === 0) continue;
      return generic;
    }
    return null;
  }

  /** 把元件解析成一条可落地的实例描述；失败抛 MappingError。 */
  resolve(comp: SimIrComponent, nodeLookup: NodeLookup): ModelResolution | null {
    const designator = comp.designator || "?";
    const [entry, matchedBy] = this.match(comp);
    if (!entry) return null;
    const type = String(entry.type ?? "subckt").toLowerCase();
    const result: ModelResolution = {
      designator,
      key: entry.key,
      matched_by: matchedBy,
      type: type.toUpperCase(),
      roles: {},
      pin_mapping: {},
      nodes: [],
      status: "VERIFIED",
      fallback: "no",
      file: null,
      file_display: null,
      subckt: entry.subckt ?? entry.key,
      derivation: [],
    };
    if (entry.mpn) result.mpn = entry.mpn;
    if (type === "subckt" || type === "x") {
      this.resolveSubckt(comp, entry, result, nodeLookup);
    } else if (type === "model" || type === "card") {
      this.resolveCard(comp, entry, result, nodeLookup);
    } else if (type === "include_only") {
      this.registerInclude(entry, result);
    } else {
      throw new MappingError(
        "MODEL_MAPPING_ERROR",
        `${designator}: 未知 model type ${JSON.stringify(type)}`,
        designator,
      );
    }
    return result;
  }

  private resolveSubckt(
    comp: SimIrComponent,
    entry: ModelMapEntry,
    result: ModelResolution,
    nodeLookup: NodeLookup,
  ): void {
    const designator = result.designator;
    const subckt = entry.subckt ?? entry.key;
    const rel = entry.file;
    if (!rel) {
      throw new MappingError(
        "MODEL_MAPPING_ERROR",
        `${designator}: subckt 类型缺少 file 字段`,
        designator,
      );
    }
    const filePath = this.absoluteFile(rel);
    const text = filePath ? this.readFile(filePath) : null;
    if (!filePath || text === null) {
      this.errors.push(
        new SimErrorBase(
          "MODEL_FILE_MISSING",
          `${designator}: 模型文件不存在 ${rel} (${filePath ?? ""})`,
        ),
      );
      throw new MappingError(
        "MODEL_FILE_MISSING",
        `${designator}: 模型文件不存在 ${rel}`,
        designator,
      );
    }
    result.file = filePath;
    result.file_display = rel.replace(/\\/g, "/");

    const filePins = parseSubcktPins(text, subckt ?? "");
    if (filePins === null) {
      throw new MappingError(
        "MODEL_MAPPING_ERROR",
        `${designator}: 文件 ${rel} 中找不到 .SUBCKT ${subckt ?? ""}`,
        designator,
      );
    }
    const configuredOrder = entry.subckt_order;
    if (configuredOrder && configuredOrder.length > 0) {
      const sameOrder = configuredOrder.map(up).join("\u0000") === filePins.map(up).join("\u0000");
      if (!sameOrder) {
        const sameSet =
          [...configuredOrder].map(up).sort().join("\u0000") ===
          [...filePins].map(up).sort().join("\u0000");
        if (!sameSet) {
          throw new MappingError(
            "MODEL_MAPPING_ERROR",
            `${designator}: subckt_order 与文件里的 .SUBCKT ${subckt ?? ""} 引脚集合不一致` +
              `（配置 [${configuredOrder.join(", ")}] / 文件 [${filePins.join(", ")}]）`,
            designator,
          );
        }
        this.warnings.push(
          `${designator}: subckt_order 与文件引脚顺序不同，按文件顺序 ` +
            `[${filePins.join(", ")}] 生成 X 行（位置映射以文件为准）`,
        );
      }
    }
    const order = filePins;
    result.subckt_order = order;

    let pins = entry.pins ?? null;
    let autoByName = false;
    if (!pins || Object.keys(pins).length === 0) {
      const auto = this.autopinByName(comp, order);
      if (auto === null) {
        throw new MappingError(
          "MODEL_MAPPING_ERROR",
          `${designator}: 未提供 pins 映射，且原理图引脚名与 .SUBCKT ${subckt ?? ""} 引脚名` +
            `无法一一对应（原理图脚名 [${comp.pins.map((pin) => pin.name ?? "").join(", ")}]）`,
          designator,
        );
      }
      pins = auto[0];
      autoByName = true;
    }
    const pinMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(pins)) pinMap[String(key)] = String(value);

    // ---- 校验 ----
    const compPins = new Map<string, string | null>();
    for (const pin of comp.pins) compPins.set(String(pin.number), pin.number);
    const covered = new Set(Object.values(pinMap));
    const unknown = [...covered].filter((pin) => !order.includes(pin));
    if (unknown.length > 0) {
      throw new MappingError(
        "MODEL_MAPPING_ERROR",
        `${designator}: pins 映射到 .SUBCKT ${subckt ?? ""} 不存在的引脚 ` +
          `[${unknown.join(", ")}]（subckt 引脚 [${order.join(", ")}]）`,
        designator,
      );
    }
    const bySub = new Map<string, string[]>();
    for (const [number, subPin] of Object.entries(pinMap)) {
      const list = bySub.get(subPin) ?? [];
      list.push(number);
      bySub.set(subPin, list);
    }
    for (const [subPin, numbers] of bySub) {
      if (numbers.length <= 1) continue;
      const nodes = new Set<string>();
      for (const number of numbers) {
        const node = nodeLookup(comp, number);
        if (node !== null) nodes.add(node);
      }
      if (nodes.size > 1) {
        throw new MappingError(
          "MODEL_MAPPING_ERROR",
          `${designator}: .SUBCKT ${subckt ?? ""} 引脚 ${subPin} 被多个原理图引脚 ` +
            `[${numbers.join(", ")}] 映射，但它们不在同一网络（[${[...nodes].sort().join(", ")}]）`,
          designator,
        );
      }
    }

    const connected = [...compPins.keys()].filter((number) => nodeLookup(comp, number) !== null);
    const missing = connected.filter((number) => !(number in pinMap)).sort(compareNumKey);
    if (missing.length > 0) {
      this.incomplete(
        designator,
        `原理图引脚 [${missing.join(", ")}] 没有 pin mapping（.SUBCKT ${subckt ?? ""} 引脚 ` +
          `[${order.join(", ")}]）`,
      );
    }

    const ncPins = new Set(((entry.nc_pins as string[] | undefined) ?? []).map(up));
    const unmappedRequired = order.filter((pin) => !covered.has(pin) && !ncPins.has(up(pin)));
    if (unmappedRequired.length > 0) {
      this.incomplete(
        designator,
        `.SUBCKT ${subckt ?? ""} 引脚 [${unmappedRequired.join(", ")}] 没有对应原理图引脚` +
          "（如确为开路请加入 nc_pins）",
      );
    }

    // ---- 组装节点序列 ----
    let dummyCount = 0;
    for (const subPin of order) {
      const numbers = bySub.get(subPin) ?? [];
      const nodes = numbers
        .map((number) => nodeLookup(comp, number))
        .filter((node) => Boolean(node));
      if (nodes.length > 0) {
        result.nodes.push(nodes[0] as string);
      } else {
        const dummy = `__NC_${spiceIdent(designator)}_${dummyCount}`;
        dummyCount += 1;
        result.nodes.push(dummy);
        result.nc_nodes = [...(result.nc_nodes ?? []), { pin: subPin, node: dummy }];
      }
    }
    const sortedPins: Record<string, string> = {};
    for (const number of Object.keys(pinMap).sort(compareNumKey)) {
      sortedPins[number] = pinMap[number]!;
    }
    result.pin_mapping = sortedPins;
    result.pin_mapping_auto = autoByName;
    result.status = missing.length > 0 || unmappedRequired.length > 0 ? "PARTIAL" : "VERIFIED";
    if (result.status === "PARTIAL") result.fallback = "yes";
    result.roles = this.buildRoles(pinMap, entry, order);
    this.registerInclude(entry, result);
  }

  /** 不给 pins 时按引脚名自动匹配（名字对得上才算，不做几何/顺序猜测）。 */
  private autopinByName(
    comp: SimIrComponent,
    order: readonly string[],
  ): [Record<string, string>, true] | null {
    const names = new Map<string, string[]>();
    for (const pin of comp.pins) {
      const name = up(pin.name);
      if (!name) continue;
      const list = names.get(name) ?? [];
      list.push(String(pin.number));
      names.set(name, list);
    }
    const mapping: Record<string, string> = {};
    for (const subPin of order) {
      const hits = names.get(up(subPin));
      if (!hits) return null;
      for (const number of hits) mapping[number] = subPin;
    }
    return Object.keys(mapping).length > 0 ? [mapping, true] : null;
  }

  private buildRoles(
    pins: Record<string, string>,
    entry: ModelMapEntry,
    order: readonly string[],
  ): Record<string, string> {
    const configured = new Map<string, string>();
    for (const [key, value] of Object.entries(entry.roles ?? {})) configured.set(up(key), value);
    const roles: Record<string, string> = {};
    for (const subPin of order) {
      const role = configured.get(up(subPin));
      if (!role) continue;
      if (!(ROLE_VOCAB as readonly string[]).includes(role)) {
        this.warnings.push(
          `未知 pin role ${JSON.stringify(role)}（pin ${subPin}），按 signal_input 处理`,
        );
      }
      roles[subPin] = role;
    }
    for (const [number, subPin] of Object.entries(pins)) {
      const role = configured.get(up(number));
      if (role && !(subPin in roles)) roles[subPin] = role;
    }
    return roles;
  }

  private resolveCard(
    comp: SimIrComponent,
    entry: ModelMapEntry,
    result: ModelResolution,
    nodeLookup: NodeLookup,
  ): void {
    const designator = result.designator;
    const model = entry.model ?? entry.subckt ?? entry.key;
    const card = entry.card;
    const rel = entry.file;
    if (!card && rel) {
      const filePath = this.absoluteFile(rel);
      const text = filePath ? this.readFile(filePath) : null;
      if (!filePath || text === null) {
        throw new MappingError(
          "MODEL_FILE_MISSING",
          `${designator}: 模型文件不存在 ${rel}`,
          designator,
        );
      }
      result.file = filePath;
      result.file_display = rel.replace(/\\/g, "/");
      if (!parseModelNames(text).has(up(model))) {
        throw new MappingError(
          "MODEL_MAPPING_ERROR",
          `${designator}: 文件 ${rel} 中找不到 .MODEL ${model ?? ""}`,
          designator,
        );
      }
      this.registerInclude(entry, result);
    } else if (card) {
      result.card = card;
    } else {
      throw new MappingError(
        "MODEL_MAPPING_ERROR",
        `${designator}: model 类型需要 card 或 file`,
        designator,
      );
    }
    result.model = model;
    result.device_letter = entry.device_letter;
    const pins = entry.pins ?? {};
    const nodeOrder = entry.node_order ?? [];
    const nodes: (string | null)[] = [];
    if (nodeOrder.length > 0) {
      for (const role of nodeOrder) {
        const numbers = Object.entries(pins)
          .filter(([, value]) => up(value) === up(role))
          .map(([number]) => number);
        if (numbers.length === 0) {
          throw new MappingError(
            "MODEL_MAPPING_ERROR",
            `${designator}: node_order 里的 ${role} 没有 pin mapping`,
            designator,
          );
        }
        nodes.push(nodeLookup(comp, numbers[0]!));
      }
    } else {
      for (const number of Object.keys(pins).sort(compareNumKey)) {
        nodes.push(nodeLookup(comp, number));
      }
    }
    if (nodes.length === 0 || nodes.some((node) => node === null)) {
      this.incomplete(designator, "model 类型器件存在悬空引脚，无法实例化");
      result.status = "PARTIAL";
    }
    result.nodes = nodes.map((node) => node ?? `__NC_${spiceIdent(designator)}`);
    result.pin_mapping = Object.fromEntries(
      Object.entries(pins).map(([key, value]) => [String(key), String(value)]),
    );
  }

  private incomplete(designator: string, message: string): void {
    if (this.allowPartial) {
      this.warnings.push(`${designator}: ${message}（allow_partial_model 已降级为警告）`);
      return;
    }
    throw new MappingError("MODEL_MAPPING_ERROR", `${designator}: ${message}`, designator);
  }

  private registerInclude(entry: ModelMapEntry, result: ModelResolution): void {
    const rel = entry.file;
    if (!rel) return;
    const filePath = this.absoluteFile(rel);
    if (!filePath) return;
    const section = entry.lib_section;
    const normalized = process.platform === "win32" ? filePath.toLowerCase() : filePath;
    const key = `${normalized}|${up(section)}`;
    const existing = this.includes.find((item) => item.key === key);
    if (existing) {
      result.include = existing.line;
      return;
    }
    const line = section
      ? `.lib ${quotePath(filePath, this.deckDir)} ${section}`
      : `.include ${quotePath(filePath, this.deckDir)}`;
    this.includes.push({ key, line });
    result.include = line;
  }

  includeLines(): string[] {
    return this.includes.map((item) => item.line);
  }
}

/** 报告里的模型 provenance 段。 */
export function provenanceText(result: ModelResolution | null | undefined): string[] {
  if (!result) return [];
  const out = [`${result.designator} ${result.mpn ?? result.key ?? ""}`.trim()];
  if (result.file_display) {
    out.push(`model source: ${result.file_display}`);
  } else if (result.card) {
    out.push("model source: inline card");
  }
  out.push(`model type: ${result.type}`);
  if (result.subckt) out.push(`subckt: ${result.subckt}`);
  if (Object.keys(result.pin_mapping).length > 0) {
    const how = result.pin_mapping_auto ? " (by pin name)" : "";
    out.push(`pin mapping: ${result.status}${how}`);
  }
  out.push(`fallback: ${result.fallback}`);
  return out;
}
