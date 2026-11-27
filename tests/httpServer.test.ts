import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vite-plus/test";

import { isAllowedHostHeader, startHttpTransport } from "../src/mcp/transports/http.ts";

const quiet = (): void => {};
const env = { ...process.env, LCEDA_ENV: "windows-native" };

test("HTTP 服务完成握手、列工具并调用 lceda_info", async () => {
  const handle = await startHttpTransport({
    env,
    toolsets: "core",
    host: "127.0.0.1",
    port: 0,
    log: quiet,
  });
  try {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("lceda_info");
    const info = await client.callTool({ name: "lceda_info", arguments: {} });
    expect(info.structuredContent).toMatchObject({
      name: "lceda-connect",
      environment: { kind: "windows-native" },
    });
    await client.close();
  } finally {
    await handle.close();
  }
});

test("/health 返回非敏感状态与端点信息", async () => {
  const handle = await startHttpTransport({ env, host: "127.0.0.1", port: 0, log: quiet });
  try {
    const origin = new URL(handle.url).origin;
    const response = await fetch(`${origin}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      name: "lceda-connect",
      transport: "streamable-http",
      path: "/mcp",
      environment: { kind: "windows-native" },
    });
    expect(body.port).toBe(handle.port);
    expect(body.port).toBeGreaterThan(0);
  } finally {
    await handle.close();
  }
});

test("Bearer token：未带/带错 401，带对可握手", async () => {
  const handle = await startHttpTransport({
    env,
    host: "127.0.0.1",
    port: 0,
    token: "s3cret",
    log: quiet,
  });
  try {
    const origin = new URL(handle.url).origin;
    const denied = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Bearer");

    const client = new Client({ name: "http-token-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: { authorization: "Bearer s3cret" } },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client.close();
  } finally {
    await handle.close();
  }
});

test("无状态模式也能完成握手与调用", async () => {
  const handle = await startHttpTransport({
    env,
    toolsets: "core",
    host: "127.0.0.1",
    port: 0,
    stateless: true,
    log: quiet,
  });
  try {
    const client = new Client({ name: "http-stateless-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    const info = await client.callTool({ name: "lceda_info", arguments: {} });
    expect(info.structuredContent).toMatchObject({ name: "lceda-connect" });
    await client.close();
  } finally {
    await handle.close();
  }
});

test("规范细节：stateless GET 405、过期 session 404、恶意 Origin 403", async () => {
  const statelessHandle = await startHttpTransport({
    env,
    host: "127.0.0.1",
    port: 0,
    stateless: true,
    log: quiet,
  });
  try {
    const statelessOrigin = new URL(statelessHandle.url).origin;
    const getResponse = await fetch(`${statelessOrigin}/mcp`);
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");
  } finally {
    await statelessHandle.close();
  }

  const handle = await startHttpTransport({ env, host: "127.0.0.1", port: 0, log: quiet });
  try {
    const origin = new URL(handle.url).origin;
    const stale = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "does-not-exist" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(stale.status).toBe(404);

    const evilOrigin = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(evilOrigin.status).toBe(403);
  } finally {
    await handle.close();
  }
});

test("Host 头只接受回环与绑定地址", () => {
  expect(isAllowedHostHeader("127.0.0.1:3939", "127.0.0.1")).toBe(true);
  expect(isAllowedHostHeader("localhost:3939", "127.0.0.1")).toBe(true);
  expect(isAllowedHostHeader("[::1]:3939", "::1")).toBe(true);
  expect(isAllowedHostHeader("172.18.224.1:3939", "172.18.224.1")).toBe(true);
  expect(isAllowedHostHeader("evil.example:3939", "127.0.0.1")).toBe(false);
  expect(isAllowedHostHeader(undefined, "127.0.0.1")).toBe(false);
  // 通配绑定时允许 IP 字面量（含 WSL 网卡地址），仍拒绝域名。
  expect(isAllowedHostHeader("172.18.224.1:3939", "0.0.0.0")).toBe(true);
  expect(isAllowedHostHeader("192.168.1.20:3939", "0.0.0.0")).toBe(true);
  expect(isAllowedHostHeader("evil.example:3939", "0.0.0.0")).toBe(false);
});

test("非回环绑定缺少 token 时拒绝启动", async () => {
  await expect(startHttpTransport({ env, host: "0.0.0.0", port: 0, log: quiet })).rejects.toThrow(
    /token/,
  );
});

test("绑定非回环地址时带 token 可握手（模拟跨 WSL 场景）", async () => {
  const handle = await startHttpTransport({
    env,
    toolsets: "core",
    host: "0.0.0.0",
    port: 0,
    token: "s3cret",
    log: quiet,
  });
  try {
    const client = new Client({ name: "http-any-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(handle.url), {
        requestInit: { headers: { authorization: "Bearer s3cret" } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("lceda_info");
    await client.close();
  } finally {
    await handle.close();
  }
});
