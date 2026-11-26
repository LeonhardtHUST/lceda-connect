import { expect, test } from "vite-plus/test";

import {
  normalizeMcpEnv,
  parseWindowsEnvSet,
  resolveWindowsEnvironment,
  resolveWindowsMcpEntry,
  resolveWindowsNode,
  resolveWslFacingHost,
  type InteropProbes,
} from "../src/core/windowsHost.ts";

test("parseWindowsEnvSet 跳过驱动器当前目录项", () => {
  const parsed = parseWindowsEnvSet(
    [
      "=C:=C:\\work",
      "Path=C:\\Windows;C:\\Tools",
      "ProgramFiles(x86)=C:\\Program Files (x86)",
      "bad line",
    ].join("\r\n"),
  );
  expect(parsed.Path).toBe("C:\\Windows;C:\\Tools");
  expect(parsed["ProgramFiles(x86)"]).toBe("C:\\Program Files (x86)");
  expect(parsed.C).toBeUndefined();
});

const windowsSet = [
  "Path=C:\\Windows;C:\\Tools",
  "USERPROFILE=C:\\Users\\tester",
  "APPDATA=C:\\Users\\tester\\AppData\\Roaming",
].join("\n");

function probes(overrides: Partial<InteropProbes> = {}): InteropProbes {
  return {
    platform: "linux",
    exists: () => false,
    runText: (command, args) => {
      const line = `${command} ${args.join(" ")}`;
      if (line === "cmd.exe /d /c set") return windowsSet;
      if (line === "cmd.exe /d /c where node.exe") return "C:\\nodejs\\node.exe";
      if (line === "cmd.exe /d /c pnpm root -g") return "C:\\pnpm\\global";
      return null;
    },
    ...overrides,
  };
}

test("Windows 环境：用 cmd set 的真实环境，并把 /mnt 配置翻译成 Windows 路径", () => {
  const result = resolveWindowsEnvironment(
    {
      LCEDA_CONFIG: "/mnt/d/proj/lceda.json",
      LCEDA_ENV: "wsl2",
      LCEDA_CONNECT_HOME: "/root/.lceda-connect",
      LCEDA_PRO_EXE: "/mnt/d/Program Files/lceda-pro/lceda-pro.exe",
    },
    probes(),
  );
  expect(result.source).toBe("windows-set");
  expect(result.env.Path).toBe("C:\\Windows;C:\\Tools");
  expect(result.env.LCEDA_CONFIG).toBe("D:\\proj\\lceda.json");
  // Windows 子进程一律原生，不能被调用方的 wsl2 显式环境带偏。
  expect(result.env.LCEDA_ENV).toBe("windows-native");
  expect(result.env.LCEDA_PRO_EXE).toBe("D:\\Program Files\\lceda-pro\\lceda-pro.exe");
  expect(result.env.LCEDA_CONNECT_HOME).toBeUndefined();
  expect(result.warnings.join("\n")).toContain("WSL 内部路径");
  expect(result.warnings.join("\n")).toContain("windows-native");
  // Path/PATH 两种大小写都补齐，避免只读 PATH 的发现逻辑失效。
  expect(result.env.PATH).toBe("C:\\Windows;C:\\Tools");
  expect(result.env.Path).toBe("C:\\Windows;C:\\Tools");
});

test("LCEDA_ALLOWED_ROOTS 逐项翻译，纯 WSL 路径被移除", () => {
  const result = resolveWindowsEnvironment(
    { LCEDA_ALLOWED_ROOTS: "/mnt/d/work,/tmp/scratch" },
    probes(),
  );
  expect(result.env.LCEDA_ALLOWED_ROOTS).toBe("D:\\work");
  expect(result.warnings.join("\n")).toContain("/tmp/scratch");
});

test("resolveWindowsNode：where.exe 命中并给出双路径", () => {
  const node = resolveWindowsNode(
    {},
    probes({ exists: (file) => file === "/mnt/c/nodejs/node.exe" }),
  );
  expect(node).toEqual({
    wslPath: "/mnt/c/nodejs/node.exe",
    winPath: "C:\\nodejs\\node.exe",
    source: "where.exe node",
  });
});

test("resolveWindowsMcpEntry：pnpm 全局 root 命中安装入口", () => {
  const entry = resolveWindowsMcpEntry(
    { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
    probes({
      exists: (file) => file === "/mnt/c/pnpm/global/lceda-connect/dist/cli-mcp.mjs",
    }),
  );
  expect(entry?.winPath).toBe("C:\\pnpm\\global\\lceda-connect\\dist\\cli-mcp.mjs");
  expect(entry?.source).toContain("C:\\pnpm\\global");
});

test("resolveWindowsMcpEntry：兼容 pnpm v11 的 hash 全局布局", () => {
  const entry = resolveWindowsMcpEntry(
    {},
    probes({
      exists: (file) =>
        file === "/mnt/c/pnpm/global/v11/b384-hash/node_modules/lceda-connect/dist/cli-mcp.mjs",
      listDir: (dir) => (dir === "/mnt/c/pnpm/global/v11" ? ["b384-hash", "8130-hash"] : null),
      runText: (command, args) => {
        if (command === "cmd.exe" && args.join(" ") === "/d /c pnpm root -g") {
          return "C:\\pnpm\\global\\v11";
        }
        if (command === "cmd.exe" && args.join(" ") === "/d /c set") return windowsSet;
        return null;
      },
    }),
  );
  expect(entry?.winPath).toBe(
    "C:\\pnpm\\global\\v11\\b384-hash\\node_modules\\lceda-connect\\dist\\cli-mcp.mjs",
  );
});

test("resolveWindowsMcpEntry：显式 --script 优先，缺失返回 null", () => {
  const hit = resolveWindowsMcpEntry(
    {},
    probes({ exists: (file) => file === "/mnt/e/custom/cli-mcp.mjs" }),
    "E:\\custom\\cli-mcp.mjs",
  );
  expect(hit?.winPath).toBe("E:\\custom\\cli-mcp.mjs");
  expect(
    resolveWindowsMcpEntry({}, probes({ exists: () => false }), "E:\\nope\\cli-mcp.mjs"),
  ).toBeNull();
});

test("normalizeMcpEnv：只有 Windows + WSL 标记时才换环境", () => {
  const untouched = normalizeMcpEnv({ LCEDA_ENV: "wsl2" }, probes({ platform: "linux" }));
  expect(untouched.env.LCEDA_ENV).toBe("wsl2");
  expect(untouched.warnings).toEqual([]);

  const replaced = normalizeMcpEnv(
    { WSL_INTEROP: "/run/WSL/1_interop", LCEDA_ENV: "wsl2" },
    probes({ platform: "win32" }),
  );
  expect(replaced.env.Path).toContain("C:\\Windows");
  expect(replaced.env.LCEDA_ENV).toBe("windows-native");
});

test("resolveWslFacingHost：WSL 取 eth0，Windows 取 WSL 默认网关", () => {
  const inWsl = resolveWslFacingHost(
    {},
    probes({
      platform: "linux",
      interfaces: () => ({
        lo: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "127.0.0.1/8",
          },
        ],
        eth0: [
          {
            address: "172.18.230.36",
            netmask: "255.255.240.0",
            family: "IPv4",
            mac: "00:15:5d:00:00:00",
            internal: false,
            cidr: "172.18.230.36/20",
          },
        ],
      }),
    }),
  );
  expect(inWsl?.host).toBe("172.18.230.36");

  const onWindows = resolveWslFacingHost(
    {},
    probes({
      platform: "win32",
      runText: (command) => (command === "wsl.exe" ? "172.18.224.1\n" : null),
    }),
  );
  expect(onWindows?.host).toBe("172.18.224.1");
});
