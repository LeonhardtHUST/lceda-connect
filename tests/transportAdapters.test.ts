import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vite-plus/test";

import { createServerFactory } from "../src/mcp/server.ts";
import { startHttpTransport } from "../src/mcp/transports/http.ts";

const env = { ...process.env, LCEDA_ENV: "windows-native" };
const quiet = (): void => {};

test("createServerFactory 每次返回独立 server（HTTP 每 session 一个）", () => {
  const factory = createServerFactory({ env, toolsets: "core" });
  const first = factory();
  const second = factory();
  expect(first).not.toBe(second);
  expect(typeof first.connect).toBe("function");
});

test("HTTP 适配器通过 factory 创建 session server，不复制组装逻辑", async () => {
  let created = 0;
  const base = createServerFactory({ env, toolsets: "core" });
  const handle = await startHttpTransport({
    env,
    toolsets: "core",
    host: "127.0.0.1",
    port: 0,
    log: quiet,
    serverFactory: () => {
      created += 1;
      return base();
    },
  });
  try {
    const first = new Client({ name: "adapter-1", version: "0" });
    await first.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    expect(created).toBe(1);
    await first.close();

    // 客户端 close() 不会发 DELETE；新 session 会再向 factory 要一个独立 server。
    const second = new Client({ name: "adapter-2", version: "0" });
    await second.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    expect(created).toBe(2);
    const { tools } = await second.listTools();
    expect(tools.map((tool) => tool.name)).toContain("lceda_info");
    await second.close();
  } finally {
    await handle.close();
  }
});
