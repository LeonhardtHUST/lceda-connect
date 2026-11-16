/**
 * 网表生成器：IR + 网络归组 → ngspice 网表 + 结构化报告
 * （源仓库 scripts/netlist_gen.py 的核心；override / behavioral / IBIS 已在
 * 源仓库中属规则密集模块，本端口不包含，相应分支直接走"排除"路径）。
 *
 * 分类规则（优先级序）：
 *   1. R/C/L（2 脚）        直接按 Value 出实例
 *   2. Q/D/M               查离散模型库 → 泛化兜底
 *   3. 电压源器件           按属性直出，并登记为已驱动网络
 *   4. U/IC/X               → 外部 .SUBCKT/.MODEL（model_map）
 *                           → 排除（strict 下直接报 UNMAPPED_IC）
 *   5. Power 网标自动补源   受 power_policy 约束
 */
import path from "node:path";

import { GroundMap } from "./ground.ts";
import { MappingError, ModelResolver, type ModelResolution } from "./models.ts";
import { parseEng } from "./parasitics.ts";
import {
  Namer,
  SKILL_VERSION,
  loadJsonFile,
  simModelsDir,
  spiceIdent,
  spiceNode,
} from "./config.ts";
import type {
  FidelityTable,
  NetlistReport,
  NetlistReportError,
  PinNetTable,
  SimConfig,
  SimIr,
  SimIrComponent,
} from "./types.ts";
import { asText } from "./types.ts";

const VOLT_RE = /^[+-]?(\d+)(?:[Vv](\d+))?[Vv]?$/;
const IC_PREFIXES = ["U", "IC", "X"];
/** 明确"不是 IC"的前缀（连接器 / 排针 / 保险丝 / 开关 ...）。 */
const NON_IC_PREFIXES = new Set([
  "R",
  "C",
  "L",
  "D",
  "LED",
  "Q",
  "M",
  "Q_NMOS",
  "Q_PMOS",
  "V",
  "I",
  "H",
  "J",
  "P",
  "K",
  "CN",
  "SW",
  "TP",
  "F",
  "FB",
  "BT",
  "KEY",
  "S",
  "JP",
  "CON",
  "XH",
  "PH",
  "PZ",
  "ANT",
  "MH",
]);

export interface DiscretePart {
  type?: string;
  pins?: Record<string, string>;
  aliases?: string[];
  card?: string;
  [key: string]: unknown;
}

export interface DiscreteLibrary {
  version?: number;
  parts: Record<string, DiscretePart>;
  [key: string]: unknown;
}

export interface GenericLibrary {
  version?: number;
  generic: Record<string, { modelName: string; card: string }>;
  valueDefaults?: Record<string, { value?: string; warn?: string }>;
  [key: string]: unknown;
}

export interface ModelLibrary {
  discrete: DiscreteLibrary;
  generic: GenericLibrary;
  /** UPPER(alias 或型号) → 离散库零件名。 */
  aliasMap: Map<string, string>;
  dir: string;
}

const libraryCache = new Map<string, ModelLibrary>();

/** 读取 discrete.json / generic.json 并建别名表（同目录缓存，避免每次生成都读盘）。 */
export function loadModelLibrary(modelsDir: string = simModelsDir()): ModelLibrary {
  const cached = libraryCache.get(modelsDir);
  if (cached) return cached;
  const discrete = loadJsonFile<DiscreteLibrary>(path.join(modelsDir, "discrete.json"));
  const generic = loadJsonFile<GenericLibrary>(path.join(modelsDir, "generic.json"));
  const aliasMap = new Map<string, string>();
  for (const [name, part] of Object.entries(discrete.parts ?? {})) {
    for (const alias of [...(part.aliases ?? []), name]) {
      aliasMap.set(String(alias).toUpperCase(), name);
    }
  }
  const library: ModelLibrary = { discrete, generic, aliasMap, dir: modelsDir };
  libraryCache.set(modelsDir, library);
  return library;
}

/** 器件位号 → SPICE 安全名（保留旧调用方行为）。 */
export function sanitizeDes(des: unknown, used?: Set<string>): string {
  let text = spiceIdent(des, "X");
  if (used) {
    const base = text;
    let index = 2;
    while (used.has(text)) {
      text = `${base}_${index}`;
      index += 1;
    }
    used.add(text);
  }
  return text;
}

/** 从网络名解析电压值：+12V→12，-15V→-15，5V→5，3V3→3.3。 */
export function parseVoltage(netname: unknown): number | null {
  if (netname === null || netname === undefined) return null;
  const text = asText(netname).trim();
  const negative = text.startsWith("-");
  const match = VOLT_RE.exec(text);
  if (!match) return null;
  const whole = match[1] ?? "0";
  const decimal = match[2];
  const value = Number.parseFloat(decimal ? `${whole}.${decimal}` : whole);
  if (!(value > 0) || value > 1000) return null;
  return negative ? -value : value;
}

/** 从位号推出字母前缀（IR 缺 pinPrefix 时的兜底，与 ir_common.normalize 一致）。 */
export function designatorPrefix(designator: string | null | undefined): string {
  const match = /^[A-Za-z]+/.exec((designator ?? "").trim());
  return match ? match[0] : "";
}

export interface NetlistOptions {
  config?: Partial<SimConfig> | null;
  strict?: boolean;
  keepOpen?: boolean;
  powerPolicy?: string | null;
  /** model_map.json 路径；不给则 cfg.models 或空（不解析厂商模型）。 */
  models?: string | null;
  allowPartialModel?: boolean;
  deckDir?: string | null;
  /** 覆盖模型库目录（测试用）。 */
  modelsDir?: string | null;
}

export interface NetlistResult {
  text: string;
  report: NetlistReport;
}

type NodeLookup = (comp: SimIrComponent, pin: string | null) => string | null;

/** 从 IR 的 nets 成员表反建位号 → 引脚 → 网络名（netlist_gen.py 的 pin_net）。 */
export function buildPinNetTable(ir: SimIr): PinNetTable {
  const table: PinNetTable = {};
  for (const net of ir.nets ?? []) {
    for (const member of net.members ?? []) {
      if (!member?.component) continue;
      const pins = (table[member.component] ??= {});
      pins[String(member.pin)] = net.name;
    }
  }
  return table;
}

export class NetlistBuilder {
  private readonly ir: SimIr;
  private readonly pinNet: PinNetTable;
  private readonly cfg: Record<string, unknown>;
  private readonly strict: boolean;
  private readonly keepOpen: boolean;
  private readonly powerPolicy: string;
  private readonly ground: GroundMap;
  private readonly namer = new Namer();
  private readonly library: ModelLibrary;
  private readonly resolver: ModelResolver;
  private readonly report: NetlistReport;
  private readonly lines: string[] = [];
  private readonly modelCards = new Map<string, string>();
  private readonly sourcedNodes = new Map<string, string[]>();
  private readonly powerOutputNodes = new Map<string, string[]>();
  private readonly netOwner = new Map<string, Set<string>>();
  private readonly fidelity: { designator: string; level: number; what: string }[] = [];

  constructor(ir: SimIr, pinNet: PinNetTable | null | undefined, options: NetlistOptions = {}) {
    this.ir = ir;
    if (!this.ir.components) this.ir.components = [];
    if (!this.ir.nets) this.ir.nets = [];
    this.pinNet = pinNet ?? buildPinNetTable(ir);
    this.cfg = (options.config ?? {}) as Record<string, unknown>;
    this.strict = Boolean(options.strict ?? this.cfg["strict"]);
    this.keepOpen = Boolean(options.keepOpen);
    const policy = asText(options.powerPolicy ?? this.cfg["power_policy"] ?? "auto").toLowerCase();
    if (policy !== "auto" && policy !== "explicit") {
      throw new Error(`power_policy 只支持 auto|explicit，收到 ${policy}`);
    }
    this.powerPolicy = policy;
    this.ground = new GroundMap(
      (this.cfg["ground_aliases"] as Record<string, string | string[]> | null) ?? null,
    );
    this.library = loadModelLibrary(options.modelsDir ?? simModelsDir());
    this.resolver = new ModelResolver(
      options.models ?? (this.cfg["models"] as string | null) ?? null,
      {
        allowPartial: Boolean(options.allowPartialModel ?? this.cfg["allow_partial_model"]),
        strict: this.strict,
        deckDir: options.deckDir ?? null,
      },
    );
    this.report = {
      version: SKILL_VERSION,
      included: [],
      excluded: [],
      generic: [],
      powers: [],
      dangling_nets: [],
      warnings: [],
      errors: [],
      models: [],
      behavioral: [],
      ibis: [],
      overrides: [],
      ground_mapping: {},
      net_segments: [],
      virtual_nodes: [],
      power_policy: this.powerPolicy,
      strict: this.strict,
      fidelity: { blocks: {}, overall_level: 0 },
      includes: [],
    };
  }

  // ---------------------------------------------------------------- 工具
  net(comp: SimIrComponent, pin: string | null): string | null {
    const raw = this.rawNet(comp, pin);
    if (raw === undefined) return null;
    return this.nodeForNet(raw);
  }

  private rawNet(comp: SimIrComponent, pin: string | null): string | undefined {
    const designator = comp.designator ?? "";
    const pins = this.pinNet[designator];
    if (!pins || pin === null) return undefined;
    return pins[String(pin)];
  }

  private nodeForNet(raw: unknown): string {
    const mapped = this.ground.node(raw);
    const node = spiceNode(mapped);
    return node ?? "N_unnamed";
  }

  private error(code: string, message: string, extra: Record<string, unknown> = {}): void {
    const entry: NetlistReportError = { code, message, ...extra };
    this.report.errors.push(entry);
  }

  private warn(message: string): void {
    this.report.warnings.push(message);
  }

  private twoPinNets(
    comp: SimIrComponent,
  ): [string | null, string | null, string | null, string | null] | null {
    const pins = comp.pins ?? [];
    if (pins.length !== 2) return null;
    const first = pins[0]?.number ?? null;
    const second = pins[1]?.number ?? null;
    return [this.net(comp, first), this.net(comp, second), first, second];
  }

  private noteNet(raw: string | undefined, node: string | null): void {
    if (raw === undefined || node === null) return;
    const owners = this.netOwner.get(node) ?? new Set<string>();
    owners.add(String(raw));
    this.netOwner.set(node, owners);
  }

  private finishNetCheck(): void {
    for (const [node, owners] of this.netOwner) {
      if (node === "0") continue;
      if (owners.size > 1) {
        this.warn(
          `不同网络名被压到同一 SPICE 节点 ${node}: [${[...owners].sort().join(", ")}]` +
            "（请检查 ground_aliases 或网络命名）",
        );
      }
    }
  }

  // ---------------------------------------------------------------- 主流程
  build(): NetlistResult {
    for (const comp of this.ir.components ?? []) {
      if (comp.componentType !== "part") continue;
      this.emitComponent(comp);
    }
    this.autoPower();
    this.danglingNets();
    this.finishNetCheck();
    this.finalizeReport();
    return { text: this.assemble(), report: this.report };
  }

  private emitComponent(comp: SimIrComponent): void {
    const designator = comp.designator ?? "";
    const prefix = (comp.pinPrefix || designatorPrefix(designator)).toUpperCase();
    const title = comp.deviceTitle ?? "";
    const mpn = comp.manufacturerPart ?? "";

    // 电压源
    if (
      prefix === "V" ||
      title.includes("电压源") ||
      title.toUpperCase().includes("VOLTAGE SOURCE")
    ) {
      this.emitSource(comp);
      return;
    }
    // IC / 模块：显式 U/IC/X，或"未知前缀 + 2 脚以上"（DA1/MCU1 这类中文工程常见位号）
    if (
      IC_PREFIXES.includes(prefix) ||
      prefix.startsWith("IC") ||
      (!NON_IC_PREFIXES.has(prefix) && (comp.pins ?? []).length >= 2)
    ) {
      this.emitIc(comp);
      return;
    }

    let kind: string | null = null;
    if (prefix === "R" || prefix === "C" || prefix === "L") kind = prefix;
    else if (prefix === "D" || prefix === "LED") kind = "D";
    else if (prefix === "Q") kind = "Q";
    else if (prefix === "M" || prefix === "Q_NMOS" || prefix === "Q_PMOS") kind = "M";

    if (kind === "R" || kind === "C" || kind === "L") this.emitPassive(comp, kind);
    else if (kind === "Q") this.emitBjt(comp);
    else if (kind === "D") this.emitDiode(comp);
    else if (kind === "M") this.emitMosfet(comp);
    else this.exclude(comp, `无仿真模型（${mpn || title || "未知型号"}），已排除`);
  }

  // ---- 无源 ----
  private emitPassive(comp: SimIrComponent, kind: string): void {
    const designator = comp.designator ?? "";
    const nets = this.twoPinNets(comp);
    if (!nets) {
      this.warn(`${designator}: ${kind} 引脚数不是 2，跳过`);
      return;
    }
    const [na, nb, pinA, pinB] = nets;
    this.noteNet(this.rawNet(comp, pinA), na);
    this.noteNet(this.rawNet(comp, pinB), nb);
    if (na === null || nb === null) {
      this.warn(`${designator}: 存在悬空引脚（无网络），已跳过该器件`);
      return;
    }
    let value = comp.value;
    if (!value) {
      const defaults = this.library.generic.valueDefaults?.[kind]?.value;
      value = defaults ?? { R: "1k", C: "100n", L: "1m" }[kind];
      this.warn(`${designator}: 无 Value，按 ${value} 兜底`);
    }
    // 0Ω 电阻：ngspice 只 clamp 到 1e-12 并告警，1µΩ 会 tran 不收敛，统一 1mΩ。
    if (kind === "R" && isZeroOhm(value)) {
      value = "1m";
      this.warn(`${designator}: 0Ω 电阻按 1mΩ 处理（ngspice 不接受零阻值，1µΩ 会不收敛）`);
    }
    this.lines.push(`${this.namer.take(designator)} ${na} ${nb} ${value}`);
    this.report.included.push({ designator, as: kind, level: "Level 0" });
    this.fidelity.push({ designator, level: 0, what: kind });
  }

  // ---- 电压源 ----
  private emitSource(comp: SimIrComponent): void {
    const designator = comp.designator ?? "";
    const nets = this.twoPinNets(comp);
    if (!nets) {
      this.warn(`${designator}: 电压源引脚数异常，跳过`);
      return;
    }
    const [na, nb] = nets;
    if (na === null || nb === null) {
      this.warn(`${designator}: 电压源存在悬空引脚，跳过`);
      return;
    }
    let voltage = comp.value;
    for (const [key, value] of Object.entries(comp.attrs ?? {})) {
      if (key.toLowerCase().includes("voltage") && value) voltage = asText(value);
    }
    const title = comp.deviceTitle ?? "";
    const name = this.namer.take(designator);
    let description: string;
    if (title.toUpperCase().includes("AC") || title.includes("正弦")) {
      this.lines.push(`${name} ${na} ${nb} SIN(0 10mV 1k) AC 1 0`);
      description = "AC_SOURCE";
    } else {
      this.lines.push(`${name} ${na} ${nb} DC ${voltage || "5V"} AC 0 0`);
      description = "V";
    }
    for (const node of [na, nb]) {
      const list = this.sourcedNodes.get(node) ?? [];
      list.push(`${designator}(schematic)`);
      this.sourcedNodes.set(node, list);
    }
    this.report.included.push({ designator, as: description, level: "Level 0" });
    this.report.powers.push({
      net: na,
      node: na,
      voltage,
      source: "schematic",
      element: name,
    });
  }

  // ---- BJT ----
  private emitBjt(comp: SimIrComponent): void {
    const designator = comp.designator ?? "";
    const title = comp.deviceTitle ?? "";
    const mpn = comp.manufacturerPart ?? "";
    let modelName: string | null = null;
    let modelPins: Record<string, string> | undefined;
    let card: string | undefined;
    for (const key of [mpn, title]) {
      if (!key) continue;
      const hit = this.library.aliasMap.get(String(key).toUpperCase());
      if (!hit) continue;
      const part = this.library.discrete.parts[hit];
      if (!part) continue;
      modelName = hit;
      modelPins = part.pins;
      card = part.card;
      break;
    }
    if (!modelName) {
      const isPnp =
        `${title}${mpn}`.toUpperCase().includes("PNP") ||
        ["9012", "9015", "8550"].some((part) => mpn.includes(part));
      const generic = this.library.generic.generic[isPnp ? "PNP" : "NPN"];
      if (!generic) {
        this.exclude(comp, "缺少泛化 BJT 模型");
        return;
      }
      modelName = generic.modelName;
      card = generic.card;
      modelPins = undefined;
      this.report.generic.push({
        designator,
        model: modelName,
        why: `未在库中匹配 ${mpn || title}`,
      });
    }
    const rolePins = this.resolveBjtPins(comp, modelPins);
    if (!rolePins) return;
    const nc = this.net(comp, rolePins["C"] ?? null);
    const nb = this.net(comp, rolePins["B"] ?? null);
    const ne = this.net(comp, rolePins["E"] ?? null);
    if (nc === null || nb === null || ne === null) {
      this.warn(`${designator}: 存在悬空引脚，已跳过该器件`);
      return;
    }
    this.lines.push(`${this.namer.take(designator)} ${nc} ${nb} ${ne} ${modelName}`);
    if (card) this.modelCards.set(modelName, card);
    this.report.included.push({ designator, as: "Q", model: modelName, level: "Level 0" });
    this.fidelity.push({ designator, level: 0, what: "BJT" });
  }

  private resolveBjtPins(
    comp: SimIrComponent,
    modelPins: Record<string, string> | undefined,
  ): Record<string, string | null> | null {
    const designator = comp.designator ?? "";
    const pins = comp.pins ?? [];
    if (pins.length < 3) return null;
    const byName = (roles: string[]): SimIrComponent["pins"][number] | null => {
      for (const pin of pins) {
        const name = (pin.name ?? "").toUpperCase();
        for (const role of roles) {
          if (name.includes(role)) return pin;
        }
      }
      return null;
    };
    const got = {
      C: byName(["C", "COLLECTOR", "集电极"]),
      B: byName(["B", "BASE", "基极"]),
      E: byName(["E", "EMITTER", "发射极"]),
    };
    if (got.C && got.B && got.E) {
      return { C: got.C.number, B: got.B.number, E: got.E.number };
    }
    if (modelPins && ["C", "B", "E"].every((key) => key in modelPins)) {
      return { ...modelPins };
    }
    const numbers = pins.filter((pin) => pin.number !== null).map((pin) => String(pin.number));
    if (numbers.length === 3 && [...numbers].sort().join(",") === "1,2,3") {
      this.warn(`${designator}: 无引脚名/模型映射，按惯序 1=B 2=E 3=C 处理（请核对）`);
      return { B: "1", E: "2", C: "3" };
    }
    this.warn(`${designator}: 无法确定 C/B/E 引脚，已跳过`);
    return null;
  }

  // ---- 二极管 ----
  private emitDiode(comp: SimIrComponent): void {
    const designator = comp.designator ?? "";
    const nets = this.twoPinNets(comp);
    if (!nets) {
      this.warn(`${designator}: 二极管引脚数异常，跳过`);
      return;
    }
    const [na, nb] = nets;
    if (na === null || nb === null) {
      this.warn(`${designator}: 存在悬空引脚，已跳过该器件`);
      return;
    }
    const title = comp.deviceTitle ?? "";
    const mpn = comp.manufacturerPart ?? "";
    const hit =
      this.library.aliasMap.get((mpn || "").toUpperCase()) ??
      this.library.aliasMap.get((title || "").toUpperCase());
    let modelName: string;
    let card: string | undefined;
    if (hit) {
      const part = this.library.discrete.parts[hit];
      modelName = hit;
      card = part?.card;
    } else {
      const generic =
        this.library.generic.generic[title.toUpperCase().includes("LED") ? "LED" : "D"];
      if (!generic) {
        this.exclude(comp, "缺少泛化二极管模型");
        return;
      }
      modelName = generic.modelName;
      card = generic.card;
      this.report.generic.push({
        designator,
        model: modelName,
        why: `未在库中匹配 ${mpn || title}`,
      });
    }
    this.lines.push(`${this.namer.take(designator)} ${na} ${nb} ${modelName}`);
    if (card) this.modelCards.set(modelName, card);
    this.report.included.push({ designator, as: "D", model: modelName, level: "Level 0" });
    this.fidelity.push({ designator, level: 0, what: "diode" });
  }

  // ---- MOSFET ----
  private emitMosfet(comp: SimIrComponent): void {
    const designator = comp.designator ?? "";
    const title = comp.deviceTitle ?? "";
    const mpn = comp.manufacturerPart ?? "";
    const pins = comp.pins ?? [];
    const role: Record<string, string | null> = {};
    for (const pin of pins) {
      const name = (pin.name ?? "").toUpperCase();
      for (const candidate of ["G", "D", "S"]) {
        if (name.includes(candidate) && !(candidate in role)) role[candidate] = pin.number;
      }
    }
    if (
      Object.keys(role).length < 3 &&
      pins.length === 3 &&
      pins.every((pin) => ["1", "2", "3"].includes(String(pin.number)))
    ) {
      role["G"] = "1";
      role["S"] = "2";
      role["D"] = "3";
      this.warn(`${designator}: MOSFET 按惯序 1=G 2=S 3=D 处理（请核对）`);
    }
    if (Object.keys(role).length < 3) {
      this.exclude(comp, "MOSFET 引脚无法确定");
      return;
    }
    const ng = this.net(comp, role["G"] ?? null);
    const nd = this.net(comp, role["D"] ?? null);
    const ns = this.net(comp, role["S"] ?? null);
    if (ng === null || nd === null || ns === null) {
      this.warn(`${designator}: 存在悬空引脚，已跳过该器件`);
      return;
    }
    const isPmos = `${title}${mpn}`.toUpperCase().includes("PMOS") || title.includes("P沟道");
    const generic = this.library.generic.generic[isPmos ? "PMOS" : "NMOS"];
    if (!generic) {
      this.exclude(comp, "缺少泛化 MOSFET 模型");
      return;
    }
    this.lines.push(`${this.namer.take(designator)} ${nd} ${ng} ${ns} 0 ${generic.modelName}`);
    this.modelCards.set(generic.modelName, generic.card);
    this.report.generic.push({
      designator,
      model: generic.modelName,
      why: "MOSFET 泛化模型",
    });
    this.report.included.push({
      designator,
      as: "M",
      model: generic.modelName,
      level: "Level 0",
    });
    this.fidelity.push({ designator, level: 0, what: "MOSFET" });
  }

  // ---- IC / 模块 ----
  private emitIc(comp: SimIrComponent): void {
    const designator = comp.designator ?? "";
    const title = comp.deviceTitle ?? "";
    const mpn = comp.manufacturerPart ?? "";
    let resolved: ModelResolution | null = null;
    try {
      resolved = this.resolver.resolve(comp, this.nodeLookup);
    } catch (error) {
      if (!(error instanceof MappingError)) throw error;
      this.error(error.code, error.message, { designator: error.designator ?? designator });
      this.exclude(comp, `模型映射失败（${error.code}）`);
      return;
    }
    if (resolved) {
      const nodes = resolved.nodes.map((node) => node || "0");
      let instance = "";
      if (resolved.type === "SUBCKT") {
        // 子电路实例必须以 X 开头；直接叫 U1 会被 ngspice 当成 URC 传输线。
        instance = this.namer.take("X" + spiceIdent(designator));
        this.lines.push(`${instance} ${nodes.join(" ")} ${resolved.subckt ?? ""}`.trimEnd());
        this.registerPowerOutputs(resolved, nodes);
      } else if (resolved.type === "MODEL" || resolved.type === "CARD") {
        const letter = (resolved.device_letter ?? "").trim();
        if (!letter) {
          this.error(
            "MODEL_MAPPING_ERROR",
            `${designator}: model 类型器件必须在 model_map 里给出 device_letter` +
              "（如 Q/M/D/J），否则没法把 .MODEL 实例化成正确器件类型",
            { designator },
          );
          this.exclude(comp, "model 类型缺少 device_letter");
          return;
        }
        instance = this.namer.take(letter[0]!.toUpperCase() + spiceIdent(designator));
        this.lines.push(`${instance} ${nodes.join(" ")} ${resolved.model ?? ""}`.trimEnd());
        if (resolved.card) this.modelCards.set(resolved.model ?? "", resolved.card);
      }
      resolved["instance"] = instance;
      this.report.models.push(resolved as unknown as Record<string, unknown>);
      this.report.included.push({
        designator,
        as: resolved.type,
        model: resolved.subckt ?? resolved.model,
        level: "Level 2",
        pin_mapping: resolved.status,
      });
      this.fidelity.push({
        designator,
        level: 2,
        what: resolved.subckt ?? resolved.model ?? "vendor model",
      });
      return;
    }

    const reason = `无仿真模型（${mpn || title || "未知型号"}），已排除`;
    const connected = (comp.pins ?? []).filter((pin) => this.net(comp, pin.number) !== null).length;
    if (this.strict && connected >= 2) {
      this.error(
        "UNMAPPED_IC",
        `${designator}（${mpn || title}）位于有效电流路径（${connected} 个已连接引脚）` +
          "但没有可用模型：请在 model_map 里配置外部 .SUBCKT" +
          "（行为级占位在源仓库属 sidecar 脚本，本端口未移植）",
        { designator },
      );
    }
    this.exclude(comp, reason);
  }

  /** 绑定给 ModelResolver 的节点查询（保持 this 指向）。 */
  private readonly nodeLookup: NodeLookup = (comp, pin) => this.net(comp, pin);

  private registerPowerOutputs(resolved: ModelResolution, nodes: string[]): void {
    const roles = resolved.roles ?? {};
    const order = resolved.subckt_order ?? [];
    for (let index = 0; index < order.length; index += 1) {
      const subPin = order[index]!;
      if (roles[subPin] !== "power_output" || index >= nodes.length) continue;
      const node = nodes[index]!;
      const list = this.powerOutputNodes.get(node) ?? [];
      list.push(resolved.designator);
      this.powerOutputNodes.set(node, list);
      const sourced = this.sourcedNodes.get(node) ?? [];
      sourced.push(`${resolved.designator}(power_output)`);
      this.sourcedNodes.set(node, sourced);
    }
  }

  private exclude(comp: SimIrComponent, reason: string): void {
    const designator = comp.designator ?? "";
    if (this.keepOpen) {
      this.lines.push(`* [skipped] ${spiceIdent(designator)} ${comp.deviceTitle ?? ""}`);
    }
    this.report.excluded.push({
      designator,
      title: comp.deviceTitle,
      mpn: comp.manufacturerPart,
      reason,
      level: "EXCLUDED",
    });
  }

  // ---- 电源 ----
  private autoPower(): void {
    const explicitSupplies =
      (this.cfg["external_supplies"] as Record<string, unknown>[] | undefined) ?? [];
    for (const supply of explicitSupplies) {
      const net = supply["net"] ?? supply["node"];
      const voltage = supply["voltage"] ?? supply["v"];
      if (net === null || net === undefined || voltage === null || voltage === undefined) {
        this.error(
          "POWER_DECL_INVALID",
          `external_supplies 条目缺 net/voltage: ${JSON.stringify(supply)}`,
        );
        continue;
      }
      const node = this.nodeForNet(net);
      const name = this.namer.call("V", `EXT_${spiceIdent(asText(net))}`);
      this.lines.push(
        `* external supply declared in config: ${asText(net)} = ${asText(voltage)} V`,
      );
      this.lines.push(`${name} ${node} 0 DC ${asText(voltage)} AC 0 0`);
      const sourced = this.sourcedNodes.get(node) ?? [];
      sourced.push(`${asText(net)}(config)`);
      this.sourcedNodes.set(node, sourced);
      this.report.powers.push({ net: node, voltage, source: "config", element: name });
    }

    // 重复理想源冲突检测
    for (const [node, sources] of this.sourcedNodes) {
      const ideal = sources.filter(
        (source) => source.includes("(schematic)") || source.includes("(config)"),
      );
      if (ideal.length > 1) {
        const message = `节点 ${node} 上有多个独立电压源: [${ideal.join(", ")}]`;
        if (this.strict) this.error("DUPLICATE_VOLTAGE_SOURCE", message);
        else this.warn(message);
      }
      const outputs = this.powerOutputNodes.get(node);
      if (outputs && outputs.length > 0 && ideal.length > 0) {
        const message =
          `节点 ${node} 由 ${outputs.join(", ")} 的 power_output 引脚驱动，` +
          `同时又被理想电压源 [${ideal.join(", ")}] 驱动`;
        if (this.strict) this.error("POWER_OUTPUT_CONFLICT", message);
        else this.warn(message);
      }
    }

    const powerNets = (this.ir.nets ?? []).filter((net) => net.origin === "netflag");
    if (this.powerPolicy === "explicit") {
      for (const net of powerNets) {
        const name = net.name;
        if (parseVoltage(name) === null) continue;
        const node = this.nodeForNet(name);
        if (this.sourcedNodes.has(node) || node === "0") continue;
        const message =
          `${name} 是电源网标但没有任何真实供电（power_policy=explicit）：` +
          "请在原理图里加真实电压源，或在 config 的 external_supplies 中声明";
        if (this.strict) this.error("ISOLATED_RAIL", message, { net: name });
        else this.warn(message);
      }
      return;
    }

    // ---- auto（v2.1 兼容行为）----
    let added = 0;
    for (const net of powerNets) {
      const name = String(net.name);
      const voltage = parseVoltage(name);
      if (voltage === null) continue;
      const node = this.nodeForNet(name);
      if (node === "0") continue;
      const outputs = this.powerOutputNodes.get(node);
      if (outputs && outputs.length > 0) {
        this.warn(
          `${name} 已由 ${outputs.join(", ")} 的 power_output 驱动，跳过自动补源` +
            "（这一点在 v2.1 会被错误地再并一个理想源）",
        );
        continue;
      }
      if (this.sourcedNodes.has(node)) continue;
      // 保持 v2.1 的命名习惯：+12V → VPWR_12V，-15V → VPWR_NEG_15V
      const base = name.replace(/^[+-]/, "").replace(/[^0-9A-Za-z_]/g, "_") || "RAIL";
      const device = this.namer.take((name.startsWith("-") ? "VPWR_NEG_" : "VPWR_") + base);
      this.lines.push(`${device} ${node} 0 ${formatVoltage(voltage)} DC AC 0 0`);
      this.report.powers.push({
        net: name,
        node,
        voltage,
        source: "auto",
        element: device,
      });
      const sourced = this.sourcedNodes.get(node) ?? [];
      sourced.push(`${name}(auto)`);
      this.sourcedNodes.set(node, sourced);
      added += 1;
    }
    if (added > 0) {
      this.warn(
        `[POWER-AUTO] ${added} 个电源网标按网名自动补了理想电压源。` +
          "这对 buck/LDO/PDN 分析会掩盖真实电源动态，复杂板卡请改用 " +
          "power_policy=explicit（或 config 里 power_policy: explicit）",
      );
    }
  }

  // ---- 悬空网络 ----
  private danglingNets(): void {
    for (const net of this.ir.nets ?? []) {
      if (net.pinCount === 1 && net.origin === "auto") {
        const member = net.members?.[0];
        if (member) {
          this.report.dangling_nets.push(`${net.name} 仅连接 ${member.component}.${member.pin}`);
        }
      }
    }
    const headerLike = this.report.excluded.filter((entry) => {
      const designator = asText(entry["designator"]);
      const head = designator.slice(0, 2).toUpperCase();
      return (
        head.startsWith("H") ||
        head.startsWith("SW") ||
        head.startsWith("JP") ||
        asText(entry["mpn"]).includes("PZ2.54") ||
        asText(entry["mpn"]).toUpperCase().includes("HEADER")
      );
    });
    if (headerLike.length > 0) {
      this.warn(
        `检测到 ${headerLike.length} 个跳线/排针（` +
          `${headerLike.map((entry) => String(entry["designator"])).join(", ")}）位于信号路径中，` +
          "网表按『未插跳线』状态生成；需要闭合请用 override 的 short/insert",
      );
    }
  }

  // ---- 报告收尾 ----
  private finalizeReport(): void {
    const netNames = (this.ir.nets ?? []).map((net) => net.name);
    const [groundLines, groundMapping] = this.ground.report(netNames);
    this.report.ground_mapping = groundMapping;
    this.report.ground_lines = groundLines;
    for (const net of this.ground.warnUnmerged(netNames)) {
      this.warn(
        `ground-like 网络 ${net} 未合并到节点 0（v2.2 默认不静默合并）；` +
          "如需合并请在 config 的 ground_aliases 里显式声明",
      );
    }
    if (this.ground.errors.length > 0) this.report.errors.push(...this.ground.errors);
    this.report.ground_link_found = this.groundLinked(groundMapping);
    this.report.includes = this.resolver.includeLines();
    this.report.errors.push(
      ...this.resolver.errors.map((error) => ({ code: error.code, message: error.message })),
    );
    this.report.warnings.push(...this.resolver.warnings);
    this.report.fidelity = this.fidelityTable();
    this.report.counts = {
      included: this.report.included.length,
      excluded: this.report.excluded.length,
      models: this.report.models.length,
      behavioral: this.report.behavioral.length,
      overrides: this.report.overrides.length,
      power_sources: this.report.powers.length,
    };
  }

  /** ground-like 之间是否已有真实连接（override 的 0Ω / ferrite / short）。 */
  private groundLinked(groundMapping: Record<string, string>): boolean {
    if (Object.keys(groundMapping).length <= 1) return true;
    const grounds = new Set(Object.values(groundMapping).filter((target) => target !== "0"));
    if (grounds.size === 0) return true;
    // 本端口未移植 override，所以没有可用的 short/ferrite 连接。
    return false;
  }

  private fidelityTable(): FidelityTable {
    const labels = (this.cfg["fidelity_labels"] as Record<string, string> | undefined) ?? {};
    const blocks: FidelityTable["blocks"] = {};
    for (const row of this.fidelity) {
      const key = labels[row.designator] ?? `${row.designator} (${row.what})`;
      blocks[key] = { level: row.level, what: row.what, designator: row.designator };
    }
    const overall = Object.values(blocks).reduce((max, row) => Math.max(max, row.level), 0);
    return { blocks, overall_level: overall };
  }

  // ---- 组装 ----
  private assemble(): string {
    const project = this.ir.project ?? "-";
    const page = (this.ir.page as Record<string, unknown> | undefined)?.["name"] ?? "-";
    const head = [
      `* NGspice netlist generated by easyeda-ngspice-sim v${SKILL_VERSION}`,
      `* project: ${asText(project)}  page: ${asText(page)}  source: ${asText(this.ir.source)}`,
      `* power-policy: ${this.powerPolicy}  strict: ${this.strict ? 1 : 0}  ` +
        `fidelity: Level ${this.report.fidelity.overall_level}`,
    ];
    for (const line of this.report.ground_lines ?? []) head.push("* " + line);
    const groundMapping = this.report.ground_mapping;
    if (Object.keys(groundMapping).length > 1 && !this.report.ground_link_found) {
      head.push("* 注意：多个 ground-like 网络保持独立节点，它们之间没有任何连接时 PDN 结果不可信");
    }
    if (this.report.excluded.length > 0) {
      head.push(
        `* WARNING: ${this.report.excluded.length} 个器件未进入仿真: ` +
          this.report.excluded.map((entry) => String(entry["designator"])).join(", "),
      );
    }
    if (this.report.generic.length > 0) {
      head.push(
        "* WARNING: 使用泛化模型: " +
          this.report.generic
            .map((entry) => `${String(entry["designator"])}→${String(entry["model"])}`)
            .join(", "),
      );
    }
    for (const node of this.report.virtual_nodes) {
      head.push(`* virtual node: ${node.replace("__", "$")}  (deck 写法 ${node})`);
    }

    const parts: string[] = [head.join("\n")];
    if (this.report.includes.length > 0) {
      parts.push("* ---- model includes ----");
      parts.push(...this.report.includes);
    }
    parts.push(this.lines.join("\n"));
    if (this.modelCards.size > 0) {
      parts.push("* ---- models ----");
      parts.push(...[...this.modelCards.values()].filter(Boolean));
    }
    return parts.filter((part) => part).join("\n") + "\n.end\n";
  }
}

/** 生成网表与报告。 */
export function generateNetlist(
  ir: SimIr,
  pinNet?: PinNetTable | null,
  options: NetlistOptions = {},
): NetlistResult {
  return new NetlistBuilder(ir, pinNet, options).build();
}

/** 电压值 → SPICE 文本（12 → "12"，3.3 → "3.3"）。 */
function formatVoltage(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}

/** 值是不是 0Ω（解析失败的非数值写法一律当"不是"）。 */
function isZeroOhm(value: unknown): boolean {
  try {
    return parseEng(value, "r") === 0;
  } catch {
    return false;
  }
}
