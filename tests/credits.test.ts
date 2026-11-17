import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { packageRoot } from "../src/core/assets.ts";

const root = packageRoot();
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");

test("npm 发布清单包含统一致谢与许可说明", () => {
  const pkg = JSON.parse(read("package.json")) as { license: string; files: string[] };
  expect(pkg.license).toBe("GPL-3.0-only");
  expect(pkg.files).toContain("CREDITS.md");
  expect(pkg.files).toContain("THIRD_PARTY_NOTICES.md");
  expect(read("README.md")).toContain("[CREDITS.md]");
});

test("Credits 保留真实第三方上游而不重复列出自有 fork", () => {
  const credits = read("CREDITS.md");
  for (const repository of [
    "easyeda/easyeda-eprj3-skill",
    "easyeda/easyeda-api-skill",
    "easyeda/easyeda-format-skill",
    "easyeda/easyeda-client-cli",
  ]) {
    expect(credits).toContain(`https://github.com/${repository}`);
  }
  expect(credits).not.toMatch(/https?:\/\/github\.com\/LeonhardtHUST\//i);
  expect(read("THIRD_PARTY_NOTICES.md")).toContain("CREDITS.md");
});

test("统一归属文档中的本地链接均可访问", () => {
  for (const file of ["CREDITS.md", "THIRD_PARTY_NOTICES.md"]) {
    let localLinks = 0;
    for (const match of read(file).matchAll(/\]\((?:<([^>]+)>|([^)]+))\)/g)) {
      const target = (match[1] ?? match[2])!.split("#")[0]!;
      if (/^[a-z]+:/i.test(target)) continue;
      localLinks++;
      expect(existsSync(path.resolve(root, target)), `${file}: ${target}`).toBe(true);
    }
    expect(localLinks, `${file} 应至少检查一个本地链接`).toBeGreaterThan(0);
  }
});

test("自有来源继承的审查项目归属和 Apache 声明未被省略", () => {
  expect(read("CREDITS.md")).toContain("https://github.com/chaser-star/dsh-eda-review");
  expect(read("CREDITS.md")).toContain("Copyright 2026 chaser-star");
  expect(read("THIRD_PARTY_NOTICES.md")).toContain("dsh-eda-review");
  expect(read("assets/skills/project-analysis/SOURCE.md")).toContain("dsh-eda-review");
  expect(read("assets/skills/project-analysis/LICENSE-APACHE-2.0")).toContain(
    "Version 2.0, January 2004",
  );
  expect(read("assets/skills/project-analysis/NOTICE")).toContain("Copyright 2026 chaser-star");
});

test("fork 继承的实际第三方 MIT 许可仍随副本保留", () => {
  expect(read("assets/sidecar/eprj3/LICENSE")).toContain("MIT License");
  expect(read("assets/skills/easyeda-format/LICENSE")).toContain("Copyright (c) 2026 EasyEDA");
});
