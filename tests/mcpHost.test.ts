import { expect, test } from "vite-plus/test";

import { buildMcpHostPlan, decideClientStart, runMcpHost } from "../src/commands/mcpHost.ts";
import { createMemoryIo } from "../src/core/io.ts";
import type { InteropProbes } from "../src/core/windowsHost.ts";

const WINDOWS_SET = [
  "Path=C:\\Windows;C:\\Tools",
  "USERPROFILE=C:\\Users\\tester",
  "APPDATA=C:\\Users\\tester\\AppData\\Roaming",
].join("\r\n");

function probes(exists: (file: string) => boolean): InteropProbes {
  return {
    platform: "linux",
    exists,
    runText: (command, args) => {
      if (command !== "cmd.exe") return null;
      const joined = args.join(" ");
      if (joined === "/d /c set") return WINDOWS_SET;
      if (joined === "/d /c where node.exe") return "C:\\nodejs\\node.exe";
      if (joined === "/d /c pnpm root -g") return "C:\\pnpm\\global";
      return null;
    },
  };
}

const ENV = {
  LCEDA_ENV: "wsl2",
  LCEDA_CONFIG: "/mnt/d/proj/lceda.json",
  LCEDA_PRO_EXE: "/mnt/d/Program Files/lceda-pro/lceda-pro.exe",
};

test("buildMcpHostPlan 找到 Windows node 与全局安装入口，并翻译配置路径", () => {
  const built = buildMcpHostPlan({
    io: createMemoryIo(),
    env: ENV,
    probes: probes(
      (file) =>
        file === "/mnt/c/nodejs/node.exe" ||
        file === "/mnt/c/pnpm/global/lceda-connect/dist/cli-mcp.mjs",
    ),
  });
  expect(built.error).toBeNull();
  expect(built.plan?.node.wslPath).toBe("/mnt/c/nodejs/node.exe");
  expect(built.plan?.entry.winPath).toBe("C:\\pnpm\\global\\lceda-connect\\dist\\cli-mcp.mjs");
  expect(built.plan?.childEnv.LCEDA_CONFIG).toBe("D:\\proj\\lceda.json");
  expect(built.plan?.childEnv.Path).toBe("C:\\Windows;C:\\Tools");
});

test("buildMcpHostPlan 缺少 Windows 安装时给出可操作错误", () => {
  const built = buildMcpHostPlan({
    io: createMemoryIo(),
    env: {},
    probes: probes(() => false),
  });
  expect(built.plan).toBeNull();
  expect(built.error).toContain("node.exe");
});

test("--print-config 输出可直接粘贴的 stdio 配置", async () => {
  const io = createMemoryIo();
  const code = await runMcpHost({
    io,
    env: ENV,
    printConfig: true,
    forwardArgs: ["--toolsets", "live"],
    probes: probes(
      (file) =>
        file === "/mnt/c/nodejs/node.exe" ||
        file === "/mnt/c/pnpm/global/lceda-connect/dist/cli-mcp.mjs",
    ),
  });
  expect(code).toBe(0);
  const config = JSON.parse(io.lines.join("\n")) as {
    mcpServers: {
      lceda: { type: string; command: string; args: string[]; env: Record<string, string> };
    };
  };
  expect(config.mcpServers.lceda.type).toBe("stdio");
  expect(config.mcpServers.lceda.command).toBe("/mnt/c/nodejs/node.exe");
  expect(config.mcpServers.lceda.args).toEqual([
    "C:\\pnpm\\global\\lceda-connect\\dist\\cli-mcp.mjs",
    "--toolsets",
    "live",
  ]);
  expect(config.mcpServers.lceda.env.LCEDA_CONFIG).toBe("D:\\proj\\lceda.json");
  expect(config.mcpServers.lceda.env.LCEDA_ENV).toBe("windows-native");
});

test("print-config 不回填被移除的 WSL 内部路径，并把警告打到 stderr", async () => {
  const io = createMemoryIo();
  const code = await runMcpHost({
    io,
    env: { ...ENV, LCEDA_CONNECT_HOME: "/root/.lceda-connect", LCEDA_ALLOWED_ROOTS: "/mnt/d/work" },
    printConfig: true,
    probes: probes(
      (file) =>
        file === "/mnt/c/nodejs/node.exe" ||
        file === "/mnt/c/pnpm/global/lceda-connect/dist/cli-mcp.mjs",
    ),
  });
  expect(code).toBe(0);
  const config = JSON.parse(io.lines.join("\n")) as {
    mcpServers: { lceda: { env: Record<string, string> } };
  };
  expect(config.mcpServers.lceda.env.LCEDA_CONNECT_HOME).toBeUndefined();
  expect(config.mcpServers.lceda.env.LCEDA_ALLOWED_ROOTS).toBe("D:\\work");
  expect(io.errors.join("\n")).toContain("WSL 内部路径");
});

test("start-client 决策：目标端口已在跑就跳过，不杀其它端口/无端口的客户端", () => {
  expect(
    decideClientStart({ instances: [1], debugFlagged: [{ pid: 1, port: 9333 }] }, 9333),
  ).toMatchObject({ action: "skip" });
  expect(
    decideClientStart({ instances: [1], debugFlagged: [{ pid: 1, port: 9222 }] }, 9333),
  ).toMatchObject({ action: "error" });
  expect(decideClientStart({ instances: [1], debugFlagged: [] }, 9333)).toMatchObject({
    action: "error",
  });
  expect(decideClientStart({ instances: [], debugFlagged: [] }, 9333)).toMatchObject({
    action: "start",
  });
  expect(decideClientStart(null, 9333)).toMatchObject({ action: "start" });
});

test("没有 Windows 安装时 print-config 也失败并报错", async () => {
  const io = createMemoryIo();
  const code = await runMcpHost({
    io,
    env: {},
    printConfig: true,
    probes: probes(() => false),
  });
  expect(code).toBe(1);
  expect(io.errors.join("\n")).toContain("node.exe");
});
