/**
 * 网络 → SPICE 地节点映射策略（源仓库 scripts/ground.py）。
 *
 * v2.1 用一条 `gnd\d*|ground|agnd|dgnd|0` 正则把所有"像地"的网络统统压成节点 0。
 * 对 PDN / ground impedance / ferrite bead / 0Ω ground link / star point /
 * analog-digital return 这类分析，这个隐式合并会直接制造错误结果（AGND 的返回电流
 * 被强行并进 DGND），所以改成：
 *
 *   默认只把 `GND` / `GROUND` / `0` 映射到 SPICE 节点 0；
 *   `AGND` / `DGND` / `PGND` / `CHASSIS` / `EARTH` / `VSS` 等一律保持独立节点。
 *
 * 合并必须由用户在 ground_aliases 中显式声明，且报告里逐条打印
 * "Ground mapping: XXX -> YYY"，禁止静默合并。
 */
import { asText } from "./types.ts";

export const ZERO_NODE = "0";

/** 默认自动映射（SPICE 的公共约定，不算"隐式合并"）。 */
export const DEFAULT_ZERO_NETS = ["GND", "GROUND", "0"] as const;

/** 仅用于"这条网络看起来是地"的识别（决定是否要在报告里列出/提示）。 */
const GROUND_LIKE =
  /^(0|gnd\d*|ground\d*|agnd\d*|dgnd\d*|pgnd\d*|sgnd\d*|chassis\d*|earth\d*|vss\d*|gnd_[a-z0-9_]+|.*_(gnd|agnd|dgnd)|.*gnd.*|.*ground.*|.*earth.*)$/i;

export function isGroundLike(name: unknown): boolean {
  if (name === null || name === undefined) return false;
  const text = asText(name).trim();
  if (!text) return false;
  return GROUND_LIKE.test(text);
}

export class GroundMapError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GroundMapError";
    this.code = code;
  }
}

type AliasConfig = Record<string, string | string[]> | null | undefined;

/**
 * ground_aliases 配置 → 可查询的映射表。
 *
 * 配置形态：`{"0": ["GND", "GROUND"], "AGND": ["AGND"]}`；
 * key = 目标 SPICE 节点名（"0" 表示 SPICE 全局地），value = 归并到该节点的网络名。
 * 默认映射始终生效；要完全接管加 `"_replace_defaults": true`。
 */
export class GroundMap {
  /** UPPER(net) → [target, explicit] */
  private readonly mapping = new Map<string, [string, boolean]>();
  /** 被显式合并到 0 的 ground-like 网络（报告用）。 */
  readonly explicitMerge: string[] = [];
  readonly errors: { code: string; message: string }[] = [];

  constructor(cfg: AliasConfig = null) {
    const config = (cfg ?? {}) as Record<string, unknown>;
    const replace = Boolean(config["_replace_defaults"]);
    if (!replace) {
      for (const net of DEFAULT_ZERO_NETS) this.mapping.set(net.toUpperCase(), [ZERO_NODE, false]);
    }
    for (const [target, value] of Object.entries(config)) {
      if (target.startsWith("_")) continue;
      const nets = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
      for (const item of nets) {
        const key = asText(item).trim().toUpperCase();
        if (!key) continue;
        const prev = this.mapping.get(key);
        if (prev && prev[0] !== String(target)) {
          this.errors.push({
            code: "GROUND_MAPPING_CONFLICT",
            message: `网络 ${asText(item)} 同时被映射到 ${prev[0]} 与 ${target}`,
          });
          continue;
        }
        this.mapping.set(key, [String(target), true]);
        if (isGroundLike(item) && String(target) === ZERO_NODE && !this.isDefaultZeroNet(key)) {
          this.explicitMerge.push(asText(item));
        }
      }
    }
  }

  private isDefaultZeroNet(upper: string): boolean {
    return DEFAULT_ZERO_NETS.some((net) => net.toUpperCase() === upper);
  }

  /** 返回 [目标节点 or null, explicit]。null 表示保持自己的网络名。 */
  map(name: unknown): [string | null, boolean] {
    if (name === null || name === undefined) return [null, false];
    const hit = this.mapping.get(asText(name).trim().toUpperCase());
    return hit ? [hit[0], hit[1]] : [null, false];
  }

  /** 直接给出最终节点名（未映射则返回原网络名）。 */
  node(name: unknown): unknown {
    const [target] = this.map(name);
    return target !== null ? target : name;
  }

  isZero(name: unknown): boolean {
    const [target] = this.map(name);
    if (target !== null) return String(target) === ZERO_NODE;
    return asText(name).trim() === ZERO_NODE;
  }

  isExplicitMergeToZero(name: unknown): boolean {
    const [target, explicit] = this.map(name);
    return (
      explicit &&
      String(target) === ZERO_NODE &&
      !this.isDefaultZeroNet(asText(name).trim().toUpperCase())
    );
  }

  /**
   * 对设计里实际出现的网络生成 ground mapping 段。
   * 只列出 ground-like 或被显式映射的网络。
   */
  report(netNames: readonly unknown[]): [string[], Record<string, string>] {
    const seen: string[] = [];
    for (const item of netNames) {
      if (item === null || item === undefined) continue;
      const name = asText(item).trim();
      if (!name || seen.includes(name)) continue;
      if (isGroundLike(name) || this.map(name)[0] !== null) seen.push(name);
    }
    const lines = ["Ground mapping:"];
    const mapping: Record<string, string> = {};
    if (seen.length === 0) lines.push("  (no ground-like net found)");
    for (const name of seen) {
      const target = String(this.node(name));
      mapping[name] = target;
      let tag = "";
      if (this.isExplicitMergeToZero(name)) {
        tag = "   [explicit merge, from ground_aliases]";
      } else if (
        target !== ZERO_NODE &&
        isGroundLike(name) &&
        !this.isDefaultZeroNet(name.toUpperCase())
      ) {
        tag = "   [kept isolated]";
      }
      lines.push(`  ${name}  ->  ${target}${tag}`);
    }
    return [lines, mapping];
  }

  /** 提示 ground-like 但未自动合并的网络（用户可能期望合并）。 */
  warnUnmerged(netNames: readonly unknown[]): string[] {
    const out: string[] = [];
    for (const item of netNames) {
      if (item === null || item === undefined) continue;
      const name = asText(item).trim();
      if (!name || !isGroundLike(name)) continue;
      if (this.isDefaultZeroNet(name.toUpperCase())) continue;
      if (this.map(name)[0] !== null) continue;
      out.push(name);
    }
    return out;
  }
}
