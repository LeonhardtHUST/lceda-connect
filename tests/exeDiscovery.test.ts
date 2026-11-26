import { expect, test } from "vite-plus/test";

import { detectEnvironment, type EnvironmentInfo } from "../src/core/environment.ts";
import {
  clientExeCandidates,
  discoverClientExe,
  discoverClientExePlan,
  normalizeExplicitExe,
} from "../src/core/exeDiscovery.ts";

function environmentOf(
  platform: NodeJS.Platform,
  extra: Record<string, string> = {},
): EnvironmentInfo {
  return detectEnvironment({
    probes: { platform, env: extra, readText: () => null, runText: () => null },
    cache: false,
  });
}

const WINDOWS = environmentOf("win32");
const MACOS = environmentOf("darwin");
const LINUX = environmentOf("linux", {});

function wslEnvironment(clientLocations: string): EnvironmentInfo {
  return detectEnvironment({
    kind: "wsl2",
    windowsHost: "172.18.224.1",
    clientLocations,
    probes: {
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
      readText: (file) =>
        file === "/proc/sys/kernel/osrelease"
          ? "6.18-microsoft-standard-WSL2"
          : file === "/proc/net/route"
            ? "Iface Destination Gateway Flags\neth0 00000000 01E012AC 0003"
            : null,
      runText: () => "nat",
    },
    cache: false,
  });
}

const WSL_HOST = wslEnvironment("host");
const WSL_VM = wslEnvironment("vm");

test("Windows 候选来自 Program Files / LOCALAPPDATA / PATH", () => {
  const paths = clientExeCandidates(WINDOWS, {
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    PATH: "C:\\Tools;C:\\Program Files\\lceda-pro",
  }).map((candidate) => candidate.path);
  expect(paths).toContain("C:\\Program Files\\lceda-pro\\lceda-pro.exe");
  expect(paths).toContain("C:\\Program Files (x86)\\lceda-pro\\lceda-pro.exe");
  expect(paths).toContain("C:\\Users\\u\\AppData\\Local\\Programs\\lceda-pro\\lceda-pro.exe");
  expect(paths).toContain("C:\\Tools\\lceda-pro.exe");
});

test("WSL2 + host 用 /mnt 路径；WSL2 + vm 用 POSIX 路径", () => {
  const env = {
    PATH: "/mnt/d/Program Files/lceda-pro:/usr/local/bin",
    HOME: "/home/leon",
  };
  const hostPaths = clientExeCandidates(WSL_HOST, env, "host").map((item) => item.path);
  expect(hostPaths[0]).toBe("/mnt/d/Program Files/lceda-pro/lceda-pro.exe");
  expect(hostPaths).toContain("/mnt/c/Program Files/lceda-pro/lceda-pro.exe");

  const vmPaths = clientExeCandidates(WSL_VM, env, "vm").map((item) => item.path);
  // /mnt 下的是 Windows 可执行文件，属于「客户端在宿主」，不能算 VM 内客户端。
  expect(vmPaths.some((item) => item.startsWith("/mnt/"))).toBe(false);
  expect(vmPaths).toContain("/usr/local/bin/lceda-pro");
  expect(vmPaths).toContain("/home/leon/.local/bin/lceda-pro");
});

test("Linux / macOS 候选", () => {
  const linuxPaths = clientExeCandidates(LINUX, {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/leon",
  }).map((item) => item.path);
  expect(linuxPaths).toContain("/usr/local/bin/lceda-pro");
  expect(linuxPaths).toContain("/opt/lceda-pro/lceda-pro");

  const macPaths = clientExeCandidates(MACOS, { HOME: "/Users/leon" }).map((item) => item.path);
  expect(macPaths).toContain("/Applications/lceda-pro.app/Contents/MacOS/lceda-pro");
});

test("显式路径：WSL2 host 自动把 Windows 路径转换成 /mnt；macOS .app 展开", () => {
  const wsl = normalizeExplicitExe("D:\\Program Files\\lceda-pro\\lceda-pro.exe", WSL_HOST, "host");
  expect(wsl.candidates).toEqual(["/mnt/d/Program Files/lceda-pro/lceda-pro.exe"]);
  expect(wsl.hostPath).toBe("D:\\Program Files\\lceda-pro\\lceda-pro.exe");

  const mac = normalizeExplicitExe("/Applications/lceda-pro.app", MACOS, "host");
  expect(mac.candidates).toContain("/Applications/lceda-pro.app/Contents/MacOS/lceda-pro");
});

test("显式路径找不到时不回退自动发现", () => {
  const result = discoverClientExe({
    environment: WSL_HOST,
    location: "host",
    env: { PATH: "/mnt/d/Program Files/lceda-pro" },
    explicitPath: "/mnt/z/typo/lceda-pro.exe",
    exists: (file) => file === "/mnt/d/Program Files/lceda-pro/lceda-pro.exe",
  });
  expect(result.status).toBe("explicit_missing");
  expect(result.path).toBeNull();
  expect(result.candidates).toHaveLength(1);
  expect(result.warnings.join("\n")).toContain("不存在");
});

test("自动发现命中的候选带来源与 hostPath", () => {
  const result = discoverClientExe({
    environment: WSL_HOST,
    location: "host",
    env: { PATH: "/mnt/d/Program Files/lceda-pro" },
    exists: (file) => file === "/mnt/d/Program Files/lceda-pro/lceda-pro.exe",
  });
  expect(result.status).toBe("discovered");
  expect(result.path).toBe("/mnt/d/Program Files/lceda-pro/lceda-pro.exe");
  expect(result.hostPath).toBe("D:\\Program Files\\lceda-pro\\lceda-pro.exe");
  expect(result.source).toBe("WSL PATH");
  expect(result.location).toBe("host");
});

test("全部候选都不存在时给出 not_found 与完整尝试记录", () => {
  const result = discoverClientExe({
    environment: WINDOWS,
    location: "host",
    env: { ProgramFiles: "C:\\Program Files", PATH: "C:\\Tools" },
    exists: () => false,
  });
  expect(result.status).toBe("not_found");
  expect(result.path).toBeNull();
  expect(result.candidates.length).toBeGreaterThan(0);
  expect(result.candidates.every((candidate) => candidate.exists === false)).toBe(true);
});

test("deep 模式用 Windows where.exe 找到并转换路径", () => {
  const result = discoverClientExe({
    environment: WSL_HOST,
    location: "host",
    env: { PATH: "" },
    exists: (file) => file === "/mnt/e/Apps/lceda-pro/lceda-pro.exe",
    deep: true,
    runText: (command) => (command === "cmd.exe" ? "E:\\Apps\\lceda-pro\\lceda-pro.exe" : null),
  });
  expect(result.status).toBe("discovered");
  expect(result.path).toBe("/mnt/e/Apps/lceda-pro/lceda-pro.exe");
  expect(result.source).toBe("Windows where.exe");
});

test("plan 按 vm → host 优先级，命中即停", () => {
  const vmHit = discoverClientExePlan({
    environment: WSL_VM,
    env: { PATH: "/usr/local/bin", HOME: "/home/leon" },
    exists: (file) => file === "/usr/local/bin/lceda-pro",
  });
  expect(vmHit.primary?.location).toBe("vm");
  expect(vmHit.locations).toHaveLength(1);

  const both = wslEnvironment("vm,host");
  const hostHit = discoverClientExePlan({
    environment: both,
    env: { PATH: "/usr/local/bin", HOME: "/home/leon" },
    exists: (file) => file === "/mnt/c/Program Files/lceda-pro/lceda-pro.exe",
  });
  expect(hostHit.locations.map((item) => item.location)).toEqual(["vm", "host"]);
  expect(hostHit.primary?.location).toBe("host");
  expect(hostHit.primary?.path).toBe("/mnt/c/Program Files/lceda-pro/lceda-pro.exe");
});
