import { apiDocsTools, availableApiDocsTools } from "../apidocs/mcpTools.ts";
import { bridgeTools } from "../bridge/mcpTools.ts";
import { cdpTools } from "../cdp/mcpTools.ts";
import { edaTools } from "../eda/mcpTools.ts";
import { epro2Tools } from "../epro2/mcpTools.ts";
import { eprj3Tools } from "../eprj3/mcpTools.ts";
import { formatTools } from "../format/mcpTools.ts";
import { simTools } from "../sim/mcpTools.ts";
import { coreTools } from "./coreTools.ts";
import type { ToolDef } from "./types.ts";

export type ToolsetSelection = string | readonly string[];

const DOMAIN_GROUPS: Readonly<Record<string, readonly ToolDef[]>> = {
  cdp: cdpTools,
  bridge: bridgeTools,
  eda: edaTools,
  api: apiDocsTools,
  apidocs: apiDocsTools,
  format: formatTools,
  epro2: epro2Tools,
  eprj3: eprj3Tools,
  sim: simTools,
};

const OFFLINE = new Set(["api", "format", "epro2", "eprj3", "sim"]);
const LIVE = new Set(["cdp", "bridge", "eda"]);
const CANONICAL_DOMAINS = [
  "cdp",
  "bridge",
  "eda",
  "api",
  "format",
  "epro2",
  "eprj3",
  "sim",
] as const;

function selectionItems(selection: ToolsetSelection | undefined): string[] {
  if (selection === undefined) return [];
  const items =
    typeof selection === "string"
      ? selection.split(",")
      : selection.flatMap((item) => item.split(","));
  return items.map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);
}

export function normalizeToolsetSelection(
  selection: ToolsetSelection | undefined,
): Set<string> | undefined {
  const items = selectionItems(selection);
  if (items.length === 0) return undefined;
  const selected = new Set<string>(["core"]);
  for (const item of items) {
    if (item === "all") return undefined;
    if (item === "offline") {
      for (const domain of OFFLINE) selected.add(domain);
      continue;
    }
    if (item === "live") {
      for (const domain of LIVE) selected.add(domain);
      continue;
    }
    if (item === "api") {
      selected.add("api");
      continue;
    }
    if (item === "apidocs") {
      selected.add("api");
      continue;
    }
    if (item === "core" || CANONICAL_DOMAINS.includes(item as (typeof CANONICAL_DOMAINS)[number])) {
      selected.add(item);
      continue;
    }
    throw new Error(`未知 MCP toolset：${item}`);
  }
  return selected;
}

function tagTools(tools: readonly ToolDef[], toolset: string): ToolDef[] {
  return tools.map((tool) => ({ ...tool, toolset: tool.toolset ?? toolset }));
}

/**
 * 返回所有（或按选择过滤的）MCP 工具。core 始终包含；选择支持
 * `offline`/`live` 聚合名以及 `cdp,bridge,eda,api,...` 精确领域名。
 */
export function allTools(selection?: ToolsetSelection): ToolDef[] {
  const selected = normalizeToolsetSelection(selection);
  const groups: ToolDef[][] = [tagTools(coreTools, "core")];
  for (const [domain, tools] of Object.entries(DOMAIN_GROUPS)) {
    if (domain === "apidocs") continue;
    if (selected && !selected.has(domain)) continue;
    groups.push(tagTools(tools, domain));
  }
  const tools = groups.flat();
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`MCP 工具重名：${tool.name}`);
    seen.add(tool.name);
  }
  return tools;
}

/** 实际入口按同一环境过滤可选资料；不改变纯 allTools() 的公开语义。 */
export function toolsForEnv(
  env: NodeJS.ProcessEnv = process.env,
  selection?: ToolsetSelection,
): ToolDef[] {
  const apiNames = new Set(availableApiDocsTools(env).map((tool) => tool.name));
  return allTools(selection).filter((tool) => tool.toolset !== "api" || apiNames.has(tool.name));
}

/** 将工具列表汇总为 lceda_info 可展示的 toolset 信息。 */
export function toolsetsForTools(tools: readonly ToolDef[]): Record<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const tool of tools) {
    const domain = tool.toolset ?? "unknown";
    const list = map.get(domain) ?? [];
    list.push(tool.name);
    map.set(domain, list);
  }
  const offline = [
    ...(map.get("api") ?? []),
    ...(map.get("format") ?? []),
    ...(map.get("epro2") ?? []),
    ...(map.get("eprj3") ?? []),
    ...(map.get("sim") ?? []),
  ];
  const live = [...(map.get("cdp") ?? []), ...(map.get("bridge") ?? []), ...(map.get("eda") ?? [])];
  if (map.has("core")) map.set("core", [...(map.get("core") ?? [])]);
  if (offline.length > 0) map.set("offline", offline);
  if (live.length > 0) map.set("live", live);
  return Object.fromEntries([...map.entries()].map(([key, names]) => [key, [...names].sort()]));
}
