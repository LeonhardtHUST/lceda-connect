import { expect, test } from "vite-plus/test";

import { DOMAIN_GROUPS } from "../src/main.ts";
import { createMemoryIo } from "../src/core/io.ts";
import { main } from "../src/main.ts";

function run(argv: string[], extra: { defaultGroup?: "cdp" | "bridge" } = {}) {
  const io = createMemoryIo();
  return { io, promise: main({ argv, io, env: { ...process.env }, ...extra }) };
}

test("全局帮助说明 npx 与全局安装两种调用方式", async () => {
  const { io, promise } = run(["--help"]);
  expect(await promise).toBe(0);
  const text = io.lines.join("\n");
  expect(text).toContain("调用方式");
  expect(text).toContain("npx -y lceda-connect");
  expect(text).toContain("npm install -g lceda-connect");
  expect(text).toContain("lceda-connect help <命令组>");
  expect(text).toContain("lceda-mcp");
});

test("help <组> 路由到组内帮助，而不是全局帮助", async () => {
  for (const [target, marker] of [
    ["cdp", "lceda-cdp"],
    ["bridge", "lceda-bridge"],
    ["mcp", "streamable-http"],
    ["env", "执行环境"],
  ] as const) {
    const { io, promise } = run(["help", target]);
    expect(await promise, target).toBe(0);
    expect(io.lines.join("\n"), target).toContain(marker);
    expect(io.lines.join("\n"), target).not.toContain("可用 npx");
  }
});

test("所有领域组都有 --help / help 输出", async () => {
  for (const group of DOMAIN_GROUPS) {
    const viaHelp = run(["help", group.name]);
    expect(await viaHelp.promise, group.name).toBe(0);
    expect(viaHelp.io.lines.join("\n").trim().length, group.name).toBeGreaterThan(20);
  }
});

test("未知帮助目标返回 1 并提示", async () => {
  const { io, promise } = run(["help", "nope"]);
  expect(await promise).toBe(1);
  expect(io.errors.join("\n")).toContain("不认识的命令组");
});

test("帮助优先于配置文件加载", async () => {
  const { io, promise } = run(["--config", "/definitely/missing.json", "--help"]);
  expect(await promise).toBe(0);
  expect(io.lines.join("\n")).toContain("调用方式");
  const group = run(["--config", "/definitely/missing.json", "cdp", "--help"]);
  expect(await group.promise).toBe(0);
  expect(group.io.lines.join("\n")).toContain("lceda-cdp");
});

test("defaultGroup bin 的 --help 显示对应组帮助", async () => {
  const cdp = run(["--help"], { defaultGroup: "cdp" });
  expect(await cdp.promise).toBe(0);
  expect(cdp.io.lines.join("\n")).toContain("lceda-cdp");
  const bridge = run(["--help"], { defaultGroup: "bridge" });
  expect(await bridge.promise).toBe(0);
  expect(bridge.io.lines.join("\n")).toContain("lceda-bridge");
});
