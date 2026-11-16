/**
 * 最小 ZIP 读取器（只读、无第三方依赖）。
 *
 * 只需要覆盖 .epro2 用到的场景：中央目录 + 本地头 + stored/deflate。
 * ZIP64 与加密包直接报错——这两类支持起来容易写出半对不对的代码，
 * 不如让调用方明确知道文件没被解析。
 */
import { inflateRawSync } from "node:zlib";

import { decodeMemberName } from "./gbk.ts";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const MAX_COMMENT = 0xffff;
const ZIP64_EXTRA_ID = 0x0001;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  /** 已按 GBK / UTF-8 回退规则解码的成员名。 */
  name: string;
  /** 成员名原始字节，排错时用。 */
  rawName: Uint8Array;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

export interface ZipArchive {
  entries: ZipEntry[];
  data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readU16(data: Buffer, offset: number): number {
  if (offset + 2 > data.length) throw new ZipError("ZIP 结构越界");
  return data.readUInt16LE(offset);
}

function readU32(data: Buffer, offset: number): number {
  if (offset + 4 > data.length) throw new ZipError("ZIP 结构越界");
  return data.readUInt32LE(offset);
}

interface EndOfCentralDirectory {
  totalEntries: number;
  centralSize: number;
  centralOffset: number;
}

function findEocd(data: Buffer): EndOfCentralDirectory {
  if (data.length < 22) throw new ZipError("ZIP 文件太短，缺少中央目录");
  const minOffset = Math.max(0, data.length - 22 - MAX_COMMENT);
  for (let offset = data.length - 22; offset >= minOffset; offset -= 1) {
    if (data.readUInt32LE(offset) !== SIG_EOCD) continue;
    const diskNumber = readU16(data, offset + 4);
    const centralDisk = readU16(data, offset + 6);
    const entriesThisDisk = readU16(data, offset + 8);
    const totalEntries = readU16(data, offset + 10);
    const centralSize = readU32(data, offset + 12);
    const centralOffset = readU32(data, offset + 16);
    if (diskNumber !== 0 || centralDisk !== 0 || entriesThisDisk !== totalEntries) {
      throw new ZipError("ZIP 是分卷归档，不支持");
    }
    if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new ZipError("ZIP64 归档暂不支持，请在 EDA 里重新导出 .epro2");
    }
    if (centralOffset + centralSize > data.length) {
      throw new ZipError("ZIP 中央目录越界，文件可能被截断");
    }
    return { totalEntries, centralSize, centralOffset };
  }
  throw new ZipError("找不到 ZIP 中央目录（EOCD）");
}

function hasZip64Extra(extra: Buffer): boolean {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    if (id === ZIP64_EXTRA_ID) return true;
    offset += 4 + size;
  }
  return false;
}

/** 只解析中央目录，不读成员数据。局部头在解压时再校验。 */
export function readZip(data: Uint8Array): ZipArchive {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const eocd = findEocd(buf);
  const entries: ZipEntry[] = [];
  let offset = eocd.centralOffset;
  for (let index = 0; index < eocd.totalEntries; index += 1) {
    if (readU32(buf, offset) !== SIG_CENTRAL) {
      throw new ZipError("中央目录项签名不对，文件可能被截断");
    }
    const flags = readU16(buf, offset + 8);
    const method = readU16(buf, offset + 10);
    const crc = readU32(buf, offset + 16);
    const compressedSize = readU32(buf, offset + 20);
    const uncompressedSize = readU32(buf, offset + 24);
    const nameLength = readU16(buf, offset + 28);
    const extraLength = readU16(buf, offset + 30);
    const commentLength = readU16(buf, offset + 32);
    const localOffset = readU32(buf, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const extraEnd = nameEnd + extraLength;
    if (extraEnd > buf.length) throw new ZipError("中央目录项越界，文件可能被截断");
    const rawName = buf.subarray(nameStart, nameEnd);
    const extra = buf.subarray(nameEnd, extraEnd);

    if (flags & 0x0001) {
      throw new ZipError("ZIP 成员被加密，无法读取");
    }
    if (hasZip64Extra(extra) || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new ZipError("ZIP64 归档暂不支持，请在 EDA 里重新导出 .epro2");
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError(`ZIP 用了不支持的压缩方式（method=${method}）`);
    }

    entries.push({
      name: decodeMemberName(rawName, (flags & 0x0800) !== 0),
      rawName,
      flags,
      method,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset > eocd.centralOffset + eocd.centralSize) {
    throw new ZipError("中央目录项超出声明长度");
  }
  return { entries, data: buf };
}

/** 校验本地头并解出成员原始字节。CRC 不对时抛 ZipError。 */
export function extractEntry(archive: ZipArchive, entry: ZipEntry): Buffer {
  const { data } = archive;
  if (readU32(data, entry.localOffset) !== SIG_LOCAL) {
    throw new ZipError(`成员 ${entry.name} 的本地头签名不对`);
  }
  const nameLength = readU16(data, entry.localOffset + 26);
  const extraLength = readU16(data, entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > data.length) {
    throw new ZipError(`成员 ${entry.name} 的数据越界，文件可能被截断`);
  }
  const compressed = data.subarray(start, end);
  let raw: Buffer;
  if (entry.method === 0) {
    raw = Buffer.from(compressed);
  } else {
    try {
      raw = inflateRawSync(compressed);
    } catch (error) {
      throw new ZipError(
        `成员 ${entry.name} 解压失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (raw.length !== entry.uncompressedSize) {
    throw new ZipError(
      `成员 ${entry.name} 解压后长度不符（${raw.length} != ${entry.uncompressedSize}）`,
    );
  }
  const actual = crc32(raw);
  if (actual !== entry.crc32) {
    throw new ZipError(
      `成员 ${entry.name} 的 CRC 校验失败（${actual.toString(16)} != ${entry.crc32.toString(16)}）`,
    );
  }
  return raw;
}

/** 文件头是否是 ZIP 本地头。旧版 .epro 目录、截断下载都会在这里被挡掉。 */
export function looksLikeZip(data: Uint8Array): boolean {
  return (
    data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04
  );
}
