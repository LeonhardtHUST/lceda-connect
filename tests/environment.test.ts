import { expect, test } from "vite-plus/test";

import { requireAllowedHost } from "../src/cdp/discover.ts";
import { loadConfig } from "../src/core/config.ts";
import {
  cdpProbeHosts,
  describeEnvironment,
  detectEnvironment,
  hostOverrideWarning,
  liveStrategy,
  normalizeEnvironmentKind,
  parseClientLocations,
  parseNetworkingMode,
  parseResolvNameserver,
  parseRouteGateway,
  windowsPathToWslPath,
  wslPathToWindowsPath,
} from "../src/core/environment.ts";

const ROUTE_TABLE = [
  "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
  "eth0\t00000000\t01E012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
  "eth0\t00E012AC\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0",
].join("\n");

function wslProbes(
  overrides: {
    networkingMode?: string | null;
    route?: string | null;
    resolv?: string | null;
  } = {},
) {
  return {
    platform: "linux" as const,
    env: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
    readText: (file: string): string | null => {
      if (file === "/proc/sys/kernel/osrelease") return "6.18.58.1-microsoft-standard-WSL2";
      if (file === "/proc/version") return "Linux version 6.18.58.1-microsoft-standard-WSL2";
      if (file === "/proc/net/route")
        return overrides.route === undefined ? ROUTE_TABLE : overrides.route;
      if (file === "/etc/resolv.conf") return overrides.resolv ?? "nameserver 10.255.255.254\n";
      return null;
    },
    runText: (command: string): string | null =>
      command === "wslinfo"
        ? overrides.networkingMode === undefined
          ? "nat"
          : overrides.networkingMode
        : null,
  };
}

test("自动发现 windows-native / macos-native / linux-native", () => {
  expect(detectEnvironment({ probes: { platform: "win32" }, cache: false }).kind).toBe(
    "windows-native",
  );
  expect(detectEnvironment({ probes: { platform: "darwin" }, cache: false }).kind).toBe(
    "macos-native",
  );
  const linux = detectEnvironment({
    probes: {
      platform: "linux",
      env: {},
      readText: (file) => (file === "/proc/sys/kernel/osrelease" ? "6.8.0-45-generic" : null),
      runText: () => null,
    },
    cache: false,
  });
  expect(linux.kind).toBe("linux-native");
  expect(linux.hostOs).toBe("linux");
  expect(linux.windowsHost).toBeNull();
});

test("WSL2 自动发现：NAT 用默认网关当宿主地址，mirrored 用回环", () => {
  const nat = detectEnvironment({ probes: wslProbes(), cache: false });
  expect(nat.kind).toBe("wsl2");
  expect(nat.hostOs).toBe("windows");
  expect(nat.distro).toBe("Ubuntu-24.04");
  expect(nat.networkingMode).toBe("nat");
  expect(nat.windowsHost).toBe("172.18.224.1");
  expect(nat.clientLocations).toEqual(["host"]);
  expect(nat.clientLocationSource).toBe("default");
  expect(nat.warnings.join("\n")).toContain("WSL2 NAT");

  const mirrored = detectEnvironment({
    probes: wslProbes({ networkingMode: "mirrored" }),
    cache: false,
  });
  expect(mirrored.networkingMode).toBe("mirrored");
  expect(mirrored.windowsHost).toBe("127.0.0.1");
});

test("WSL2 无 wslinfo 时退回 resolv.conf 并给出警告；无路由时 windowsHost 可为 null", () => {
  const fallback = detectEnvironment({
    probes: wslProbes({ networkingMode: null, route: "" }),
    cache: false,
  });
  expect(fallback.networkingMode).toBe("unknown");
  expect(fallback.windowsHost).toBe("10.255.255.254");
  expect(fallback.warnings.join("\n")).toContain("resolv.conf");

  const none = detectEnvironment({
    probes: wslProbes({ networkingMode: null, route: "", resolv: "" }),
    cache: false,
  });
  expect(none.windowsHost).toBeNull();
});

test("显式环境不再自动发现，且与平台不一致时给警告", () => {
  const explicit = detectEnvironment({
    kind: "wsl2",
    kindSource: "config-file",
    windowsHost: "172.18.224.1",
    clientLocations: "vm,host",
    clientLocationSource: "argv",
    probes: wslProbes({ networkingMode: "mirrored" }),
    cache: false,
  });
  expect(explicit.explicit).toBe(true);
  expect(explicit.source).toBe("config-file");
  expect(explicit.windowsHost).toBe("172.18.224.1");
  expect(explicit.clientLocations).toEqual(["vm", "host"]);

  const mismatched = detectEnvironment({
    kind: "windows-native",
    probes: { platform: "linux", env: {}, readText: () => null, runText: () => null },
    cache: false,
  });
  expect(mismatched.kind).toBe("windows-native");
  expect(mismatched.warnings.join("\n")).toContain("不一致");
});

test("客户端位置：非法/重复项被过滤，非 WSL2 忽略 vm", () => {
  expect(parseClientLocations("vm,host,vm").locations).toEqual(["vm", "host"]);
  expect(parseClientLocations("host,VM ").locations).toEqual(["host", "vm"]);
  expect(parseClientLocations("docker").unknown).toEqual(["docker"]);

  const native = detectEnvironment({ probes: { platform: "win32" }, cache: false });
  const vm = detectEnvironment({
    kind: "windows-native",
    clientLocations: "vm",
    probes: { platform: "win32" },
    cache: false,
  });
  expect(native.clientLocations).toEqual(["host"]);
  expect(vm.clientLocations).toEqual(["host"]);
  expect(vm.warnings.join("\n")).toContain("vm");
});

test("探测地址按客户端位置优先级展开", () => {
  const nat = detectEnvironment({ probes: wslProbes(), cache: false });
  expect(cdpProbeHosts(nat)).toEqual(["172.18.224.1", "127.0.0.1"]);
  expect(cdpProbeHosts(nat, "172.18.224.1")).toEqual(["172.18.224.1"]);
  // 任意非回环地址不能突破边界，退回环境推导的地址。
  expect(cdpProbeHosts(nat, "10.0.0.5")).toEqual(["172.18.224.1", "127.0.0.1"]);

  const vmFirst = detectEnvironment({
    probes: wslProbes(),
    clientLocations: "vm,host",
    cache: false,
  });
  expect(cdpProbeHosts(vmFirst)).toEqual(["127.0.0.1", "172.18.224.1"]);

  const mirrored = detectEnvironment({
    probes: wslProbes({ networkingMode: "mirrored" }),
    cache: false,
  });
  expect(cdpProbeHosts(mirrored)).toEqual(["127.0.0.1"]);
});

test("liveStrategy 标明跨 OS 不可达与下一步", () => {
  const nat = detectEnvironment({ probes: wslProbes(), cache: false });
  const strategy = liveStrategy(nat);
  expect(strategy.loopbackReachable).toBe(false);
  expect(strategy.locations[0]?.bridgeReachable).toBe(false);
  expect(strategy.nextAction).toContain("Windows");

  const vm = detectEnvironment({
    probes: wslProbes(),
    clientLocations: "vm",
    cache: false,
  });
  expect(liveStrategy(vm).loopbackReachable).toBe(true);

  const mirrored = detectEnvironment({
    probes: wslProbes({ networkingMode: "mirrored" }),
    cache: false,
  });
  expect(liveStrategy(mirrored).locations[0]?.bridgeReachable).toBe(true);
});

test("路径转换与网关/nameserver 解析的边界", () => {
  expect(windowsPathToWslPath("D:\\Program Files\\lceda-pro\\lceda-pro.exe")).toBe(
    "/mnt/d/Program Files/lceda-pro/lceda-pro.exe",
  );
  expect(windowsPathToWslPath("c:/tools/lceda-pro.exe")).toBe("/mnt/c/tools/lceda-pro.exe");
  expect(windowsPathToWslPath("\\\\server\\share\\x.exe")).toBe("//server/share/x.exe");
  expect(windowsPathToWslPath("/usr/bin/lceda-pro")).toBe("/usr/bin/lceda-pro");
  expect(wslPathToWindowsPath("/mnt/d/Program Files/lceda-pro/lceda-pro.exe")).toBe(
    "D:\\Program Files\\lceda-pro\\lceda-pro.exe",
  );
  expect(wslPathToWindowsPath("/opt/lceda-pro")).toBeNull();

  expect(parseRouteGateway(ROUTE_TABLE)).toBe("172.18.224.1");
  expect(parseRouteGateway("")).toBeNull();
  expect(parseResolvNameserver("# x\nnameserver 10.255.255.254\n")).toBe("10.255.255.254");
  expect(parseResolvNameserver("search local")).toBeNull();
  expect(parseNetworkingMode("Mirrored\n")).toBe("mirrored");
  expect(parseNetworkingMode("bridge")).toBe("unknown");
  expect(normalizeEnvironmentKind("WSL2")).toBe("wsl2");
  expect(normalizeEnvironmentKind("auto")).toBeNull();
  expect(normalizeEnvironmentKind("plan9")).toBeNull();
});

test("显式探测地址越界时给出可操作警告；允许列表只放行回环/宿主地址", () => {
  const nat = detectEnvironment({ probes: wslProbes(), cache: false });
  expect(hostOverrideWarning(nat, null, "CDP 探测地址")).toBeNull();
  expect(hostOverrideWarning(nat, "127.0.0.1", "CDP 探测地址")).toBeNull();
  expect(hostOverrideWarning(nat, "172.18.224.1", "CDP 探测地址")).toBeNull();
  expect(hostOverrideWarning(nat, "10.0.0.5", "CDP 探测地址")).toContain("不在允许范围");

  expect(() => requireAllowedHost("10.0.0.5", [])).toThrow(/拒绝连接 10\.0\.0\.5/);
  expect(() => requireAllowedHost("10.0.0.5", ["10.0.0.5"])).not.toThrow();
  expect(() => requireAllowedHost("127.0.0.1", [])).not.toThrow();
});

test("loadConfig 把越界的显式 host 变成 warning，并退回环境推导地址", () => {
  const cfg = loadConfig(
    { LCEDA_CDP_HOST: "10.0.0.5", LCEDA_BRIDGE_HOST: "192.168.1.9" },
    {},
    {
      detect: {
        kind: "wsl2",
        windowsHost: "172.18.224.1",
        clientLocations: "host",
        probes: {
          platform: "linux",
          env: {},
          readText: (file) =>
            file === "/proc/sys/kernel/osrelease" ? "6.18-microsoft-standard-WSL2" : null,
          runText: () => "nat",
        },
        cache: false,
      },
    },
  );
  expect(cfg.cdp.hosts).toEqual(["172.18.224.1", "127.0.0.1"]);
  expect(cfg.bridge.host).toBe("127.0.0.1");
  expect(cfg.environment.warnings.join("\n")).toContain("不在允许范围");
});

test("describeEnvironment 汇总关键字段", () => {
  const nat = detectEnvironment({ probes: wslProbes(), cache: false });
  const text = describeEnvironment(nat);
  expect(text).toContain("wsl2");
  expect(text).toContain("net=nat");
  expect(text).toContain("windowsHost=172.18.224.1");
  expect(text).toContain("lceda=host");
});
