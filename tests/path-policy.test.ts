import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import {
  allowedRootsFromEnv,
  assertSafeWorkDirEntries,
  defaultWriteRoots,
  ensureSafeOutputDir,
  isWithinRoots,
  resolveMcpWritePath,
  safeWriteJson,
  safeWriteText,
} from "../src/core/pathPolicy.ts";
import { ToolError } from "../src/mcp/types.ts";

const isWindows = process.platform === "win32";

function tempDir(prefix = "lceda-policy-out-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Windows 无开发者模式/管理员权限时创建文件 symlink 会失败，返回 false 供调用方 skip。 */
function fileLink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, isWindows ? "file" : undefined);
    return true;
  } catch {
    return false;
  }
}

/** 目录链接优先用 junction（Windows 普通用户可创建），POSIX 用 dir symlink。 */
function dirLink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, isWindows ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

const windowsSkipNote = "当前环境无法创建符号链接（Windows 需要开发者模式或管理员权限）";

test("isWithinRoots 接受根内路径并拒绝前缀相似的兄弟路径", () => {
  const root = path.join(os.tmpdir(), "lceda-root");
  expect(isWithinRoots(path.join(root, "child", "file.json"), [root])).toBe(true);
  expect(isWithinRoots(`${root}-sibling`, [root])).toBe(false);
  expect(isWithinRoots(path.join(root, "child", "..", "file.json"), [root])).toBe(true);
  expect(isWithinRoots(path.join(root, "..", "outside.json"), [root])).toBe(false);
  if (process.platform === "win32") {
    expect(isWithinRoots(path.join(root, "NEW.json").toUpperCase(), [root.toLowerCase()])).toBe(
      true,
    );
  }
});

test("最近已存在祖先 realpath 拒绝符号链接或 junction 逃逸", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "lceda-policy-links-"));
  const root = path.join(temp, "allowed");
  const outside = path.join(temp, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const link = path.join(root, "escape");
  try {
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    return;
  }
  expect(isWithinRoots(path.join(link, "new", "out.json"), [root])).toBe(false);
  expect(isWithinRoots(path.join(link, "out.json"), [outside])).toBe(true);
});

test("resolveMcpWritePath 合并客户端根、环境根和默认根", () => {
  const root = path.join(os.tmpdir(), "lceda-allowed");
  const target = resolveMcpWritePath(path.join(root, "out.json"), [root], {
    LCEDA_ALLOWED_ROOTS: "",
    LCEDA_CONNECT_HOME: path.join(os.tmpdir(), "lceda-home"),
  });
  expect(target).toBe(path.join(root, "out.json"));
  expect(defaultWriteRoots({ LCEDA_CONNECT_HOME: path.join(os.tmpdir(), "lceda-home") })).toContain(
    path.join(os.tmpdir(), "lceda-home"),
  );
  expect(allowedRootsFromEnv({ LCEDA_ALLOWED_ROOTS: `${root}${path.delimiter}${root}-2` })).toEqual(
    [root, `${root}-2`],
  );
});

test("越界写路径返回 PATH_NOT_ALLOWED，星号关闭限制", () => {
  const outside = path.join(path.parse(process.cwd()).root, "lceda-outside", "out.json");
  expect(() => resolveMcpWritePath(outside, [path.join(os.tmpdir(), "lceda-root")], {})).toThrow(
    ToolError,
  );
  try {
    resolveMcpWritePath(outside, [path.join(os.tmpdir(), "lceda-root")], {});
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe("PATH_NOT_ALLOWED");
  }
  expect(resolveMcpWritePath(outside, [], { LCEDA_ALLOWED_ROOTS: "*" })).toBe(
    path.resolve(outside),
  );
});

test("safeWriteFile 拒绝最终文件 symlink，外部文件保持不变", (t) => {
  const temp = tempDir();
  const outDir = path.join(temp, "out");
  const outside = path.join(temp, "outside.json");
  try {
    mkdirSync(outDir);
    writeFileSync(outside, "KEEP", "utf8");
    if (!fileLink(outside, path.join(outDir, "meta.json"))) {
      t.skip(windowsSkipNote);
      return;
    }
    let error: unknown;
    try {
      safeWriteJson(path.join(outDir, "meta.json"), { broken: true });
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe("PATH_NOT_ALLOWED");
    expect(readFileSync(outside, "utf8")).toBe("KEEP");
    // 临时文件必须清理干净，只留下被拒绝的链接本身。
    expect(readdirSync(outDir)).toEqual(["meta.json"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("safeWriteFile 拒绝悬空 symlink，不会顺着链接创建目标", (t) => {
  const temp = tempDir();
  const link = path.join(temp, "dangling.txt");
  const missing = path.join(temp, "missing-target.txt");
  try {
    if (!fileLink(missing, link)) {
      t.skip(windowsSkipNote);
      return;
    }
    expect(() => safeWriteText(link, "nope")).toThrow(ToolError);
    try {
      safeWriteText(link, "nope");
    } catch (error) {
      expect((error as ToolError).code).toBe("PATH_NOT_ALLOWED");
    }
    expect(existsSync(missing)).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("safeWriteFile 正常覆盖普通文件且不留临时文件", () => {
  const temp = tempDir();
  try {
    const file = path.join(temp, "report.md");
    safeWriteText(file, "one");
    safeWriteText(file, "two");
    expect(readFileSync(file, "utf8")).toBe("two");
    expect(readdirSync(temp)).toEqual(["report.md"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("ensureSafeOutputDir 拒绝目录链接并允许正常嵌套创建", (t) => {
  const temp = tempDir();
  const real = path.join(temp, "real");
  const link = path.join(temp, "linked-out");
  try {
    mkdirSync(real);
    if (!dirLink(real, link)) {
      t.skip(windowsSkipNote);
      return;
    }
    expect(() => ensureSafeOutputDir(link)).toThrow(ToolError);
    try {
      ensureSafeOutputDir(link);
    } catch (error) {
      expect((error as ToolError).code).toBe("PATH_NOT_ALLOWED");
    }
    const nested = ensureSafeOutputDir(path.join(temp, "a", "b"));
    expect(existsSync(nested)).toBe(true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("assertSafeWorkDirEntries 拒绝工作目录里已有的链接", (t) => {
  const temp = tempDir("lceda-policy-work-");
  const work = path.join(temp, "work");
  const outside = path.join(temp, "outside");
  try {
    mkdirSync(work);
    mkdirSync(outside);
    if (!dirLink(outside, path.join(work, "escape"))) {
      t.skip(windowsSkipNote);
      return;
    }
    expect(() => assertSafeWorkDirEntries(work)).toThrow(ToolError);
    try {
      assertSafeWorkDirEntries(work);
    } catch (error) {
      expect((error as ToolError).code).toBe("PATH_NOT_ALLOWED");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
