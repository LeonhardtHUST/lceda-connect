import path from "node:path";
import { z } from "zod";

import { assetExists, assetsDir, listAssetFiles, readAssetText } from "../core/assets.ts";
import { packageVersion } from "../main.ts";
import { ToolError, defineTool, type ToolDef } from "./types.ts";

/** assets/skills 下的技能目录名（每个目录对应一个被合并进来的源仓库的知识包）。 */
export function listSkills(): string[] {
  const names = new Set<string>();
  for (const rel of listAssetFiles("skills")) {
    const first = rel.split("/")[0];
    if (first) names.add(first);
  }
  return [...names].sort();
}

function rejectUnsafePath(value: string, label: string): void {
  if (
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split(/[\\/]/u).some((part) => part === "..")
  ) {
    throw new ToolError("PATH_NOT_ALLOWED", `${label} 必须是安全的相对路径。`, { [label]: value });
  }
}

export const skillDocsTool = defineTool({
  name: "skill_docs",
  description:
    "列出或读取随包附带的技能知识文档（SKILL.md、references 等，来自被合并的各个源仓库）。" +
    "不带 skill 时列出全部技能；带 skill 不带 file 时列出该技能的文件；两者都带时返回文件内容。",
  input: {
    skill: z.string().optional().describe("技能目录名，如 cdp-connect、project-analysis"),
    file: z.string().optional().describe("技能目录内的相对路径，如 SKILL.md、references/05-pcb.md"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ skill, file }) => {
    if (!skill) return { skills: listSkills() };
    rejectUnsafePath(skill, "skill");
    if (!assetExists("skills", skill)) {
      throw new ToolError("NOT_FOUND", `没有名为 ${skill} 的技能`, { skills: listSkills() });
    }
    if (!file) return { skill, files: listAssetFiles(`skills/${skill}`) };
    rejectUnsafePath(file, "file");
    if (!assetExists("skills", skill, file)) {
      throw new ToolError("NOT_FOUND", `${skill} 下没有 ${file}`);
    }
    return readAssetText("skills", skill, file);
  },
});

export const infoTool = defineTool({
  name: "lceda_info",
  description:
    "返回 lceda-connect 的版本、assets 位置与已注册的工具清单，用来确认 MCP 服务是否就绪。",
  input: {},
  output: {
    name: z.string(),
    version: z.string(),
    assetsDir: z.string(),
    platform: z.string(),
    node: z.string(),
    tools: z.array(z.string()),
    toolsets: z.record(z.string(), z.array(z.string())),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: (_args, ctx) => ({
    name: "lceda-connect",
    version: packageVersion(),
    assetsDir: assetsDir(ctx.env),
    platform: process.platform,
    node: process.version,
    tools: [...(ctx.toolNames ?? [])],
    toolsets: Object.fromEntries(
      Object.entries(ctx.toolsets ?? {}).map(([key, names]) => [key, [...names]]),
    ),
  }),
});

export const coreTools: ToolDef[] = [infoTool, skillDocsTool];
