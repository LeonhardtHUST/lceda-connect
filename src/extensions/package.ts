/**
 * `.eext` 离线包身份预检。
 *
 * 只做三件事：确认这是一个本地有限大小的常规 `.eext` ZIP、读出根目录唯一的
 * `extension.json`、把 `{uuid,name,displayName,version}` 规整成可比较的形态。这里不做信任
 * 判断，也不代表包可以安全安装：成员内容不解压、不执行，除根清单外不读取任何
 * 数据，更不接触 EDA、网络或凭据。
 *
 * 成员路径按跨平台安全规则校验：拒绝绝对路径、`..`、反斜杠、控制字符、Windows
 * 保留设备名、大小写重复和文件/目录前缀冲突；合法的 ZIP 目录项（以 `/` 结尾）
 * 会被跳过。这样调用方拿到的路径集合不会因为解压工具不同而指向别处。
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import {
  ZipError,
  crc32,
  looksLikeZip,
  readZip,
  type ZipArchive,
  type ZipEntry,
} from "../epro2/zip.ts";

/** 单个 `.eext` 允许读取的上限，默认 64 MiB。 */
export const EXTENSION_PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
/** 根 `extension.json` 解压后的上限，默认 1 MiB。 */
export const EXTENSION_MANIFEST_MAX_BYTES = 1024 * 1024;
/** ZIP 成员名原始字节上限，避免异常包把路径校验拖垮。 */
export const EXTENSION_MEMBER_NAME_MAX_BYTES = 1024;
export const EXTENSION_NAME_MIN_LENGTH = 5;
export const EXTENSION_NAME_MAX_LENGTH = 30;
export const EXTENSION_VERSION_MAX_LENGTH = 64;
export const EXTENSION_DISPLAY_NAME_MAX_LENGTH = 80;

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_SIGNATURE = 0x06054b50;
const MAX_EOCD_COMMENT = 0xffff;

const HEX32_RE = /^[0-9a-f]{32}$/i;
const UUID_HYPHEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[a-z0-9_-]+$/;
const VERSION_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function hasControlOrLineBreak(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

const BIDI_CONTROL_RE = /[\u202a-\u202e\u2066-\u2069]/;
const WINDOWS_INVALID_CHAR_RE = /[<>:"|?*\\]/;
const RESERVED_DEVICE_RE = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const UNC_OR_DEVICE_PATH_RE = /^[\\/]{2}/;
const DRIVE_RELATIVE_PATH_RE = /^[A-Za-z]:(?![\\/])/;
const DRIVE_ABSOLUTE_PATH_RE = /^[A-Za-z]:/;

export type ExtensionPackageErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_PATH"
  | "NOT_EEXT"
  | "FILE_NOT_FOUND"
  | "NOT_REGULAR_FILE"
  | "SYMLINK"
  | "FILE_TOO_LARGE"
  | "NOT_ZIP"
  | "BAD_ZIP"
  | "INVALID_MEMBER_PATH"
  | "DUPLICATE_MEMBER"
  | "AMBIGUOUS_MANIFEST"
  | "MANIFEST_MISSING"
  | "MANIFEST_TOO_LARGE"
  | "INVALID_MANIFEST"
  | "INVALID_UUID"
  | "INVALID_NAME"
  | "INVALID_DISPLAY_NAME"
  | "INVALID_VERSION";

/** 预检失败原因。`code` 稳定，便于 CLI / MCP 直接映射退出码或错误码。 */
export class ExtensionPackageError extends Error {
  readonly code: ExtensionPackageErrorCode;

  constructor(message: string, code: ExtensionPackageErrorCode) {
    super(message);
    this.name = "ExtensionPackageError";
    this.code = code;
  }
}

/** 预检结果。`uuid` 已规范化成小写 32 位十六进制。 */
export interface ExtensionPackage {
  readonly path: string;
  readonly sha256: string;
  readonly uuid: string;
  /** `extension.json` 的机器名，也用于没有 UUID 时的历史身份。 */
  readonly name: string;
  /** 人类可读名称；清单未提供时按文档回退为 `name`。 */
  readonly displayName: string;
  readonly version: string;
}

/** 与 `sha256` 严格对应的本次读取字节；调用方负责后续暂存或释放。 */
export interface ExtensionPackageRead {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Buffer;
}

export interface InspectExtensionPackageOptions {
  /** 整个 `.eext` 的读取上限，默认 {@link EXTENSION_PACKAGE_MAX_BYTES}。 */
  readonly maxBytes?: number;
  /** 根 `extension.json` 解压后的上限，默认 {@link EXTENSION_MANIFEST_MAX_BYTES}。 */
  readonly maxManifestBytes?: number;
}

/** `extension.json` 中参与身份展示与比较的字段。 */
export interface ExtensionManifestIdentity {
  readonly uuid: string;
  readonly name: string;
  readonly displayName: string;
  readonly version: string;
}

interface PackageMember {
  readonly entry: ZipEntry;
  /** 去掉目录项末尾 `/` 的成员路径。 */
  readonly name: string;
  /** 用于查重的 NFC + 小写路径。 */
  readonly key: string;
  readonly directory: boolean;
}

/** 已校验的本地头位置；payload 边界仍以中央目录为准。 */
interface LocalMember {
  readonly dataStart: number;
  readonly dataEnd: number;
}

function fail(message: string, code: ExtensionPackageErrorCode): never {
  throw new ExtensionPackageError(message, code);
}

/**
 * 把 UUID 规范成小写 32 位十六进制。接受 32 位十六进制或标准
 * `8-4-4-4-12` 连字符形式；不做 RFC 版本位/变体位校验，也不接受空白。
 */
export function normalizeExtensionUuid(value: string): string {
  if (typeof value !== "string") {
    fail("UUID 必须是字符串", "INVALID_UUID");
  }
  if (value.length === 32 && HEX32_RE.test(value)) {
    return value.toLowerCase();
  }
  if (value.length === 36 && UUID_HYPHEN_RE.test(value)) {
    return value.replaceAll("-", "").toLowerCase();
  }
  fail("UUID 必须是 32 位十六进制，或标准 8-4-4-4-12 形式", "INVALID_UUID");
}

/** 只判断 UUID 是否合法，不抛异常。 */
export function isValidExtensionUuid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    normalizeExtensionUuid(value);
    return true;
  } catch {
    return false;
  }
}

/** 校验任意值并返回规范化 UUID（大小写与连字符均会被规整）。 */
export function validateExtensionUuid(value: unknown): string {
  if (typeof value !== "string") {
    fail("extension.json 的 uuid 必须是字符串", "INVALID_UUID");
  }
  return normalizeExtensionUuid(value);
}

/** 扩展名 `name`：5-30 个字符，只允许小写字母、数字、下划线和连字符。 */
export function validateExtensionName(value: unknown): string {
  if (typeof value !== "string") {
    fail("extension.json 的 name 必须是字符串", "INVALID_NAME");
  }
  if (value.length < EXTENSION_NAME_MIN_LENGTH || value.length > EXTENSION_NAME_MAX_LENGTH) {
    fail(
      `extension.json 的 name 长度必须是 ${EXTENSION_NAME_MIN_LENGTH}-${EXTENSION_NAME_MAX_LENGTH} 个字符`,
      "INVALID_NAME",
    );
  }
  if (!NAME_RE.test(value)) {
    fail("extension.json 的 name 只能包含小写字母、数字、下划线和连字符", "INVALID_NAME");
  }
  return value;
}

/** 人类可读名称：非空、首尾无空白、单行、最长 80 字符；允许 Unicode 文本。 */
export function validateExtensionDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    fail("extension.json 的 displayName 必须是字符串", "INVALID_DISPLAY_NAME");
  }
  if (value.length === 0 || value.length > EXTENSION_DISPLAY_NAME_MAX_LENGTH) {
    fail(
      `extension.json 的 displayName 长度必须是 1-${EXTENSION_DISPLAY_NAME_MAX_LENGTH} 个字符`,
      "INVALID_DISPLAY_NAME",
    );
  }
  if (value !== value.trim()) {
    fail("extension.json 的 displayName 首尾不能有空白", "INVALID_DISPLAY_NAME");
  }
  if (hasControlOrLineBreak(value) || BIDI_CONTROL_RE.test(value)) {
    fail(
      "extension.json 的 displayName 必须是单行文本，不能包含控制字符或双向文本控制符",
      "INVALID_DISPLAY_NAME",
    );
  }
  return value;
}

/** 版本：单行 `major.minor.patch`，可带 `-预发布` / `+构建` 后缀，最长 64 字符。 */
export function validateExtensionVersion(value: unknown): string {
  if (typeof value !== "string") {
    fail("extension.json 的 version 必须是字符串", "INVALID_VERSION");
  }
  if (value.length === 0 || value.length > EXTENSION_VERSION_MAX_LENGTH) {
    fail(
      `extension.json 的 version 长度必须是 1-${EXTENSION_VERSION_MAX_LENGTH} 个字符`,
      "INVALID_VERSION",
    );
  }
  if (value !== value.trim() || hasControlOrLineBreak(value)) {
    fail("extension.json 的 version 必须是单行文本，不能包含空白或控制字符", "INVALID_VERSION");
  }
  if (!VERSION_RE.test(value)) {
    fail("extension.json 的 version 必须符合 major.minor.patch 形式", "INVALID_VERSION");
  }
  return value;
}

/**
 * 校验 `extension.json` 顶层对象并返回规范化后的身份字段。
 *
 * `displayName` 缺失（undefined / null）时按文档回退为 `name`；一旦提供，就必须
 * 是合法的人可读单行文本，空串、带首尾空白或多行都不会被静默修正。
 */
export function validateExtensionManifest(value: unknown): ExtensionManifestIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("extension.json 顶层必须是 JSON 对象", "INVALID_MANIFEST");
  }
  const record = value as Record<string, unknown>;
  const name = validateExtensionName(record.name);
  const displayName =
    record.displayName === undefined || record.displayName === null
      ? name
      : validateExtensionDisplayName(record.displayName);
  return {
    uuid: validateExtensionUuid(record.uuid),
    name,
    displayName,
    version: validateExtensionVersion(record.version),
  };
}

function comparePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWindowsReparsePoint(file: string): boolean {
  if (process.platform !== "win32") return false;
  try {
    // 先把父目录解析成真实路径，避免把普通目录链接误判成最终文件是 reparse point。
    const expected = path.join(realpathSync.native(path.dirname(file)), path.basename(file));
    return comparePath(realpathSync.native(file)) !== comparePath(expected);
  } catch {
    // 悬空链接或无法解析的 reparse point：按不安全处理。
    return true;
  }
}

function assertLocalEextPath(file: string): string {
  if (typeof file !== "string" || file.trim().length === 0) {
    fail("文件路径为空", "INVALID_PATH");
  }
  if (file.includes("\0")) {
    fail("文件路径包含 NUL 字符", "INVALID_PATH");
  }
  if (UNC_OR_DEVICE_PATH_RE.test(file)) {
    fail(`拒绝 UNC 或 Windows 设备路径：${file}`, "INVALID_PATH");
  }
  if (DRIVE_RELATIVE_PATH_RE.test(file)) {
    fail(`拒绝盘符相对路径：${file}`, "INVALID_PATH");
  }
  if (process.platform === "win32" && DRIVE_ABSOLUTE_PATH_RE.test(file)) {
    if (file.slice(2).includes(":")) {
      fail(`拒绝 NTFS 备用数据流路径：${file}`, "INVALID_PATH");
    }
  }

  const resolved = path.resolve(file);
  const base = path.basename(resolved);
  if (base.length === 0 || base === "." || base === "..") {
    fail(`文件路径没有有效文件名：${file}`, "INVALID_PATH");
  }
  if (RESERVED_DEVICE_RE.test(base)) {
    fail(`拒绝 Windows 设备文件名：${base}`, "INVALID_PATH");
  }
  if (path.extname(base).toLowerCase() !== ".eext") {
    fail(`不是 .eext 文件：${file}`, "NOT_EEXT");
  }
  return resolved;
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} 必须是正整数`, "INVALID_ARGUMENT");
  }
  return value;
}

function readPackageBytes(file: string, maxBytes: number): Buffer {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      fail(`文件不存在：${file}`, "FILE_NOT_FOUND");
    }
    fail(`无法检查文件：${error instanceof Error ? error.message : String(error)}`, "INVALID_PATH");
  }
  if (before.isSymbolicLink()) {
    fail(`拒绝符号链接：${file}`, "SYMLINK");
  }
  if (!before.isFile()) {
    fail(`不是常规文件：${file}`, "NOT_REGULAR_FILE");
  }
  if (isWindowsReparsePoint(file)) {
    fail(`拒绝 reparse point：${file}`, "SYMLINK");
  }
  if (before.size > maxBytes) {
    fail(`文件超过 ${maxBytes} 字节上限：${file}`, "FILE_TOO_LARGE");
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) {
      fail(`不是常规文件：${file}`, "NOT_REGULAR_FILE");
    }
    // lstat 后到 open 之间文件被替换成链接或别的文件时，拒绝继续读取。
    if (
      before.ino !== 0 &&
      opened.ino !== 0 &&
      (before.ino !== opened.ino || before.dev !== opened.dev)
    ) {
      fail(`文件在检查后被替换：${file}`, "SYMLINK");
    }
    if (opened.size > maxBytes) {
      fail(`文件超过 ${maxBytes} 字节上限：${file}`, "FILE_TOO_LARGE");
    }
    // 只按 fstat 后的长度和上限读取，文件在检查后变大也不会无限读。
    const buffer = Buffer.allocUnsafe(Math.min(opened.size, maxBytes + 1));
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(descriptor, buffer, total, buffer.length - total, total);
      if (count === 0) break;
      total += count;
    }
    if (total > maxBytes) {
      fail(`文件超过 ${maxBytes} 字节上限：${file}`, "FILE_TOO_LARGE");
    }
    return buffer.subarray(0, total);
  } catch (error) {
    if (error instanceof ExtensionPackageError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ExtensionPackageError(`文件不存在：${file}`, "FILE_NOT_FOUND");
    }
    throw new ExtensionPackageError(
      `无法读取文件：${error instanceof Error ? error.message : String(error)}`,
      "INVALID_PATH",
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseArchive(data: Buffer): ZipArchive {
  if (!looksLikeZip(data)) {
    fail("文件头不是 ZIP（PK\\x03\\x04），不是 .eext 包", "NOT_ZIP");
  }
  try {
    return readZip(data);
  } catch (error) {
    if (error instanceof ZipError) {
      fail(`ZIP 结构损坏：${error.message}`, "BAD_ZIP");
    }
    fail(`ZIP 结构损坏：${error instanceof Error ? error.message : String(error)}`, "BAD_ZIP");
  }
}

/**
 * 找出中央目录起点。`readZip` 不暴露 EOCD，本地头/数据范围需要它来确认
 * payload 没有伸进中央目录。扫描顺序与 `readZip` 一致：从文件末尾找第一个
 * EOCD 签名。
 */
function centralDirectoryStart(data: Buffer): number {
  if (data.length < 22) {
    fail("ZIP 文件太短，缺少中央目录", "BAD_ZIP");
  }
  const minOffset = Math.max(0, data.length - 22 - MAX_EOCD_COMMENT);
  for (let offset = data.length - 22; offset >= minOffset; offset -= 1) {
    if (data.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const centralOffset = data.readUInt32LE(offset + 16);
    if (centralOffset <= data.length) return centralOffset;
  }
  fail("找不到 ZIP 中央目录（EOCD）", "BAD_ZIP");
}

/**
 * 校验单个成员的本地头：签名、名称字节、标志位、压缩方法、CRC/长度与边界
 * 都必须和中央目录一致。只读头部字段，不解压 payload。
 */
function localHeader(archive: ZipArchive, entry: ZipEntry, centralStart: number): LocalMember {
  const { data } = archive;
  const offset = entry.localOffset;
  if (offset + 30 > centralStart) {
    fail(`成员 ${entry.name} 的本地头越界`, "BAD_ZIP");
  }
  if (data.readUInt32LE(offset) !== LOCAL_HEADER_SIGNATURE) {
    fail(`成员 ${entry.name} 的本地头签名不对`, "BAD_ZIP");
  }
  const flags = data.readUInt16LE(offset + 6);
  const method = data.readUInt16LE(offset + 8);
  const crc = data.readUInt32LE(offset + 14);
  const compressedSize = data.readUInt32LE(offset + 18);
  const uncompressedSize = data.readUInt32LE(offset + 22);
  const nameLength = data.readUInt16LE(offset + 26);
  const extraLength = data.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  const nameEnd = nameStart + nameLength;
  const dataStart = nameEnd + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (nameEnd > centralStart || dataStart > centralStart || dataEnd > centralStart) {
    fail(`成员 ${entry.name} 的本地头或数据越过中央目录起点`, "BAD_ZIP");
  }
  if (flags !== entry.flags) {
    fail(`成员 ${entry.name} 的本地头标志位与中央目录不一致`, "BAD_ZIP");
  }
  if (method !== entry.method) {
    fail(`成员 ${entry.name} 的本地头压缩方式与中央目录不一致`, "BAD_ZIP");
  }
  if (!data.subarray(nameStart, nameEnd).equals(entry.rawName)) {
    fail(`成员 ${entry.name} 的名称在本地头与中央目录不一致`, "BAD_ZIP");
  }
  if ((flags & 0x0008) === 0) {
    if (
      crc !== entry.crc32 ||
      compressedSize !== entry.compressedSize ||
      uncompressedSize !== entry.uncompressedSize
    ) {
      fail(`成员 ${entry.name} 的本地头 CRC/长度与中央目录不一致`, "BAD_ZIP");
    }
  } else if (
    (crc !== 0 && crc !== entry.crc32) ||
    (compressedSize !== 0 && compressedSize !== entry.compressedSize) ||
    (uncompressedSize !== 0 && uncompressedSize !== entry.uncompressedSize)
  ) {
    fail(`成员 ${entry.name} 的本地头 CRC/长度与中央目录不一致`, "BAD_ZIP");
  }
  return { dataStart, dataEnd };
}

/**
 * 对全部成员（含目录项）校验本地头，并拒绝重复或重叠的本地范围。
 * 中央目录与本地头对同一成员给出不同边界时，任何解压工具都可能理解成
 * 另一条路径，因此直接视为结构损坏。
 */
function validateLocalHeaders(
  archive: ZipArchive,
  members: readonly PackageMember[],
  centralStart: number,
): Map<ZipEntry, LocalMember> {
  const infos = new Map<ZipEntry, LocalMember>();
  const ranges: Array<{ start: number; end: number; name: string }> = [];
  const offsets = new Set<number>();
  for (const member of members) {
    const { entry } = member;
    if (offsets.has(entry.localOffset)) {
      fail(`多个成员指向同一个本地头：${member.name}`, "BAD_ZIP");
    }
    offsets.add(entry.localOffset);
    const info = localHeader(archive, entry, centralStart);
    infos.set(entry, info);
    ranges.push({ start: entry.localOffset, end: info.dataEnd, name: member.name });
  }
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (!previous || !current) continue;
    if (current.start < previous.end) {
      fail(`ZIP 成员本地数据范围重叠：${current.name}`, "BAD_ZIP");
    }
  }
  return infos;
}

function decodeMemberPath(entry: ZipEntry): string {
  const ascii = entry.rawName.every((byte) => byte < 0x80);
  if (ascii) return entry.name;
  if ((entry.flags & 0x0800) === 0) {
    fail("ZIP 成员名不是 ASCII 且未设置 UTF-8 标志位，编码有歧义", "INVALID_MEMBER_PATH");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(entry.rawName);
  } catch {
    fail("ZIP 成员名的 UTF-8 编码不合法", "INVALID_MEMBER_PATH");
  }
}

function validateMemberPart(part: string): void {
  if (part.length === 0 || part === "." || part === "..") {
    fail(`ZIP 成员路径包含空段、. 或 ..：${part}`, "INVALID_MEMBER_PATH");
  }
  if (part.includes("\\")) {
    fail("ZIP 成员路径包含反斜杠，路径分隔符有歧义", "INVALID_MEMBER_PATH");
  }
  if (hasControlOrLineBreak(part) || BIDI_CONTROL_RE.test(part)) {
    fail("ZIP 成员路径包含控制字符或双向文本控制符", "INVALID_MEMBER_PATH");
  }
  if (WINDOWS_INVALID_CHAR_RE.test(part)) {
    fail(`ZIP 成员路径包含 Windows 非法字符：${part}`, "INVALID_MEMBER_PATH");
  }
  if (part !== part.trim()) {
    fail(`ZIP 成员路径段首尾有空白：${JSON.stringify(part)}`, "INVALID_MEMBER_PATH");
  }
  if (part.endsWith(".")) {
    fail(`ZIP 成员路径段以点结尾，Windows 上会被截断：${part}`, "INVALID_MEMBER_PATH");
  }
  if (RESERVED_DEVICE_RE.test(part)) {
    fail(`ZIP 成员路径使用 Windows 设备名：${part}`, "INVALID_MEMBER_PATH");
  }
}

function validateMember(entry: ZipEntry): PackageMember {
  if (entry.rawName.length === 0) {
    fail("ZIP 成员名为空", "INVALID_MEMBER_PATH");
  }
  if (entry.rawName.length > EXTENSION_MEMBER_NAME_MAX_BYTES) {
    fail(`ZIP 成员名超过 ${EXTENSION_MEMBER_NAME_MAX_BYTES} 字节`, "INVALID_MEMBER_PATH");
  }
  const decoded = decodeMemberPath(entry);
  const directory = decoded.endsWith("/");
  const name = directory ? decoded.slice(0, -1) : decoded;
  if (name.length === 0) {
    fail("ZIP 成员路径为空", "INVALID_MEMBER_PATH");
  }
  const parts = name.split("/");
  for (const part of parts) validateMemberPart(part);
  return {
    entry,
    name,
    key: parts.join("/").normalize("NFC").toLowerCase(),
    directory,
  };
}

function collectMembers(entries: readonly ZipEntry[]): PackageMember[] {
  const members = entries.map(validateMember);
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.key)) {
      fail(`ZIP 成员路径重复或有大小写歧义：${member.name}`, "DUPLICATE_MEMBER");
    }
    seen.add(member.key);
  }

  // 同一路径不能既是文件又是目录（例如文件 foo 与成员 foo/bar.js）。
  const files = new Set(members.filter((member) => !member.directory).map((member) => member.key));
  for (const member of members) {
    let prefix = member.key;
    for (;;) {
      const cut = prefix.lastIndexOf("/");
      if (cut < 0) break;
      prefix = prefix.slice(0, cut);
      if (files.has(prefix)) {
        fail(`ZIP 成员路径同时被用作文件和目录：${prefix}`, "DUPLICATE_MEMBER");
      }
    }
  }
  return members;
}

function findManifest(members: readonly PackageMember[]): PackageMember {
  let nested = false;
  const candidates: PackageMember[] = [];
  for (const member of members) {
    const base = member.name.slice(member.name.lastIndexOf("/") + 1).toLowerCase();
    if (base !== "extension.json") continue;
    if (member.key === "extension.json") {
      candidates.push(member);
    } else {
      nested = true;
    }
  }
  if (nested) {
    fail("ZIP 内存在根目录之外的 extension.json，与根清单冲突", "AMBIGUOUS_MANIFEST");
  }
  if (candidates.length === 0) {
    fail("ZIP 根目录缺少 extension.json", "MANIFEST_MISSING");
  }
  if (candidates.length > 1) {
    fail("ZIP 根目录存在多个 extension.json", "DUPLICATE_MEMBER");
  }
  const manifest = candidates[0];
  if (!manifest) {
    fail("ZIP 根目录缺少 extension.json", "MANIFEST_MISSING");
  }
  if (manifest.directory) {
    fail("根目录的 extension.json 是目录项，不是清单文件", "AMBIGUOUS_MANIFEST");
  }
  if (manifest.name !== "extension.json") {
    fail(`根清单名称必须是小写 extension.json，实际是 ${manifest.name}`, "AMBIGUOUS_MANIFEST");
  }
  return manifest;
}

function inflateManifest(compressed: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  try {
    return inflateRawSync(compressed, { maxOutputLength: maxBytes + 1 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      fail(`extension.json 解压后超过 ${maxBytes} 字节上限`, "MANIFEST_TOO_LARGE");
    }
    fail(
      `extension.json 解压失败：${error instanceof Error ? error.message : String(error)}`,
      "BAD_ZIP",
    );
  }
}

function extractManifest(
  archive: ZipArchive,
  member: PackageMember,
  local: LocalMember,
  maxBytes: number,
): Buffer {
  const { entry } = member;
  if (entry.uncompressedSize > maxBytes) {
    fail(`extension.json 解压后超过 ${maxBytes} 字节上限`, "MANIFEST_TOO_LARGE");
  }

  const compressed = archive.data.subarray(local.dataStart, local.dataEnd);
  let raw: Buffer;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      fail("extension.json 的 stored 数据长度不一致", "BAD_ZIP");
    }
    raw = Buffer.from(compressed);
  } else {
    raw = inflateManifest(compressed, entry, maxBytes);
  }
  if (raw.length > maxBytes) {
    fail(`extension.json 解压后超过 ${maxBytes} 字节上限`, "MANIFEST_TOO_LARGE");
  }
  if (raw.length !== entry.uncompressedSize) {
    fail(`extension.json 解压后长度不符（${raw.length} != ${entry.uncompressedSize}）`, "BAD_ZIP");
  }
  if (crc32(raw) !== entry.crc32) {
    fail("extension.json 的 CRC 校验失败", "BAD_ZIP");
  }
  return raw;
}

function parseManifest(raw: Buffer): ExtensionManifestIdentity {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    fail("extension.json 不是合法 UTF-8", "INVALID_MANIFEST");
  }
  if (text.trim().length === 0) {
    fail("extension.json 为空", "INVALID_MANIFEST");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(
      `extension.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      "INVALID_MANIFEST",
    );
  }
  return validateExtensionManifest(parsed);
}

/**
 * 读取 `.eext` 的确切字节并给出同一批字节的 SHA-256。
 *
 * 适合调用方在提交给 EDA 之前先落到私有暂存目录，再用这里返回的 `sha256`
 * 校验暂存副本；`bytes` 是本次读取的副本，调用方负责后续写入或释放。
 */
export async function readExtensionPackageBytes(
  file: string,
  options: Pick<InspectExtensionPackageOptions, "maxBytes"> = {},
): Promise<ExtensionPackageRead> {
  const maxBytes = positiveLimit(options.maxBytes, EXTENSION_PACKAGE_MAX_BYTES, "maxBytes");
  const resolved = assertLocalEextPath(file);
  const bytes = readPackageBytes(resolved, maxBytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { path: resolved, sha256, bytes };
}

/**
 * 预检一个本地 `.eext` 包，返回文件路径、SHA-256 与根清单身份。
 *
 * 只读取根 `extension.json`，其他成员仅做路径与 ZIP 结构校验；不解压、不执行、
 * 不写盘。返回的 `uuid` 一律是小写 32 位十六进制，`sha256` 按本次实际读取到的
 * 文件字节计算（小写十六进制）。清单没有 `displayName` 时按文档回退为 `name`。
 */
export async function inspectExtensionPackage(
  file: string,
  options: InspectExtensionPackageOptions = {},
): Promise<ExtensionPackage> {
  const maxManifestBytes = positiveLimit(
    options.maxManifestBytes,
    EXTENSION_MANIFEST_MAX_BYTES,
    "maxManifestBytes",
  );
  const read = await readExtensionPackageBytes(file, { maxBytes: options.maxBytes });
  const archive = parseArchive(read.bytes);
  const centralStart = centralDirectoryStart(read.bytes);
  const members = collectMembers(archive.entries);
  const localHeaders = validateLocalHeaders(archive, members, centralStart);
  const manifest = findManifest(members);
  const manifestLocal = localHeaders.get(manifest.entry);
  if (!manifestLocal) {
    fail("extension.json 的本地头缺失", "BAD_ZIP");
  }
  const manifestBytes = extractManifest(archive, manifest, manifestLocal, maxManifestBytes);
  const identity = parseManifest(manifestBytes);
  return {
    path: read.path,
    sha256: read.sha256,
    uuid: identity.uuid,
    name: identity.name,
    displayName: identity.displayName,
    version: identity.version,
  };
}
