import { createServer, type Server } from "node:http";

import { expect, test } from "vite-plus/test";

import { detectEnvironment, liveStrategy } from "../src/core/environment.ts";
import {
  checkEnvironment,
  identifyCdpApplication,
  probeCdpChannel,
  type EnvironmentReport,
} from "../src/eda/channels.ts";

const missingBridge = async () => ({
  id: "bridge-probe",
  status: "missing" as const,
  reason_code: "service_absent",
  detail: "",
  hint: "",
});

const missingCdp = async () => ({
  id: "cdp-endpoint",
  status: "missing" as const,
  reason_code: "service_unavailable",
  detail: "",
  hint: "",
});

const readyCdp = async () => ({
  id: "cdp-endpoint",
  status: "ready" as const,
  reason_code: "ok",
  detail: "127.0.0.1:9222 · test",
  hint: "",
  version: { browser: "EasyEDA/4.1", protocol: "1.3", uuid: "uuid-1" },
});

const readyBridge = async () => ({
  id: "bridge-probe",
  status: "ready" as const,
  reason_code: "ok",
  detail: "127.0.0.1:49620 · 1 个窗口",
  hint: "",
  port: 49620,
  windows: 1,
});

function wslEnvironment(clientLocations: string) {
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

test("WSL2 NAT + 客户端在宿主：两条通道都不可用时给 cross_os_loopback 与可执行建议", async () => {
  const environment = wslEnvironment("host");
  const report: EnvironmentReport = await checkEnvironment({
    env: {},
    environment,
    strategy: liveStrategy(environment),
    probeBridge: missingBridge,
    probeCdp: missingCdp,
  });
  expect(report.channel_state).toBe("none");
  expect(report.status).toBe("needs_setup");
  expect(report.environment?.kind).toBe("wsl2");
  expect(report.environment?.windowsHost).toBe("172.18.224.1");
  expect(report.environment?.clientLocations).toEqual(["host"]);
  const session = report.checks.find((check) => check.id === "client-session");
  expect(session?.reason_code).toBe("cross_os_loopback");
  expect(report.next_action).toContain("Windows");
  expect(report.live_strategy?.locations[0]?.bridgeReachable).toBe(false);
  expect(report.functional_degradations.join("\n")).toContain("WSL2");
});

test("WSL2 + 客户端在 VM：CDP 可用即 partial，且不报跨 OS", async () => {
  const environment = wslEnvironment("vm");
  const report = await checkEnvironment({
    env: {},
    environment,
    strategy: liveStrategy(environment),
    probeBridge: missingBridge,
    probeCdp: readyCdp,
  });
  expect(report.channel_state).toBe("cdp-only");
  expect(report.status).toBe("partial");
  expect(report.checks.find((check) => check.id === "client-session")?.reason_code).toBe("ok");
  expect(report.functional_degradations.join("\n")).not.toContain("WSL2 NAT");
});

test("同 OS 双通道可用：ready，并带环境与客户端路径块", async () => {
  const environment = detectEnvironment({ probes: { platform: "win32" }, cache: false });
  const report = await checkEnvironment({
    env: {},
    environment,
    strategy: liveStrategy(environment),
    probeBridge: readyBridge,
    probeCdp: readyCdp,
    clientExe: {
      status: "discovered",
      path: "C:\\Program Files\\lceda-pro\\lceda-pro.exe",
      hostPath: "C:\\Program Files\\lceda-pro\\lceda-pro.exe",
      source: "Program Files",
      location: "host",
      candidates: [],
      warnings: [],
      environment: "windows-native",
    },
  });
  expect(report.status).toBe("ready");
  expect(report.channel_state).toBe("both");
  expect(report.environment?.kind).toBe("windows-native");
  expect(report.client_exe).toMatchObject({
    status: "discovered",
    path: "C:\\Program Files\\lceda-pro\\lceda-pro.exe",
  });
  expect(report.next_action).toContain("两条通道");
});

test("CDP 应用识别：EasyEDA 标题/URL 命中，思源笔记判为 wrong_application", async () => {
  expect(identifyCdpApplication([{ title: "工作空间 - 思源笔记", url: "file:///app" }])).toEqual({
    match: false,
    sample: "工作空间 - 思源笔记",
  });
  expect(
    identifyCdpApplication([{ title: "blink | 嘉立创EDA(专业版)", url: "https://client/editor" }]),
  ).toMatchObject({ match: true });
  expect(identifyCdpApplication([])).toBeNull();

  const startFake = async (titles: string[]): Promise<{ server: Server; port: number }> => {
    const server = createServer((request, response) => {
      if (request.url === "/json/version") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            Browser: "Chrome/158.0.0.0",
            "Protocol-Version": "1.3",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/fake",
          }),
        );
        return;
      }
      if (request.url === "/json/list") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            titles.map((title, index) => ({
              id: String(index),
              type: "page",
              title,
              url: "file:///app",
            })),
          ),
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return { server, port };
  };

  const fakeSiYuan = await startFake(["工作空间 - 思源笔记"]);
  try {
    const check = await probeCdpChannel({
      host: "127.0.0.1",
      port: fakeSiYuan.port,
      env: {},
      timeoutMs: 800,
    });
    expect(check.status).toBe("partial");
    expect(check.reason_code).toBe("wrong_application");
    expect(check.detail).toContain("思源笔记");
  } finally {
    await new Promise<void>((resolve) => fakeSiYuan.server.close(() => resolve()));
  }

  const fakeEda = await startFake(["blink | 嘉立创EDA(专业版)"]);
  try {
    const check = await probeCdpChannel({
      host: "127.0.0.1",
      port: fakeEda.port,
      env: {},
      timeoutMs: 800,
    });
    expect(check.status).toBe("ready");
  } finally {
    await new Promise<void>((resolve) => fakeEda.server.close(() => resolve()));
  }
});

test("不传环境时保持旧口径：只探测回环", async () => {
  const report = await checkEnvironment({
    env: {},
    probeBridge: missingBridge,
    probeCdp: missingCdp,
  });
  expect(report.channel_state).toBe("none");
  expect(report.environment).toBeUndefined();
  expect(report.checks.find((check) => check.id === "environment")).toBeUndefined();
  expect(report.next_action).toContain("先搭一条通道");
});
