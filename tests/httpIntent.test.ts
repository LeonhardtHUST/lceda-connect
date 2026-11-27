import { expect, test } from "vite-plus/test";

import { httpOptionsRequested } from "../src/commands/mcp.ts";
import { createMemoryIo } from "../src/core/io.ts";
import { main } from "../src/main.ts";

test("HTTP 参数识别：host 动作的 --port 不当成 HTTP 意图", () => {
  expect(httpOptionsRequested({ port: 9333 }, {}, "host")).toEqual([]);
  expect(httpOptionsRequested({ host: "0.0.0.0", port: 3939 }, {}, "serve")).toEqual([
    "--host",
    "--port",
  ]);
  expect(
    httpOptionsRequested({}, { LCEDA_HTTP_TOKEN: "x", LCEDA_HTTP_HOST: "172.18.224.1" }, "tools"),
  ).toEqual(["LCEDA_HTTP_HOST", "LCEDA_HTTP_TOKEN"]);
});

test("非 http 动作带 HTTP 参数只警告，不启动 HTTP", async () => {
  const io = createMemoryIo();
  const code = await main({
    argv: ["mcp", "tools", "--toolsets", "core", "--host", "172.18.224.1", "--port", "3939"],
    io,
    env: { ...process.env },
  });
  expect(code).toBe(0);
  expect(io.lines.join("\n")).toContain("lceda_info");
  expect(io.errors.join("\n")).toContain("未启动 HTTP 服务");
});

test("非回环 HTTP 缺少 token 时拒绝启动", async () => {
  const io = createMemoryIo();
  const code = await main({
    argv: ["mcp", "http", "--host", "0.0.0.0", "--port", "0"],
    io,
    env: { ...process.env, LCEDA_ENV: "windows-native" },
  });
  expect(code).toBe(1);
  expect(io.errors.join("\n")).toContain("token");
});
