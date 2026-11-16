import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { packageVersion } from "../core/version.ts";

/**
 * 证据包（源仓库 `eda_verbs.write_evidence`）。
 *
 * 目录名 `{verb}-{时间戳}`，内容两份：`result.json`（机器可读）与 `evidence.md`
 * （给人看，含版本指纹与换路记录）。只在调用方给了 `--out` 时落盘；默认不写文件。
 */

export interface EvidenceInput {
  verb: string;
  ok: boolean;
  channel?: string | null;
  result?: unknown;
  attempts?: readonly unknown[];
  /** 版本指纹：reader_id / 通道 / 工具版本等；缺省由 writeEvidence 补。 */
  fingerprint?: Record<string, unknown>;
  command?: string;
  error?: string;
  at?: string;
}

export interface EvidenceOptions {
  /** 证据包根目录。 */
  outDir: string;
  /** 直接指定最终目录（测试或重跑时用）。 */
  folder?: string;
  /** 覆盖时间戳（测试用）。 */
  now?: Date;
}

export interface EvidenceWriteResult {
  folder: string;
  resultJson: string;
  evidenceMd: string;
}

function stamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function evidenceFolder(outDir: string, verb: string, now: Date): string {
  return path.join(path.resolve(outDir), `${verb}-${stamp(now)}`);
}

function clipJson(value: unknown, limit = 4000): string {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return text.length > limit ? `${text.slice(0, limit)}\n…（截断，完整内容见 result.json）` : text;
}

/** 写证据包；同名目录已存在时直接复用（时间戳到秒，重跑很少撞）。 */
export function writeEvidence(input: EvidenceInput, options: EvidenceOptions): EvidenceWriteResult {
  const now = options.now ?? new Date();
  const folder = options.folder ?? evidenceFolder(options.outDir, input.verb, now);
  mkdirSync(folder, { recursive: true });

  const fingerprint = {
    reader_id: input.fingerprint?.reader_id ?? null,
    tool: `lceda-connect@${packageVersion()}`,
    ...input.fingerprint,
  };
  const record = {
    verb: input.verb,
    command: input.command ?? "",
    at: input.at ?? now.toISOString(),
    version_fingerprint: fingerprint,
    ok: input.ok,
    channel: input.channel ?? "n/a",
    attempts: input.attempts ?? [],
    error: input.error ?? null,
    result: input.result ?? null,
  };
  const resultJson = path.join(folder, "result.json");
  writeFileSync(resultJson, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const lines = [
    `# ${input.verb}`,
    "",
    `- 时间：${record.at}`,
    `- 通道：${record.channel}`,
    `- 结果：${input.ok ? "成功" : "失败"}`,
    `- 版本指纹：\`${JSON.stringify(fingerprint, null, 0)}\``,
    "",
    "## 返回摘要",
    "",
    "```json",
    clipJson(input.result),
    "```",
  ];
  if (input.error) {
    lines.push("", "## 错误", "", "```text", input.error, "```");
  }
  if ((input.attempts ?? []).length > 0) {
    lines.push("", "## 换路记录", "", "```json", clipJson(input.attempts, 2000), "```");
  }
  const evidenceMd = path.join(folder, "evidence.md");
  writeFileSync(evidenceMd, `${lines.join("\n")}\n`, "utf8");
  return { folder, resultJson, evidenceMd };
}

/** 供 CLI 展示：证据目录路径。 */
export function evidenceFolderName(verb: string, now: Date = new Date()): string {
  return `${verb}-${stamp(now)}`;
}
