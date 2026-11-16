import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import {
  PROXY_ENV_NAMES,
  buildStartArgs,
  clearProxyEnvironment,
  debugFlagRows,
  exeMatches,
  formatDebugFlagRows,
  listDevToolsActivePortFiles,
  mainInstancePids,
  parsePidRecord,
  readManagedPidFile,
  readPidRecord,
  stalePidFile,
  writePidRecord,
} from "../src/commands/cdp.ts";
import { parseDevToolsActivePort } from "../src/core/netprobe.ts";
import type { ProcInfo } from "../src/core/types.ts";

// 只测纯逻辑：临时目录 + 内存 env，不启动客户端、不结束任何进程。

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lceda-connect-cdp-"));
}

function proc(pid: number, commandLine: string): ProcInfo {
  return { pid, name: "lceda-pro.exe", commandLine };
}

// ─── pid 文件读写与 exe 校验 ────────────────────────────────────────

test("parsePidRecord 解析两行式 pid 文件并容忍 BOM / CRLF", () => {
  expect(parsePidRecord("\uFEFF12345\r\nD:\\Tools\\lceda-pro.exe\r\n")).toEqual({
    pid: 12345,
    exe: "D:\\Tools\\lceda-pro.exe",
  });
  // 只有 pid 行也认（旧脚本 lines.Count -ge 2 才读 exe）
  expect(parsePidRecord("44012\n")).toEqual({ pid: 44012, exe: "" });
  expect(parsePidRecord("")).toBeNull();
  expect(parsePidRecord("\n\n")).toBeNull();
  expect(parsePidRecord("not-a-pid\nD:\\x.exe")).toBeNull();
  expect(parsePidRecord("0\nD:\\x.exe")).toBeNull();
  expect(parsePidRecord("-5\nD:\\x.exe")).toBeNull();
});

test("writePidRecord / readPidRecord 往返，文件就是两行", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "nested", "lceda-cdp.pid");
    writePidRecord(file, { pid: 44216, exe: "D:\\Program Files\\lceda-pro\\lceda-pro.exe" });
    // 目录会被自动建出来
    expect(
      fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter((line) => line !== ""),
    ).toEqual(["44216", "D:\\Program Files\\lceda-pro\\lceda-pro.exe"]);
    expect(readPidRecord(file)).toEqual({
      pid: 44216,
      exe: "D:\\Program Files\\lceda-pro\\lceda-pro.exe",
    });
    expect(readPidRecord(path.join(dir, "missing.pid"))).toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readManagedPidFile 优先新路径，其次只读兼容旧路径", () => {
  const dir = tempDir();
  try {
    const pidFile = path.join(dir, "new.pid");
    const legacyPidFile = path.join(dir, "legacy.pid");

    // 两个都没有 → 没有受管实例
    expect(readManagedPidFile({ pidFile, legacyPidFile })).toBeNull();

    // 只有旧文件 → 按旧记录恢复，写回仍走新路径（这里只验证读取来源）
    writePidRecord(legacyPidFile, { pid: 111, exe: "D:\\legacy\\lceda-pro.exe" });
    expect(readManagedPidFile({ pidFile, legacyPidFile })).toEqual({
      record: { pid: 111, exe: "D:\\legacy\\lceda-pro.exe" },
      source: "legacy",
      file: legacyPidFile,
    });

    // 新文件存在则优先，旧文件被忽略
    writePidRecord(pidFile, { pid: 222, exe: "D:\\new\\lceda-pro.exe" });
    expect(readManagedPidFile({ pidFile, legacyPidFile })).toEqual({
      record: { pid: 222, exe: "D:\\new\\lceda-pro.exe" },
      source: "current",
      file: pidFile,
    });

    // 新文件在但解析不出来 → 视为没有受管实例，不回落旧文件
    fs.writeFileSync(pidFile, "garbage\n", "utf8");
    expect(readManagedPidFile({ pidFile, legacyPidFile })).toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stalePidFile 只报存在的文件，新路径优先", () => {
  const dir = tempDir();
  try {
    const pidFile = path.join(dir, "new.pid");
    const legacyPidFile = path.join(dir, "legacy.pid");
    expect(stalePidFile({ pidFile, legacyPidFile })).toBeNull();
    fs.writeFileSync(legacyPidFile, "111\nD:\\legacy\\lceda-pro.exe\n", "utf8");
    expect(stalePidFile({ pidFile, legacyPidFile })).toBe(legacyPidFile);
    fs.writeFileSync(pidFile, "222\nD:\\new\\lceda-pro.exe\n", "utf8");
    expect(stalePidFile({ pidFile, legacyPidFile })).toBe(pidFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("exeMatches 大小写/斜杠不敏感，读不到镜像路径时不误判", () => {
  const recorded = "D:\\Program Files\\lceda-pro\\lceda-pro.exe";
  expect(exeMatches(recorded, recorded)).toBe(true);
  expect(exeMatches(recorded.toLowerCase(), recorded)).toBe(true);
  expect(exeMatches("d:/program files/lceda-pro/lceda-pro.exe", recorded)).toBe(true);
  // 真的换了进程（PID 复用）→ 不一致
  expect(exeMatches("C:\\Windows\\System32\\notepad.exe", recorded)).toBe(false);
  // 读不到镜像路径（权限不足）或记录里没有 exe → 不断言不一致
  expect(exeMatches(null, recorded)).toBe(true);
  expect(exeMatches(recorded, "")).toBe(true);
});

// ─── 代理环境变量 ──────────────────────────────────────────────────

test("clearProxyEnvironment 清掉五个代理变量并逐条回显，不动别的变量和真实 process.env", () => {
  const env: NodeJS.ProcessEnv = {
    HTTP_PROXY: "http://127.0.0.1:25133",
    https_proxy: "http://127.0.0.1:7897",
    All_Proxy: "socks5://127.0.0.1:1080",
    ftp_proxy: "http://127.0.0.1:8080",
    no_proxy: "localhost,127.0.0.1",
    PATH: "C:\\Windows",
    LCEDA_CDP_PORT: "9222",
  };
  const before = process.env.HTTP_PROXY;

  const cleared = clearProxyEnvironment(env);

  // 逐条回显（大小写按原样），且五个都清掉了
  expect(cleared.sort()).toEqual(
    [
      "HTTP_PROXY=http://127.0.0.1:25133",
      "https_proxy=http://127.0.0.1:7897",
      "All_Proxy=socks5://127.0.0.1:1080",
      "ftp_proxy=http://127.0.0.1:8080",
      "no_proxy=localhost,127.0.0.1",
    ].sort(),
  );
  for (const name of PROXY_ENV_NAMES) {
    const key = Object.keys(env).find((item) => item.toLowerCase() === name);
    expect(key).toBeUndefined();
  }
  // 非代理变量原样保留
  expect(env.PATH).toBe("C:\\Windows");
  expect(env.LCEDA_CDP_PORT).toBe("9222");
  // 传进去的是自己的对象，真实进程环境不受影响
  expect(process.env.HTTP_PROXY).toBe(before);
});

test("clearProxyEnvironment 在没有代理变量时返回空数组", () => {
  const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
  expect(clearProxyEnvironment(env)).toEqual([]);
  expect(env.PATH).toBe("C:\\Windows");
});

// ─── 启动参数顺序 ──────────────────────────────────────────────────

test("buildStartArgs 端口必须第一位，绑地址第二，代理最后", () => {
  expect(buildStartArgs(9222, "127.0.0.1")).toEqual([
    "--remote-debugging-port=9222",
    "--remote-debugging-address=127.0.0.1",
  ]);
  expect(buildStartArgs(9222, "127.0.0.1", "http://127.0.0.1:7897")).toEqual([
    "--remote-debugging-port=9222",
    "--remote-debugging-address=127.0.0.1",
    "--proxy-server=http://127.0.0.1:7897",
  ]);
  // 显式空串等于没给
  expect(buildStartArgs(0, "127.0.0.1", "")).toEqual([
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
  ]);
});

// ─── 主进程筛选 ────────────────────────────────────────────────────

test("mainInstancePids 排除 --type= 子进程", () => {
  const processes = [
    proc(100, '"D:\\lceda-pro\\lceda-pro.exe" --remote-debugging-port=9222'),
    proc(101, '"D:\\lceda-pro\\lceda-pro.exe" --type=renderer --remote-debugging-port=9222'),
    proc(102, '"D:\\lceda-pro\\lceda-pro.exe" --type=gpu-process'),
  ];
  expect(mainInstancePids(processes)).toEqual([100]);
});

test("mainInstancePids 认不出主进程时退回全部 pid，空列表返回空", () => {
  const onlyChildren = [proc(201, '"D:\\lceda-pro\\lceda-pro.exe" --type=renderer'), proc(202, "")];
  expect(mainInstancePids(onlyChildren)).toEqual([201, 202]);
  expect(mainInstancePids([])).toEqual([]);
});

test("debugFlagRows 只统计带 --remote-debugging-port 的主实例", () => {
  const processes = [
    proc(
      300,
      '"D:\\lceda-pro\\lceda-pro.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1',
    ),
    // 子进程即便带了端口也不算主实例
    proc(301, '"D:\\lceda-pro\\lceda-pro.exe" --type=renderer --remote-debugging-port=9222'),
    // 没带调试参数（图标启动 / 自重启丢参）
    proc(302, '"D:\\lceda-pro\\lceda-pro.exe"'),
    // 动态端口
    proc(303, '"D:\\lceda-pro\\lceda-pro.exe" --remote-debugging-port=0'),
    // 命令行拿不到
    proc(304, ""),
  ];
  const rows = debugFlagRows(processes);
  expect(rows).toEqual([
    { pid: 300, port: 9222 },
    { pid: 303, port: 0 },
  ]);
  expect(formatDebugFlagRows(rows)).toBe("PID 300→9222, PID 303→动态");
  expect(formatDebugFlagRows([])).toBe("");
});

// ─── DevToolsActivePort 扫描 ───────────────────────────────────────

test("listDevToolsActivePortFiles 只扫 LCEDA/EasyEDA 目录下的 cache.*", () => {
  const localAppData = tempDir();
  try {
    const writePort = (relDir: string, content: string): string => {
      const dir = path.join(localAppData, relDir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "DevToolsActivePort");
      fs.writeFileSync(file, content, "utf8");
      return file;
    };

    const lcedaPort = writePort(
      path.join("LCEDA Pro", "cache.1770000000000"),
      "9222\n/devtools/browser/abc\n",
    );
    const easyedaPort = writePort(
      path.join("EasyEDA", "cache.42"),
      "9333\n/devtools/browser/def\n",
    );
    // 大小写不同也算（旧脚本 -match 不区分大小写）
    const lowerCaseRoot = writePort(
      path.join("Lceda-Lower", "Cache.7"),
      "9444\n/devtools/browser/ghi\n",
    );
    // 目录名不匹配 → 不扫
    writePort(path.join("SomeVendor", "cache.1"), "9555\n/devtools/browser/x\n");
    // cache 目录名不匹配 → 不扫
    writePort(path.join("LCEDA Pro", "config"), "9666\n/devtools/browser/y\n");

    const files = listDevToolsActivePortFiles(localAppData).sort();
    expect(files).toEqual([easyedaPort, lcedaPort, lowerCaseRoot].sort());

    // 每个文件的端口都能被 core 的解析器读出来
    const ports = files
      .map((file) => parseDevToolsActivePort(fs.readFileSync(file, "utf8")))
      .sort((left, right) => left - right);
    expect(ports).toEqual([9222, 9333, 9444]);

    // 空 / 不存在的根目录返回空数组
    expect(listDevToolsActivePortFiles("")).toEqual([]);
    expect(listDevToolsActivePortFiles(path.join(localAppData, "missing-root"))).toEqual([]);
  } finally {
    fs.rmSync(localAppData, { recursive: true, force: true });
  }
});
