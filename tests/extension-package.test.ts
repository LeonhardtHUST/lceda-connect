import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import { expect, test } from "vite-plus/test";

import { crc32 } from "../src/epro2/zip.ts";
import {
  EXTENSION_DISPLAY_NAME_MAX_LENGTH,
  EXTENSION_VERSION_MAX_LENGTH,
  ExtensionPackageError,
  inspectExtensionPackage,
  isValidExtensionUuid,
  normalizeExtensionUuid,
  readExtensionPackageBytes,
  validateExtensionDisplayName,
  validateExtensionManifest,
  validateExtensionName,
  validateExtensionVersion,
  type ExtensionPackageErrorCode,
} from "../src/extensions/package.ts";

const GOOD_UUID = "0123456789abcdef0123456789abcdef";
const GOOD_NAME = "pcbworld-m0-temp-probe";
const GOOD_DISPLAY_NAME = "PCBWorld M0 Temporary Probe";
const WINDOWS_SKIP_NOTE = "当前环境无法创建符号链接（Windows 需要开发者模式或管理员权限）";

interface ZipInput {
  /** 中央目录里的成员名。 */
  readonly name: string | Uint8Array;
  readonly data?: string | Buffer;
  readonly flags?: number;
  readonly method?: 0 | 8;
  /** 故意写错的 CRC，用于负例。 */
  readonly crcOverride?: number;
  /** 只覆盖本地头里的成员名，用于构造本地头/中央目录不一致。 */
  readonly localName?: string | Uint8Array;
  /** 只覆盖本地头里的标志位。 */
  readonly localFlags?: number;
  /** 只覆盖本地头里的压缩方法。 */
  readonly localMethod?: 0 | 8;
  /** 写入 data descriptor（本地头 crc/长度置 0，末尾追加描述符）。 */
  readonly dataDescriptor?: boolean;
  /** 只覆盖中央目录里的本地头偏移，用于构造重叠/重复范围。 */
  readonly localOffsetOverride?: number;
}

function asBytes(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function hasNonAscii(value: string): boolean {
  for (const char of value) {
    if ((char.codePointAt(0) ?? 0) > 0x7f) return true;
  }
  return false;
}

/** 测试专用最小 ZIP 写入器：stored/deflate、目录项、可覆盖 CRC 与本地头名称。 */
function buildZip(files: readonly ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = asBytes(file.name);
    const localNameBytes = file.localName === undefined ? nameBytes : asBytes(file.localName);
    const raw = file.data === undefined ? Buffer.alloc(0) : asBytes(file.data);
    const method = file.method ?? 0;
    const payload = method === 8 ? deflateRawSync(raw) : raw;
    const flags =
      file.flags ?? (typeof file.name === "string" && hasNonAscii(file.name) ? 0x0800 : 0);
    const dataDescriptor = file.dataDescriptor === true;
    const centralFlags = dataDescriptor ? flags | 0x0008 : flags;
    const localFlags = file.localFlags ?? centralFlags;
    const localMethod = file.localMethod ?? method;
    const crc = file.crcOverride ?? crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(localFlags, 6);
    local.writeUInt16LE(localMethod, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(dataDescriptor ? 0 : crc, 14);
    local.writeUInt32LE(dataDescriptor ? 0 : payload.length, 18);
    local.writeUInt32LE(dataDescriptor ? 0 : raw.length, 22);
    local.writeUInt16LE(localNameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, localNameBytes, payload);

    const descriptor = Buffer.alloc(16);
    if (dataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(payload.length, 8);
      descriptor.writeUInt32LE(raw.length, 12);
      locals.push(descriptor);
    }

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(centralFlags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(file.localOffsetOverride ?? offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + localNameBytes.length + payload.length;
    if (dataDescriptor) offset += descriptor.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: GOOD_NAME,
    displayName: GOOD_DISPLAY_NAME,
    uuid: GOOD_UUID,
    version: "1.2.3",
    ...overrides,
  });
}

function writeEext(dir: string, files: readonly ZipInput[], filename = "fixture.eext"): string {
  const target = path.join(dir, filename);
  fs.writeFileSync(target, buildZip(files));
  return target;
}

function errorCode(run: () => unknown): ExtensionPackageErrorCode {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionPackageError);
    return (error as ExtensionPackageError).code;
  }
  throw new Error("期望抛出 ExtensionPackageError，但没有抛出");
}

async function asyncErrorCode(run: Promise<unknown>): Promise<ExtensionPackageErrorCode> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionPackageError);
    return (error as ExtensionPackageError).code;
  }
  throw new Error("期望 Promise 被 ExtensionPackageError 拒绝，但没有拒绝");
}

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-eext-test-"));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fileLink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "file" : undefined);
    return true;
  } catch {
    return false;
  }
}

function dirLink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

function localHeaderOffsets(zip: Buffer): number[] {
  const offsets: number[] = [];
  for (let offset = 0; offset + 4 <= zip.length; offset += 1) {
    if (zip.readUInt32LE(offset) === 0x04034b50) offsets.push(offset);
  }
  return offsets;
}

function centralHeaderOffsets(zip: Buffer): number[] {
  const offsets: number[] = [];
  for (let offset = 0; offset + 4 <= zip.length; offset += 1) {
    if (zip.readUInt32LE(offset) === 0x02014b50) offsets.push(offset);
  }
  return offsets;
}

// ─── 正例 ────────────────────────────────────────────────────────────

test("预检返回路径、SHA-256、规范化 UUID、名称、显示名与版本", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [
      { name: "extension.json", data: manifest({ uuid: "01234567-89AB-CDEF-0123-456789ABCDEF" }) },
      { name: "images/" },
      { name: "images/logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { name: "src/" },
      { name: "src/index.js", data: "export default {};\n", method: 8 },
      { name: "locales/extensionJson/en.json", data: "{}" },
    ]);

    const expectedHash = createHash("sha256").update(fs.readFileSync(pkg)).digest("hex");
    const result = await inspectExtensionPackage(pkg);
    expect(result).toEqual({
      path: path.resolve(pkg),
      sha256: expectedHash,
      uuid: GOOD_UUID,
      name: GOOD_NAME,
      displayName: GOOD_DISPLAY_NAME,
      version: "1.2.3",
    });

    const read = await readExtensionPackageBytes(pkg);
    expect(read.path).toBe(path.resolve(pkg));
    expect(read.sha256).toBe(expectedHash);
    expect(read.bytes.equals(fs.readFileSync(pkg))).toBe(true);
  }));

test("根清单使用 deflate 压缩时同样按 CRC 与长度校验", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [{ name: "extension.json", data: manifest(), method: 8 }]);
    const result = await inspectExtensionPackage(pkg);
    expect(result.uuid).toBe(GOOD_UUID);
    expect(result.name).toBe(GOOD_NAME);
    expect(result.version).toBe("1.2.3");
  }));

test("接受带 BOM 的 UTF-8 清单与设置 UTF-8 标志的非 ASCII 成员名", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [
      { name: "extension.json", data: `\uFEFF${manifest()}` },
      { name: "images/" },
      { name: "images/图标.png", data: Buffer.from([1, 2, 3]) },
    ]);
    const result = await inspectExtensionPackage(pkg);
    expect(result.name).toBe(GOOD_NAME);
    expect(result.uuid).toBe(GOOD_UUID);
  }));

test("displayName 缺失时回退到 name", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [
      { name: "extension.json", data: manifest({ displayName: undefined }) },
    ]);
    const result = await inspectExtensionPackage(pkg);
    expect(result.displayName).toBe(GOOD_NAME);
  }));

test("只读取根清单，不解压或执行其他成员", () =>
  withTempDir(async (dir) => {
    const marker = path.join(dir, "executed.txt");
    const code = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "pwned");`;
    const pkg = writeEext(dir, [
      { name: "extension.json", data: manifest() },
      { name: "src/evil.js", data: code },
    ]);
    await inspectExtensionPackage(pkg);
    expect(fs.existsSync(marker)).toBe(false);
  }));

// ─── 根清单定位 ──────────────────────────────────────────────────────

test("根目录缺少 extension.json 时拒绝", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [{ name: "src/" }, { name: "src/index.js", data: "{}" }]);
    expect(await asyncErrorCode(inspectExtensionPackage(pkg))).toBe("MANIFEST_MISSING");
  }));

test("根目录之外的 extension.json 视为歧义", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [
      { name: "extension.json", data: manifest() },
      { name: "dist/extension.json", data: manifest() },
    ]);
    expect(await asyncErrorCode(inspectExtensionPackage(pkg))).toBe("AMBIGUOUS_MANIFEST");
  }));

test("根清单大小写不规范时拒绝", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [{ name: "Extension.json", data: manifest() }]);
    expect(await asyncErrorCode(inspectExtensionPackage(pkg))).toBe("AMBIGUOUS_MANIFEST");
  }));

test("重复根清单成员被拒绝", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [
      { name: "extension.json", data: manifest() },
      { name: "extension.json", data: manifest({ version: "2.0.0" }) },
    ]);
    expect(await asyncErrorCode(inspectExtensionPackage(pkg))).toBe("DUPLICATE_MEMBER");
  }));

// ─── 成员路径 ────────────────────────────────────────────────────────

test("危险或歧义的成员路径被拒绝", () =>
  withTempDir(async (dir) => {
    const names = [
      "../evil.js",
      "/absolute.js",
      "C:/absolute.js",
      "src\\evil.js",
      "src/./index.js",
      "src/../index.js",
      "a//b.js",
      "CON.js",
      "src/file:stream.js",
      "src/trailing.",
      "src/trailing ",
    ];
    for (const name of names) {
      const pkg = writeEext(dir, [
        { name: "extension.json", data: manifest() },
        { name, data: "{}" },
      ]);
      expect(await asyncErrorCode(inspectExtensionPackage(pkg))).toBe("INVALID_MEMBER_PATH");
    }
  }));

test("大小写重复、文件/目录冲突的成员被拒绝", () =>
  withTempDir(async (dir) => {
    const duplicate = writeEext(dir, [
      { name: "extension.json", data: manifest() },
      { name: "src/index.js", data: "{}" },
      { name: "SRC/index.js", data: "{}" },
    ]);
    expect(await asyncErrorCode(inspectExtensionPackage(duplicate))).toBe("DUPLICATE_MEMBER");

    const fileAndDir = writeEext(dir, [
      { name: "extension.json", data: manifest() },
      { name: "src", data: "file" },
      { name: "src/a.js", data: "{}" },
    ]);
    expect(await asyncErrorCode(inspectExtensionPackage(fileAndDir))).toBe("DUPLICATE_MEMBER");
  }));

test("未设置 UTF-8 标志的非 ASCII 成员名按歧义拒绝", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [
      { name: "extension.json", data: manifest() },
      { name: Buffer.from([0xff, 0xfe, 0x2e, 0x6a, 0x73]), data: "{}", flags: 0 },
    ]);
    expect(await asyncErrorCode(inspectExtensionPackage(pkg))).toBe("INVALID_MEMBER_PATH");
  }));

test("设置 UTF-8 标志但字节不合法的成员名被拒绝", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [
      { name: "extension.json", data: manifest() },
      { name: Buffer.from([0x80, 0x2e, 0x6a, 0x73]), data: "{}", flags: 0x0800 },
    ]);
    expect(await asyncErrorCode(inspectExtensionPackage(pkg))).toBe("INVALID_MEMBER_PATH");
  }));

// ─── ZIP 结构与清单内容 ──────────────────────────────────────────────

test("CRC 不匹配、本地头名称不一致与截断 ZIP 被拒绝", () =>
  withTempDir(async (dir) => {
    const badCrc = writeEext(dir, [{ name: "extension.json", data: manifest(), crcOverride: 0 }]);
    expect(await asyncErrorCode(inspectExtensionPackage(badCrc))).toBe("BAD_ZIP");

    const nameMismatch = writeEext(dir, [
      { name: "extension.json", data: manifest(), localName: "other.json" },
    ]);
    expect(await asyncErrorCode(inspectExtensionPackage(nameMismatch))).toBe("BAD_ZIP");

    const goodZip = buildZip([{ name: "extension.json", data: manifest() }]);
    const truncated = path.join(dir, "truncated.eext");
    fs.writeFileSync(truncated, goodZip.subarray(0, goodZip.length - 30));
    expect(await asyncErrorCode(inspectExtensionPackage(truncated))).toBe("BAD_ZIP");
  }));

test("非清单成员的本地头名称与中央目录不一致时拒绝", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [
      { name: "extension.json", data: manifest() },
      { name: "src/safe.js", data: "{}", localName: "src/other.js" },
    ]);
    expect(await asyncErrorCode(inspectExtensionPackage(pkg))).toBe("BAD_ZIP");
  }));

test("所有成员的本地头标志位与压缩方法必须与中央目录一致", () =>
  withTempDir(async (dir) => {
    const badFlags = writeEext(dir, [
      { name: "extension.json", data: manifest() },
      { name: "src/safe.js", data: "{}", localFlags: 0x0008 },
    ]);
    expect(await asyncErrorCode(inspectExtensionPackage(badFlags))).toBe("BAD_ZIP");

    const badMethod = writeEext(dir, [
      { name: "extension.json", data: manifest() },
      { name: "src/safe.js", data: "{}", method: 8, localMethod: 0 },
    ]);
    expect(await asyncErrorCode(inspectExtensionPackage(badMethod))).toBe("BAD_ZIP");
  }));

test("本地头边界、重复或重叠本地范围被拒绝", () =>
  withTempDir(async (dir) => {
    const zip = buildZip([
      { name: "extension.json", data: manifest() },
      { name: "src/safe.js", data: "{}" },
    ]);
    const second = localHeaderOffsets(zip)[1];
    if (second === undefined) throw new Error("构造的 ZIP 缺少第二个本地头");

    const badBounds = Buffer.from(zip);
    badBounds.writeUInt16LE(0xffff, second + 26);
    const boundsPath = path.join(dir, "bounds.eext");
    fs.writeFileSync(boundsPath, badBounds);
    expect(await asyncErrorCode(inspectExtensionPackage(boundsPath))).toBe("BAD_ZIP");

    const overlap = writeEext(dir, [
      { name: "extension.json", data: manifest() },
      { name: "src/safe.js", data: "{}", localOffsetOverride: 0 },
    ]);
    expect(await asyncErrorCode(inspectExtensionPackage(overlap))).toBe("BAD_ZIP");
  }));

test("本地 payload 越过中央目录起点时拒绝", () =>
  withTempDir(async (dir) => {
    const zip = buildZip([
      { name: "extension.json", data: manifest(), dataDescriptor: true },
      { name: "src/safe.js", data: "{}", dataDescriptor: true },
    ]);
    const secondCentral = centralHeaderOffsets(zip)[1];
    if (secondCentral === undefined) throw new Error("构造的 ZIP 缺少第二个中央目录项");

    const mutated = Buffer.from(zip);
    mutated.writeUInt32LE(mutated.length, secondCentral + 20);
    const pkg = path.join(dir, "payload.eext");
    fs.writeFileSync(pkg, mutated);
    expect(await asyncErrorCode(inspectExtensionPackage(pkg))).toBe("BAD_ZIP");
  }));

test("兼容 data descriptor：本地头 crc/长度为零时按中央目录边界读取", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [
      { name: "extension.json", data: manifest(), dataDescriptor: true },
      { name: "src/safe.js", data: "{}", method: 8, dataDescriptor: true },
    ]);
    const result = await inspectExtensionPackage(pkg);
    expect(result.uuid).toBe(GOOD_UUID);
    expect(result.name).toBe(GOOD_NAME);
  }));

test("非 ZIP 内容与空文件被拒绝", () =>
  withTempDir(async (dir) => {
    const text = path.join(dir, "text.eext");
    fs.writeFileSync(text, "not a zip");
    expect(await asyncErrorCode(inspectExtensionPackage(text))).toBe("NOT_ZIP");

    const empty = path.join(dir, "empty.eext");
    fs.writeFileSync(empty, "");
    expect(await asyncErrorCode(inspectExtensionPackage(empty))).toBe("NOT_ZIP");
  }));

test("扩展名不是 .eext 时拒绝", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [{ name: "extension.json", data: manifest() }], "fixture.zip");
    expect(await asyncErrorCode(inspectExtensionPackage(pkg))).toBe("NOT_EEXT");
  }));

test("清单超过上限时拒绝", () =>
  withTempDir(async (dir) => {
    const pkg = writeEext(dir, [{ name: "extension.json", data: manifest() }]);
    expect(await asyncErrorCode(inspectExtensionPackage(pkg, { maxManifestBytes: 64 }))).toBe(
      "MANIFEST_TOO_LARGE",
    );
  }));

test("非法 UTF-8、非法 JSON、非对象清单被拒绝", () =>
  withTempDir(async (dir) => {
    const invalid: Array<string | Buffer> = [
      Buffer.from([0xff, 0xfe, 0xfd]),
      "",
      "{not json",
      "[]",
      "null",
    ];
    for (const data of invalid) {
      const pkg = writeEext(dir, [{ name: "extension.json", data }]);
      expect(await asyncErrorCode(inspectExtensionPackage(pkg))).toBe("INVALID_MANIFEST");
    }
  }));

test("清单字段不合法时返回对应错误码", () =>
  withTempDir(async (dir) => {
    const cases: Array<[Record<string, unknown>, ExtensionPackageErrorCode]> = [
      [{ uuid: "0123456789abcdef0123456789abcde" }, "INVALID_UUID"],
      [{ uuid: "01234567-89ab-cdef-0123-456789abcde" }, "INVALID_UUID"],
      [{ uuid: undefined }, "INVALID_UUID"],
      [{ name: "PCBWorld" }, "INVALID_NAME"],
      [{ name: "abcd" }, "INVALID_NAME"],
      [{ name: "a".repeat(31) }, "INVALID_NAME"],
      [{ name: "name with space" }, "INVALID_NAME"],
      [{ name: "line\nbreak" }, "INVALID_NAME"],
      [{ name: undefined }, "INVALID_NAME"],
      [{ version: "1.2" }, "INVALID_VERSION"],
      [{ version: "1.2.3\n" }, "INVALID_VERSION"],
      [{ version: "a".repeat(EXTENSION_VERSION_MAX_LENGTH + 1) }, "INVALID_VERSION"],
      [{ displayName: "" }, "INVALID_DISPLAY_NAME"],
      [{ displayName: " padded " }, "INVALID_DISPLAY_NAME"],
      [{ displayName: "line\nbreak" }, "INVALID_DISPLAY_NAME"],
      [{ displayName: "a".repeat(EXTENSION_DISPLAY_NAME_MAX_LENGTH + 1) }, "INVALID_DISPLAY_NAME"],
      [{ displayName: 42 }, "INVALID_DISPLAY_NAME"],
    ];
    for (const [overrides, code] of cases) {
      const pkg = writeEext(dir, [{ name: "extension.json", data: manifest(overrides) }]);
      expect(await asyncErrorCode(inspectExtensionPackage(pkg))).toBe(code);
    }
  }));

// ─── 路径与文件类型 ──────────────────────────────────────────────────

test("UNC、Windows 设备路径、盘符相对路径与设备文件名被拒绝", () =>
  withTempDir(async (dir) => {
    const inputs = [
      String.raw`\\server\share\pkg.eext`,
      String.raw`\\.\pipe\pkg.eext`,
      String.raw`\\?\C:\pkg.eext`,
      "C:relative.eext",
      path.join(dir, "NUL.eext"),
      path.join(dir, "CON.eext"),
    ];
    for (const input of inputs) {
      expect(await asyncErrorCode(inspectExtensionPackage(input))).toBe("INVALID_PATH");
    }
  }));

test("不存在的文件、目录与超限文件被拒绝", () =>
  withTempDir(async (dir) => {
    expect(await asyncErrorCode(inspectExtensionPackage(path.join(dir, "missing.eext")))).toBe(
      "FILE_NOT_FOUND",
    );

    const directory = path.join(dir, "directory.eext");
    fs.mkdirSync(directory);
    expect(await asyncErrorCode(inspectExtensionPackage(directory))).toBe("NOT_REGULAR_FILE");

    const oversized = path.join(dir, "oversized.eext");
    fs.writeFileSync(oversized, Buffer.alloc(128));
    expect(await asyncErrorCode(inspectExtensionPackage(oversized, { maxBytes: 64 }))).toBe(
      "FILE_TOO_LARGE",
    );
  }));

test("最终为符号链接的包被拒绝", async (t) => {
  await withTempDir(async (dir) => {
    const real = writeEext(dir, [{ name: "extension.json", data: manifest() }]);
    const link = path.join(dir, "link.eext");
    if (!fileLink(real, link)) {
      t.skip(WINDOWS_SKIP_NOTE);
      return;
    }
    expect(await asyncErrorCode(inspectExtensionPackage(link))).toBe("SYMLINK");
  });
});

test("父目录为链接但最终文件是普通文件时接受", async (t) => {
  await withTempDir(async (dir) => {
    const realDir = path.join(dir, "real");
    fs.mkdirSync(realDir);
    const pkg = writeEext(realDir, [{ name: "extension.json", data: manifest() }]);
    const linkedDir = path.join(dir, "linked");
    if (!dirLink(realDir, linkedDir)) {
      t.skip(WINDOWS_SKIP_NOTE);
      return;
    }
    const result = await inspectExtensionPackage(path.join(linkedDir, path.basename(pkg)));
    expect(result.uuid).toBe(GOOD_UUID);
    expect(result.sha256).toBe(createHash("sha256").update(fs.readFileSync(pkg)).digest("hex"));
  });
});

test("非法的读取上限参数被拒绝", () =>
  withTempDir(async (dir) => {
    const missing = path.join(dir, "missing.eext");
    expect(await asyncErrorCode(inspectExtensionPackage(missing, { maxBytes: 0 }))).toBe(
      "INVALID_ARGUMENT",
    );
    expect(await asyncErrorCode(inspectExtensionPackage(missing, { maxBytes: 1.5 }))).toBe(
      "INVALID_ARGUMENT",
    );
    expect(await asyncErrorCode(inspectExtensionPackage(missing, { maxManifestBytes: -1 }))).toBe(
      "INVALID_ARGUMENT",
    );
  }));

// ─── 纯函数 ──────────────────────────────────────────────────────────

test("UUID 规范化接受 32 位十六进制与标准连字符形式", () => {
  expect(normalizeExtensionUuid(GOOD_UUID.toUpperCase())).toBe(GOOD_UUID);
  expect(normalizeExtensionUuid("01234567-89AB-CDEF-0123-456789ABCDEF")).toBe(GOOD_UUID);
  expect(isValidExtensionUuid(GOOD_UUID)).toBe(true);
  expect(isValidExtensionUuid("01234567-89ab-cdef-0123-456789abcdef")).toBe(true);
  expect(isValidExtensionUuid(123)).toBe(false);

  const invalid = [
    "",
    "0".repeat(31),
    "0".repeat(33),
    "01234567-89ab-cdef-0123-456789abcde",
    "{01234567-89ab-cdef-0123-456789abcdef}",
    " 0123456789abcdef0123456789abcdef",
    "01234567_89ab_cdef_0123_456789abcdef",
  ];
  for (const value of invalid) {
    expect(isValidExtensionUuid(value)).toBe(false);
    expect(errorCode(() => normalizeExtensionUuid(value))).toBe("INVALID_UUID");
  }
});

test("名称、显示名与版本校验", () => {
  expect(validateExtensionName("abcde")).toBe("abcde");
  expect(validateExtensionName("a".repeat(30))).toBe("a".repeat(30));
  expect(validateExtensionName("my_ext-01")).toBe("my_ext-01");
  expect(errorCode(() => validateExtensionName("Abcde"))).toBe("INVALID_NAME");
  expect(errorCode(() => validateExtensionName(42))).toBe("INVALID_NAME");

  expect(validateExtensionVersion("0.1.1")).toBe("0.1.1");
  expect(validateExtensionVersion("1.2.3-beta.1+build.5")).toBe("1.2.3-beta.1+build.5");
  expect(errorCode(() => validateExtensionVersion("1.2"))).toBe("INVALID_VERSION");
  expect(errorCode(() => validateExtensionVersion("1.2.3 "))).toBe("INVALID_VERSION");

  expect(validateExtensionDisplayName(GOOD_DISPLAY_NAME)).toBe(GOOD_DISPLAY_NAME);
  expect(validateExtensionDisplayName("扩展 名称")).toBe("扩展 名称");
  expect(errorCode(() => validateExtensionDisplayName(" padded "))).toBe("INVALID_DISPLAY_NAME");
  expect(errorCode(() => validateExtensionDisplayName("a\nb"))).toBe("INVALID_DISPLAY_NAME");
  expect(errorCode(() => validateExtensionDisplayName("a\u2028b"))).toBe("INVALID_DISPLAY_NAME");
  expect(errorCode(() => validateExtensionDisplayName(null))).toBe("INVALID_DISPLAY_NAME");
});

test("清单校验返回规范化身份并按文档回退 displayName", () => {
  expect(
    validateExtensionManifest({
      uuid: "01234567-89AB-CDEF-0123-456789ABCDEF",
      name: GOOD_NAME,
      version: "1.0.0",
    }),
  ).toEqual({
    uuid: GOOD_UUID,
    name: GOOD_NAME,
    displayName: GOOD_NAME,
    version: "1.0.0",
  });
  expect(
    validateExtensionManifest({
      uuid: GOOD_UUID,
      name: GOOD_NAME,
      displayName: GOOD_DISPLAY_NAME,
      version: "1.0.0",
    }).displayName,
  ).toBe(GOOD_DISPLAY_NAME);
  expect(errorCode(() => validateExtensionManifest(null))).toBe("INVALID_MANIFEST");
  expect(errorCode(() => validateExtensionManifest([]))).toBe("INVALID_MANIFEST");
});
