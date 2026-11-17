import { fetchJson } from "./discover.ts";
import type { CdpSession } from "./session.ts";

/**
 * target / frame 枚举。
 *
 * 编辑器不是独立 target：PCB、原理图是主页面里的 iframe，切编辑器时 target 不变，
 * 变的是 iframe 的 URL。所以「看清结构」要用 Page.getFrameTree，而不是
 * `document.querySelectorAll('iframe')`（后者可能返回空数组而 frame 树里其实有东西）。
 */

/** `/json/list` 返回的一项（只声明用得到的字段，其余原样保留）。 */
export interface CdpTarget {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

export interface CdpFrame {
  id?: string;
  parentId?: string;
  name?: string;
  url?: string;
  [key: string]: unknown;
}

export interface FrameTreeNode {
  frame?: CdpFrame;
  childFrames?: FrameTreeNode[];
  [key: string]: unknown;
}

export interface FrameRow {
  depth: number;
  name: string;
  url: string;
}

/** `GET /json/list`；拿不到或返回不是数组时返回空列表（与源仓库一致）。 */
export async function listTargets(
  host: string,
  port: number,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<CdpTarget[]> {
  const payload = await fetchJson<unknown>(host, port, "/json/list", timeoutMs, signal);
  if (!Array.isArray(payload)) return [];
  return payload.filter(
    (item): item is CdpTarget => item !== null && typeof item === "object" && !Array.isArray(item),
  );
}

/** 打开 Page 域并取当前页面的 frame 树。 */
export async function fetchFrameTree(session: CdpSession): Promise<FrameTreeNode | null> {
  await session.call("Page.enable");
  const result = await session.call<{ frameTree?: FrameTreeNode }>("Page.getFrameTree");
  return result.frameTree ?? null;
}

/** 深度优先压平 frame 树；name 缺失时用 `(main)` 占位（源仓库口径）。 */
export function flattenFrameTree(tree: FrameTreeNode | null, depth = 0): FrameRow[] {
  if (!tree) return [];
  const frame = tree.frame ?? {};
  const name = typeof frame.name === "string" && frame.name !== "" ? frame.name : "(main)";
  const url = typeof frame.url === "string" && frame.url !== "" ? frame.url : "about:blank";
  const rows: FrameRow[] = [{ depth, name, url }];
  for (const child of tree.childFrames ?? []) {
    rows.push(...flattenFrameTree(child, depth + 1));
  }
  return rows;
}

/** 每行 frame 输出两行文本：`- name` 与缩进后的 url（与源仓库 `frames` 同形）。 */
export function formatFrameTree(rows: readonly FrameRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const indent = "  ".repeat(row.depth);
    lines.push(`${indent}- ${row.name}`);
    lines.push(`${indent}  ${row.url}`);
  }
  return lines;
}
