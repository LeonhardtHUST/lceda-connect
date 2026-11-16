/** 库表构建：SYMBOL（符号 + 引脚）、DEVICE（器件 + 属性）、FOOTPRINT（封装 + 焊盘）。 */
import type { ParsedDoc } from "./contract.ts";
import { docElements, docsOf, isPlainRecord } from "./records.ts";
import { scalarText } from "./text.ts";

/**
 * 坐标约定（实测）：
 * - 符号引脚坐标 (x, y) 是连接端的本地坐标，不是画布中心；
 * - 文件里的 rotation 与 EDA 显示值不同向，变换时取 -rotation；
 * - 文件里的 y 是 EDA 显示坐标的负值，最终 y 要取负；
 * - 变换顺序固定为：旋转 → 镜像 → 平移，顺序反了引脚会左右颠倒。
 */
export const Y_SIGN = -1.0;
export const ROT_SIGN = -1.0;

export interface SymbolPin {
  x: number;
  y: number;
  rotation: number;
  length: number;
  number: string | null;
  name: string | null;
}

export interface SymbolDoc {
  title: string;
  docType: unknown;
  pins: Map<string, SymbolPin>;
  globalNetName: string | null;
}

export interface DeviceDoc {
  title: string;
  attributes: Record<string, unknown>;
}

export interface FootprintPad {
  num: string | null;
  x: number;
  y: number;
  layer_id: number;
  w: number;
  h: number;
}

export interface FootprintDoc {
  pads: FootprintPad[];
  title: string;
}

export interface Placement {
  x: number | null;
  y: number | null;
  rotation: number | null;
  mirror: boolean;
}

export function num(...candidates: unknown[]): number {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return null;
  return scalarText(value).trim();
}

function valueOrZero(value: unknown): number {
  return value ? num(value) : 0;
}

/** {uuid: {pins{pid: {...}}, globalNetName, title, docType}} */
export function buildSymbols(docs: readonly ParsedDoc[]): Map<string, SymbolDoc> {
  const symbols = new Map<string, SymbolDoc>();
  for (const doc of docsOf(docs, "SYMBOL")) {
    const { byType, meta } = docElements(doc);
    const pins = new Map<string, SymbolPin>();
    for (const [pid, payload] of byType.get("PIN") ?? []) {
      if (!isPlainRecord(payload)) continue;
      pins.set(pid, {
        x: valueOrZero(payload.x),
        y: valueOrZero(payload.y),
        rotation: valueOrZero(payload.rotation),
        length: valueOrZero(payload.length),
        number: null,
        name: null,
      });
    }
    let globalNet: string | null = null;
    for (const [, attr] of byType.get("ATTR") ?? []) {
      if (!isPlainRecord(attr)) continue;
      const parent = attr.parentId;
      const key = attr.key;
      const parentKey = scalarText(parent);
      if (parent && pins.has(parentKey)) {
        const pin = pins.get(parentKey);
        if (!pin) continue;
        if (key === "Pin Number") pin.number = text(attr.value);
        else if (key === "Pin Name") pin.name = text(attr.value);
      } else if (!parent && key === "Global Net Name") {
        globalNet = text(attr.value);
      }
    }
    symbols.set(doc.uuid ?? "", {
      title: typeof meta.title === "string" ? meta.title : text(meta.title) || "",
      docType: meta.docType ?? null,
      pins,
      globalNetName: globalNet,
    });
  }
  return symbols;
}

/** {uuid: {title, attributes{}}} */
export function buildDevices(docs: readonly ParsedDoc[]): Map<string, DeviceDoc> {
  const devices = new Map<string, DeviceDoc>();
  for (const doc of docsOf(docs, "DEVICE")) {
    const { meta } = docElements(doc);
    if (Object.keys(meta).length === 0) continue;
    devices.set(doc.uuid ?? "", {
      title: typeof meta.title === "string" ? meta.title : text(meta.title) || "",
      attributes: isPlainRecord(meta.attributes) ? meta.attributes : {},
    });
  }
  return devices;
}

/**
 * {uuid: {pads[{num, x, y, layer_id, w, h}], title}}，坐标为封装本地坐标。
 *
 * layer_id 是封装内焊盘所在层（12 = MULTI，通孔焊盘）；消费方拿不到层的时候
 * 要回退到元件所在层，不能一律当成顶层。
 */
export function buildFootprints(docs: readonly ParsedDoc[]): Map<string, FootprintDoc> {
  const footprints = new Map<string, FootprintDoc>();
  for (const doc of docsOf(docs, "FOOTPRINT")) {
    const { byType, meta } = docElements(doc);
    const pads: FootprintPad[] = [];
    for (const [, pad] of byType.get("PAD") ?? []) {
      if (!isPlainRecord(pad)) continue;
      const defaultPad = isPlainRecord(pad.defaultPad) ? pad.defaultPad : {};
      const layerValue = num(pad.layerId) || 12;
      pads.push({
        num: text(pad.num || pad.number || pad.padNumber),
        x: num(pad.centerX, pad.x),
        y: num(pad.centerY, pad.y),
        layer_id: Math.trunc(layerValue),
        w: num(defaultPad.width),
        h: num(defaultPad.height),
      });
    }
    footprints.set(doc.uuid ?? "", {
      pads,
      title: typeof meta.title === "string" ? meta.title : text(meta.title) || "",
    });
  }
  return footprints;
}

/**
 * 符号本地坐标 → 元件绝对坐标（文件坐标系，y 尚未取负）。
 *
 * `component` 需要是 placementOf() 归一后的摆放字典。直接传原始 COMPONENT 记录
 * 也能跑，但记录的镜像字段叫 isMirror，这里读的是 mirror，不归一就会静默丢掉镜像。
 */
export function transformPin(
  px: number,
  py: number,
  component: Placement,
): { x: number; y: number } {
  const theta = ((component.rotation ?? 0) * ROT_SIGN * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  let x = px * cosT - py * sinT;
  const y = px * sinT + py * cosT;
  if (component.mirror) x = -x;
  return { x: x + (component.x ?? 0), y: y + (component.y ?? 0) };
}

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * COMPONENT 记录 → 摆放字典，只做字段名归一，不改数值。
 *
 * 记录里是 isMirror，变换函数按约定读 mirror。两个名字都认，缺省按未镜像处理。
 */
export function placementOf(record: unknown): Placement {
  if (!isPlainRecord(record)) {
    return { x: 0, y: 0, rotation: 0, mirror: false };
  }
  const mirror = record.isMirror ?? record.mirror;
  return {
    x: numericOrNull(record.x),
    y: numericOrNull(record.y),
    rotation: numericOrNull(record.rotation),
    mirror: Boolean(mirror),
  };
}

/** part / netflag / netport / sheet。 */
export function componentType(symbol?: SymbolDoc | null, device?: DeviceDoc | null): string {
  const docType = symbol?.docType;
  const title = `${symbol?.title ?? ""} ${device?.title ?? ""}`;
  if (docType === 18 || title.includes("NetFlag") || title.includes("网络标识")) {
    return "netflag";
  }
  if (docType === 19 || title.includes("NetPort") || title.includes("网络端口")) {
    return "netport";
  }
  if (docType === 20 || title.includes("Drawing-Symbol") || title.includes("Sheet")) {
    return "sheet";
  }
  return "part";
}

/** COMPONENT.attrs.DeviceName 是 JSON 字符串，里面才有真正的器件 uuid。 */
export function deviceUuidOf(
  inlineAttrs: Record<string, unknown> | null | undefined,
  mergedAttrs: Record<string, unknown> | null | undefined,
): string | null {
  const raw = inlineAttrs?.DeviceName;
  let parsed: unknown = null;
  if (typeof raw === "string" && raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  } else if (isPlainRecord(raw)) {
    parsed = raw;
  }
  if (isPlainRecord(parsed)) {
    const uuid = parsed.uuid;
    if (uuid) return scalarText(uuid);
  }
  const device = mergedAttrs?.Device;
  return device ? scalarText(device) : null;
}

/** Name 字段若是具体值（如 100nF、4.7k）就当 Value 兜底；公式类以 = 开头则忽略。 */
export function valueLike(value: unknown): string | null {
  if (!value) return null;
  const s = scalarText(value).trim();
  if (!s || s.startsWith("=")) return null;
  const first = s[0] ?? "";
  return /^[0-9.]$/.test(first) ? s : null;
}
