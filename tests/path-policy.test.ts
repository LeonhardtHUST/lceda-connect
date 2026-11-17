import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import {
  allowedRootsFromEnv,
  defaultWriteRoots,
  isWithinRoots,
  resolveMcpWritePath,
} from "../src/core/pathPolicy.ts";
import { ToolError } from "../src/mcp/types.ts";

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
