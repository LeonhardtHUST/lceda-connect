/** `.epro2` 容器：ZIP 解包、`.epru` 记录流与 project2.json 元数据。 */
import { readFileSync, statSync, type Stats } from "node:fs";
import path from "node:path";

import { decodeMemberName } from "./gbk.ts";
import { ZipError, extractEntry, looksLikeZip, readZip, type ZipEntry } from "./zip.ts";

export class ProjectError extends Error {
  readonly code: string;
  constructor(message: string, code = "PROJECT_ERROR") {
    super(message);
    this.name = "ProjectError";
    this.code = code;
  }
}

export interface ProjectMember {
  name: string;
  size: number;
}

export class Project {
  readonly path: string;
  readonly epruName: string;
  readonly epruText: string;
  readonly projectMeta: Record<string, unknown>;
  readonly members: ProjectMember[];

  constructor(
    filePath: string,
    epruName: string,
    epruText: string,
    projectMeta: Record<string, unknown>,
    members: ProjectMember[],
  ) {
    this.path = filePath;
    this.epruName = epruName;
    this.epruText = epruText;
    this.projectMeta = projectMeta;
    this.members = members;
  }

  get title(): string {
    for (const key of ["title", "name"]) {
      const value = this.projectMeta[key];
      if (typeof value === "string" && value) return value;
      if (typeof value === "number" && value) return String(value);
    }
    return path.basename(this.path, path.extname(this.path));
  }

  lineCount(): number {
    return this.epruText.split("\n").filter((line) => line.trim()).length;
  }
}

function readProjectMeta(raw: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8").decode(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // project2.json 只是补充元数据，坏了不该拖垮整个解析。
    return {};
  }
}

/**
 * 打开 .epro2。失败时抛 ProjectError，并带可读原因。
 *
 * 读取顺序与 Python 版一致：先看文件头，再解析中央目录，最后逐个读成员。
 * 「目录能读、成员读不出」的错误归到 ZIP 数据损坏，避免产出半成品。
 */
export function openProject(filePath: string): Project {
  let stats: Stats;
  try {
    stats = statSync(filePath);
  } catch {
    throw new ProjectError(`文件不存在：${filePath}`, "FILE_NOT_FOUND");
  }
  if (stats.isDirectory()) {
    throw new ProjectError(
      "这是目录，不是 .epro2：旧版 .epro 为目录式包，请在 EDA 中另存为 .epro2",
      "NOT_EPRO2",
    );
  }
  if (!stats.isFile()) {
    throw new ProjectError(`这不是文件：${filePath}`, "NOT_EPRO2");
  }

  let data: Buffer;
  try {
    data = readFileSync(filePath);
  } catch (error) {
    throw new ProjectError(
      `无法读取文件：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!looksLikeZip(data)) {
    if (data.length >= 2 && data[0] === 0x4b && data[1] === 0x50) {
      throw new ProjectError("ZIP 文件头不完整（PK\\x03\\x04）：文件可能在下载时被截断", "BAD_ZIP");
    }
    throw new ProjectError(
      "文件头不是 ZIP（PK\\x03\\x04）：可能是旧版 .epro 或被截断的下载文件",
      "NOT_EPRO2",
    );
  }

  let archive;
  try {
    archive = readZip(data);
  } catch (error) {
    if (error instanceof ZipError) {
      if (error.message.includes("ZIP64") || error.message.includes("加密")) {
        throw new ProjectError(error.message, "BAD_ZIP");
      }
      throw new ProjectError(`ZIP 结构损坏，无法读取目录（${error.message}）`, "BAD_ZIP");
    }
    throw new ProjectError(
      `ZIP 结构损坏，无法读取目录（${error instanceof Error ? error.message : String(error)}）`,
      "BAD_ZIP",
    );
  }

  let epruEntry: ZipEntry | undefined;
  for (const entry of archive.entries) {
    if (entry.name.toLowerCase().endsWith(".epru")) {
      epruEntry = entry;
      break;
    }
  }
  if (!epruEntry) {
    throw new ProjectError(
      "ZIP 内没有 .epru 工程日志：不是嘉立创EDA专业版工程，或文件不完整",
      "MEMBER_MISSING",
    );
  }

  try {
    const epruRaw = extractEntry(archive, epruEntry);
    const epruText = new TextDecoder("utf-8").decode(epruRaw);
    let metaEntry: ZipEntry | undefined;
    for (const entry of archive.entries) {
      if (entry.name === "project2.json") {
        metaEntry = entry;
        break;
      }
    }
    const projectMeta = metaEntry ? readProjectMeta(extractEntry(archive, metaEntry)) : {};
    const members = archive.entries.map((entry) => ({
      name: entry.name,
      size: entry.uncompressedSize,
    }));
    return new Project(
      filePath,
      decodeMemberName(epruEntry.rawName, (epruEntry.flags & 0x0800) !== 0),
      epruText,
      projectMeta,
      members,
    );
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError(
      `ZIP 数据损坏，解压失败（${error instanceof Error ? error.message : String(error)}）：` +
        "文件可能在传输或保存时被截断，请在 EDA 里重新导出 .epro2",
      "BAD_ZIP",
    );
  }
}
