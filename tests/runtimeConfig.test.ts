import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { loadConfig } from "../src/core/config.ts";
import { createMemoryIo } from "../src/core/io.ts";
import {
  RuntimeConfigError,
  configToEnv,
  extractGlobalOptions,
  parseConfigFile,
  parseDotEnv,
  resolveRuntime,
} from "../src/core/runtimeConfig.ts";
import { main } from "../src/main.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lceda-runtime-"));
}

test("parseDotEnv 支持 export、引号、转义与行内注释", () => {
  const parsed = parseDotEnv(
    [
      "# 注释",
      "export LCEDA_ENV=wsl2",
      'LCEDA_PRO_EXE="D:\\\\Program Files\\\\lceda-pro\\\\lceda-pro.exe"',
      "LCEDA_CDP_PORT=9333 # 行内注释",
      "LCEDA_NODE='C:\\node.exe'",
      "NOT_A_PAIR",
      "bad-key=1",
    ].join("\n"),
  );
  expect(parsed.values.LCEDA_ENV).toBe("wsl2");
  expect(parsed.values.LCEDA_PRO_EXE).toBe("D:\\Program Files\\lceda-pro\\lceda-pro.exe");
  expect(parsed.values.LCEDA_CDP_PORT).toBe("9333");
  expect(parsed.values.LCEDA_NODE).toBe("C:\\node.exe");
  expect(parsed.warnings.length).toBe(2);
});

test("parseConfigFile 校验结构并给出字段路径", () => {
  const valid = parseConfigFile(
    JSON.stringify({
      environment: { kind: "wsl2", windowsHost: "172.18.224.1", clientLocations: ["vm", "host"] },
      client: { exePath: "D:\\Program Files\\lceda-pro\\lceda-pro.exe" },
      cdp: { port: 9333, scan: [9333, 9340] },
      bridge: { nodePath: "C:\\node.exe", script: "C:\\bridge-server.mjs" },
      mcp: { toolsets: ["core", "offline"] },
    }),
  );
  expect(valid.config.environment?.kind).toBe("wsl2");
  expect(
    parseConfigFile(JSON.stringify({ $schema: "https://example/schema.json" })).config,
  ).toEqual({
    $schema: "https://example/schema.json",
  });
  expect(valid.config.cdp?.scan).toEqual([9333, 9340]);

  expect(() => parseConfigFile("{not json")).toThrow(RuntimeConfigError);
  expect(() => parseConfigFile(JSON.stringify({ cdp: { port: 99999 } }))).toThrow(/cdp\.port/);
  expect(() => parseConfigFile(JSON.stringify({ unknownTop: true }))).toThrow(RuntimeConfigError);
});

test("configToEnv 覆盖全部可映射键", () => {
  const mapped = configToEnv({
    environment: { kind: "wsl2", windowsHost: "172.18.224.1", clientLocations: "vm,host" },
    client: { exePath: "/mnt/d/lceda-pro.exe" },
    cdp: { host: "127.0.0.1", port: 9333, scan: [9333, 9340] },
    bridge: {
      host: "127.0.0.1",
      portFirst: 50100,
      portLast: 50109,
      nodePath: "/usr/bin/node",
      script: "/tmp/bridge.mjs",
    },
    mcp: {
      toolsets: ["core"],
      http: { host: "172.18.224.1", port: 3939, path: "/mcp", token: "t0ken", stateless: true },
    },
  });
  expect(mapped).toMatchObject({
    LCEDA_ENV: "wsl2",
    LCEDA_WINDOWS_HOST: "172.18.224.1",
    LCEDA_LEDA_IN: "vm,host",
    LCEDA_PRO_EXE: "/mnt/d/lceda-pro.exe",
    LCEDA_CDP_HOST: "127.0.0.1",
    LCEDA_CDP_PORT: "9333",
    LCEDA_CDP_SCAN: "9333-9340",
    LCEDA_BRIDGE_HOST: "127.0.0.1",
    LCEDA_BRIDGE_PORT_FIRST: "50100",
    LCEDA_BRIDGE_PORT_LAST: "50109",
    LCEDA_NODE: "/usr/bin/node",
    LCEDA_BRIDGE_SCRIPT: "/tmp/bridge.mjs",
    LCEDA_TOOLSETS: "core",
    LCEDA_HTTP_HOST: "172.18.224.1",
    LCEDA_HTTP_PORT: "3939",
    LCEDA_HTTP_PATH: "/mcp",
    LCEDA_HTTP_TOKEN: "t0ken",
    LCEDA_HTTP_STATELESS: "true",
  });
});

test("extractGlobalOptions 只摘全局项，保留命令局部选项", () => {
  const extracted = extractGlobalOptions([
    "mcp",
    "serve",
    "--config",
    "a.json",
    "--env=wsl2",
    "--lceda-in",
    "vm,host",
    "--port",
    "9333",
    "--toolsets",
    "core",
  ]);
  expect(extracted.argv).toEqual(["mcp", "serve", "--port", "9333", "--toolsets", "core"]);
  expect(extracted.options).toEqual([
    { name: "config", value: "a.json" },
    { name: "env", value: "wsl2" },
    { name: "lceda-in", value: "vm,host" },
  ]);
  expect(() => extractGlobalOptions(["--config"])).toThrow(RuntimeConfigError);
});

test("优先级：argv > 配置文件 > .env > 进程环境 > 默认", () => {
  const dir = tempDir();
  const configPath = path.join(dir, "lceda-connect.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      environment: { kind: "wsl2", windowsHost: "172.18.224.1" },
      client: { exePath: "config-etx" },
      cdp: { port: 9444 },
    }),
  );
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(
    envPath,
    [
      "LCEDA_ENV=linux-native",
      "LCEDA_CDP_PORT=9333",
      "LCEDA_PRO_EXE=dotenv-exe",
      "LCEDA_NODE=/opt/node",
    ].join("\n"),
  );

  const resolved = resolveRuntime({
    argv: [
      "mcp",
      "--config",
      configPath,
      "--env-file",
      envPath,
      "--env",
      "windows-native",
      "--exe",
      "argv-exe",
    ],
    env: { PROCESS_KEEPER: "1", LCEDA_CDP_PORT: "9222", LCEDA_BRIDGE_PORT_FIRST: "50111" },
    cwd: dir,
  });

  expect(resolved.argv).toEqual(["mcp"]);
  expect(resolved.configPath).toBe(configPath);
  expect(resolved.envFilePath).toBe(envPath);
  // argv 最高
  expect(resolved.env.LCEDA_ENV).toBe("windows-native");
  expect(resolved.env.LCEDA_PRO_EXE).toBe("argv-exe");
  expect(resolved.sources.LCEDA_ENV).toBe("argv");
  expect(resolved.sources.LCEDA_PRO_EXE).toBe("argv");
  // 配置文件压过 .env 与进程环境
  expect(resolved.env.LCEDA_CDP_PORT).toBe("9444");
  expect(resolved.env.LCEDA_WINDOWS_HOST).toBe("172.18.224.1");
  expect(resolved.sources.LCEDA_CDP_PORT).toBe("config-file");
  // .env 补空位（不覆盖真实环境变量）
  expect(resolved.env.LCEDA_NODE).toBe("/opt/node");
  expect(resolved.sources.LCEDA_NODE).toBe("env-file");
  expect(resolved.env.LCEDA_BRIDGE_PORT_FIRST).toBe("50111");
  expect(resolved.sources.LCEDA_BRIDGE_PORT_FIRST).toBe("process-env");
  // 其它进程环境原样保留
  expect(resolved.env.PROCESS_KEEPER).toBe("1");
});

test("sim 的局部 --config 与全局 --config 不互相抢占", () => {
  const dir = tempDir();
  const simOnly = resolveRuntime({
    argv: ["sim", "netlist", "project.epro2", "--config", "sim.json", "--out", "out"],
    env: {},
    cwd: dir,
    global: { groupIndex: 0, localOptions: ["config"] },
  });
  expect(simOnly.configPath).toBeNull();
  expect(simOnly.argv).toEqual([
    "sim",
    "netlist",
    "project.epro2",
    "--config",
    "sim.json",
    "--out",
    "out",
  ]);

  const globalPath = path.join(dir, "connector.json");
  fs.writeFileSync(globalPath, "{}");
  const globalFirst = resolveRuntime({
    argv: ["--config", globalPath, "sim", "netlist", "project.epro2"],
    env: {},
    cwd: dir,
    global: { groupIndex: 2, localOptions: ["config"] },
  });
  expect(globalFirst.configPath).toBe(globalPath);
  expect(globalFirst.argv).toEqual(["sim", "netlist", "project.epro2"]);
});

test("进程环境里的 LCEDA_ENV 来源标为 env，并传给环境判定", () => {
  const resolved = resolveRuntime({
    argv: ["env"],
    env: { LCEDA_ENV: "wsl2", LCEDA_LEDA_IN: "host" },
  });
  expect(resolved.sources.LCEDA_ENV).toBe("process-env");
  expect(resolved.env.LCEDA_ENV_SOURCE).toBe("env");
  expect(resolved.env.LCEDA_LEDA_IN_SOURCE).toBe("env");
  const cfg = loadConfig(resolved.env);
  expect(cfg.environment.source).toBe("env");
  expect(cfg.environment.clientLocationSource).toBe("env");
});

test("LCEDA_CONFIG 环境变量也能指定配置文件", () => {
  const dir = tempDir();
  const configPath = path.join(dir, "lceda-connect.config.json");
  fs.writeFileSync(configPath, JSON.stringify({ cdp: { port: 9555 } }));
  const resolved = resolveRuntime({ argv: ["env"], env: { LCEDA_CONFIG: configPath }, cwd: dir });
  expect(resolved.configPath).toBe(configPath);
  expect(resolved.env.LCEDA_CDP_PORT).toBe("9555");
  expect(resolved.sources.LCEDA_CDP_PORT).toBe("config-file");
});

test("缺少配置文件或 .env 时明确报错", () => {
  const dir = tempDir();
  expect(() =>
    resolveRuntime({
      argv: ["env", "--config", path.join(dir, "missing.json")],
      env: {},
      cwd: dir,
    }),
  ).toThrow(/配置文件不存在/);
  expect(() =>
    resolveRuntime({
      argv: ["env", "--env-file", path.join(dir, "missing.env")],
      env: {},
      cwd: dir,
    }),
  ).toThrow(/\.env 文件不存在/);
});

test("defaultGroup bin 的 env 不抢占 bridge 的 env→doctor 别名", async () => {
  const bridgeIo = createMemoryIo();
  const bridgeCode = await main({
    argv: ["env", "--json"],
    defaultGroup: "bridge",
    io: bridgeIo,
    env: { ...process.env, LCEDA_ENV: "windows-native" },
  });
  // bridge doctor 在缺少 Windows 客户端/依赖的 CI 上可能以 1 退出；这里只验证入口没被 env 组抢走。
  expect([0, 1]).toContain(bridgeCode);
  expect(bridgeIo.lines.join("\n")).not.toContain("执行环境");
  expect(bridgeIo.lines.length + bridgeIo.errors.length).toBeGreaterThan(0);

  const envIo = createMemoryIo();
  const fakeExe = path.join(tempDir(), "lceda-pro.exe");
  fs.writeFileSync(fakeExe, "");
  const envCode = await main({
    argv: ["env", "--json", "--exe", fakeExe],
    io: envIo,
    env: { ...process.env, LCEDA_ENV: "windows-native" },
  });
  expect(envCode).toBe(0);
  expect(JSON.parse(envIo.lines.join("\n"))).toMatchObject({
    environment: { kind: "windows-native", explicit: true },
  });
});

test("mcp --help 走帮助而不是未知选项", async () => {
  const io = createMemoryIo();
  expect(await main({ argv: ["mcp", "--help"], io, env: { ...process.env } })).toBe(0);
  expect(io.lines.join("\n")).toContain("streamable-http");
  expect(io.errors.join("\n")).toBe("");
});

test("main 在没有配置文件时正常列出 MCP 工具；配置错误时退出码 1", async () => {
  const io = createMemoryIo();
  const code = await main({
    argv: ["mcp", "tools", "--toolsets", "core", "--env", "windows-native"],
    io,
    env: { ...process.env },
  });
  expect(code).toBe(0);
  expect(io.lines.join("\n")).toContain("lceda_info");

  const dir = tempDir();
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, '{"cdp":{"port":"x"}}');
  const badIo = createMemoryIo();
  const badCode = await main({
    argv: ["env", "--config", bad],
    io: badIo,
    env: { ...process.env },
  });
  expect(badCode).toBe(1);
  expect(badIo.errors.join("\n")).toContain("配置不合法");
});
