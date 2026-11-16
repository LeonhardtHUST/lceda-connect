import { readAssetJson } from "../core/assets.ts";

/**
 * capability-map 台账（源仓库 `references/capability-map.json`）。
 *
 * 台账是路由与知识检索的单一来源：`exec.ts` 按 `routes[].priority` 决定先走哪条
 * 通道，`lookup` 供人和 Agent 查某个动词的入口、失败信号与实测记录。查不到就返回
 * 空结果，不按相似度编造条目。
 */

export const CAPABILITY_MAP_ASSET = [
  "skills",
  "easyeda-connect",
  "references",
  "capability-map.json",
] as const;

export interface CapabilityRoute {
  priority?: number;
  /** `bridge` / `cdp` / `offline` / `cli`；null 表示降级声明。 */
  channel?: string | null;
  entry?: string;
  fail?: unknown;
  degrade?: string;
  [key: string]: unknown;
}

export interface CapabilityMenuPath {
  path?: string;
  source?: string;
  [key: string]: unknown;
}

export interface CapabilityVerb {
  id: string;
  capability?: string;
  intent?: string;
  status?: string;
  routes?: CapabilityRoute[];
  menu_paths?: CapabilityMenuPath[];
  dialogs?: string[];
  verify?: string;
  verification?: string;
  note?: string;
  [key: string]: unknown;
}

export interface CapabilityMap {
  schema_version?: string;
  purpose?: string;
  channels?: Record<string, unknown>;
  priority_rules?: Array<Record<string, unknown>>;
  failure_signals?: Record<string, unknown>;
  probe_cache_seconds?: number;
  verbs: CapabilityVerb[];
}

export class CapabilityMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityMapError";
  }
}

let cached: CapabilityMap | undefined;

/** 读取并校验台账；缺文件或结构不对时给出可操作的错误。 */
export function loadCapabilityMap(options: { fresh?: boolean } = {}): CapabilityMap {
  if (!options.fresh && cached) return cached;
  let raw: unknown;
  try {
    raw = readAssetJson<unknown>(...CAPABILITY_MAP_ASSET);
  } catch (error) {
    throw new CapabilityMapError(
      `读不到动词台账 assets/${CAPABILITY_MAP_ASSET.join("/")}：` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CapabilityMapError("动词台账不是 JSON 对象");
  }
  const map = raw as CapabilityMap;
  if (!Array.isArray(map.verbs)) {
    throw new CapabilityMapError("动词台账缺少 verbs 数组");
  }
  for (const verb of map.verbs) {
    if (verb === null || typeof verb !== "object" || typeof verb.id !== "string") {
      throw new CapabilityMapError("动词台账里有缺少 id 的条目");
    }
  }
  cached = map;
  return map;
}

/** 按 id 精确取动词定义；没有返回 null（不模糊匹配）。 */
export function findVerb(id: string): CapabilityVerb | null {
  return loadCapabilityMap().verbs.find((verb) => verb.id === id) ?? null;
}

/** 取排序后的路由；台账里没有这个动词时抛错（调用方据此报「未实现」）。 */
export function routesOf(id: string): CapabilityRoute[] {
  const verb = findVerb(id);
  if (!verb) {
    throw new CapabilityMapError(`路由表里没有动词：${id}`);
  }
  return [...(verb.routes ?? [])].sort(
    (left, right) => (left.priority ?? 99) - (right.priority ?? 99),
  );
}

export interface CapabilityHit {
  id: string;
  capability: string | null;
  intent: string | null;
  status: string | null;
  routes: Array<{ priority: number | null; channel: string | null; entry: string | null }>;
  menu_paths: string[];
  score: number;
}

export interface CapabilityLookupResult {
  query: string;
  total: number;
  hits: CapabilityHit[];
  hint?: string;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function haystackOf(verb: CapabilityVerb): string {
  const parts: string[] = [
    verb.id,
    textOf(verb.capability),
    textOf(verb.intent),
    textOf(verb.status),
    textOf(verb.verify),
    textOf(verb.verification),
    textOf(verb.note),
  ];
  for (const route of verb.routes ?? []) {
    parts.push(textOf(route.channel), textOf(route.entry), textOf(route.degrade));
    if (Array.isArray(route.fail)) {
      for (const item of route.fail) parts.push(textOf(item));
    }
  }
  for (const menu of verb.menu_paths ?? []) parts.push(textOf(menu.path), textOf(menu.source));
  for (const dialog of verb.dialogs ?? []) parts.push(textOf(dialog));
  return parts.join("\n").toLowerCase();
}

function scoreOf(verb: CapabilityVerb, query: string, tokens: readonly string[]): number {
  const id = verb.id.toLowerCase();
  const intent = textOf(verb.intent).toLowerCase();
  const capability = textOf(verb.capability).toLowerCase();
  let score = 0;
  if (id === query) score += 1000;
  else if (id.includes(query)) score += 600;
  if (capability === query) score += 300;
  else if (capability.includes(query)) score += 150;
  if (intent.includes(query)) score += 120;
  for (const token of tokens) {
    if (id === token) score += 400;
    else if (id.includes(token)) score += 200;
    if (intent.includes(token)) score += 40;
    if (capability.includes(token)) score += 30;
  }
  return score;
}

function toHit(verb: CapabilityVerb, score: number): CapabilityHit {
  return {
    id: verb.id,
    capability: verb.capability ?? null,
    intent: verb.intent ?? null,
    status: verb.status ?? null,
    routes: (verb.routes ?? []).map((route) => ({
      priority: typeof route.priority === "number" ? route.priority : null,
      channel: typeof route.channel === "string" ? route.channel : null,
      entry: route.entry ?? null,
    })),
    menu_paths: (verb.menu_paths ?? [])
      .map((menu) => textOf(menu.path))
      .filter((path) => path !== ""),
    score,
  };
}

/**
 * 检索动词台账。多个词按 AND 匹配，先按打分降序再按 id 排序；零命中返回空数组。
 */
export function lookupCapability(
  query: string,
  options: { limit?: number } = {},
): CapabilityLookupResult {
  const text = query.trim();
  const limit = Math.max(1, Math.min(50, options.limit ?? 10));
  if (text === "") {
    return {
      query,
      total: 0,
      hits: [],
      hint: "给一个动词名或意图关键词，例如 read_board_state、DRC、自动布线。",
    };
  }
  const lowered = text.toLowerCase();
  const tokens = lowered.split(/\s+/).filter(Boolean);
  const map = loadCapabilityMap();
  const matched: Array<{ verb: CapabilityVerb; score: number }> = [];
  const seen = new Set<string>();
  for (const verb of map.verbs) {
    if (seen.has(verb.id)) continue;
    const haystack = haystackOf(verb);
    if (!tokens.every((token) => haystack.includes(token))) continue;
    seen.add(verb.id);
    matched.push({ verb, score: scoreOf(verb, lowered, tokens) });
  }
  matched.sort(
    (left, right) => right.score - left.score || left.verb.id.localeCompare(right.verb.id),
  );
  const hits = matched.slice(0, limit).map(({ verb, score }) => toHit(verb, score));
  const result: CapabilityLookupResult = { query: text, total: matched.length, hits };
  if (matched.length === 0) {
    result.hint = `台账里没有匹配「${text}」的动词。换一个词，或用已知 id 精确查询。`;
  }
  return result;
}

/** 只读摘要：台账规模与 schema 版本（给 status / 测试用）。 */
export function capabilitySummary(): {
  schemaVersion: string | null;
  verbCount: number;
  capabilityCount: number;
} {
  const map = loadCapabilityMap();
  const capabilities = new Set(
    map.verbs.map((verb) => verb.capability).filter((value): value is string => Boolean(value)),
  );
  return {
    schemaVersion: map.schema_version ?? null,
    verbCount: map.verbs.length,
    capabilityCount: capabilities.size,
  };
}
