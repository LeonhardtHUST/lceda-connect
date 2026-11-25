import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vite-plus/test";
import type { CdpSession } from "../src/cdp/session.ts";
import type { CdpTarget } from "../src/cdp/targets.ts";
import { crc32 } from "../src/epro2/zip.ts";
import { withStagedPackage } from "../src/extensions/cli.ts";
import {
  editorIdentityExpression,
  ExtensionManager,
  selectExtensionWindow,
  withExtensionManager,
  type ExtensionManagerHooks,
} from "../src/extensions/lifecycle.ts";
import { main } from "../src/main.ts";

const window = { port: 9222, target: "A".repeat(32), project: "b".repeat(64), pcb: "c".repeat(16) };
const title = "Disposable copy | 嘉立创EDA(专业版) - V4.1.105";
const href = `https://client/editor?cll=warn#id=${window.project},pcb=${window.pcb}`;
const target: CdpTarget = {
  id: window.target,
  type: "page",
  title,
  url: href,
  webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${window.target}`,
};
const context = {
  href,
  title,
  name: "local-probe",
  displayName: "Local probe",
  uuid: "d".repeat(32),
  version: "0.0.1",
};

test("target must match exact version, page id, URL identity and same loopback WebSocket", () => {
  expect(selectExtensionWindow([target], window)).toBe(target);
  expect(() => selectExtensionWindow([target, target], window)).toThrow();
  for (const bad of [
    { title: title.replace("4.1.105", "4.1.106") },
    { url: href.replace("client", "example.test") },
    { url: href.replace(window.pcb, window.pcb + "c") },
    { webSocketDebuggerUrl: target.webSocketDebuggerUrl!.replace(":9222", ":9223") },
    { webSocketDebuggerUrl: target.webSocketDebuggerUrl!.replace("127.0.0.1", "example.test") },
  ])
    expect(() => selectExtensionWindow([{ ...target, ...bad }], window)).toThrow();
});

test("host API readback independently requires active PCB and matching parent", async () => {
  const pcb = { uuid: window.pcb, parentProjectUuid: window.project, documentType: 3 };
  const evaluate = (document: typeof pcb, visibilityState = "visible") =>
    runInNewContext(editorIdentityExpression(window, href, title), {
      location: { href },
      document: { title, visibilityState },
      _EXTAPI_ROOT_: {
        dmt_Project: { getCurrentProjectInfo: () => ({ uuid: window.project }) },
        dmt_SelectControl: { getCurrentDocumentInfo: () => document },
      },
    });
  await expect(evaluate(pcb)).resolves.toBe(true);
  await expect(evaluate({ ...pcb, parentProjectUuid: "other" })).resolves.toBe(false);
  await expect(evaluate({ ...pcb, documentType: 1 })).resolves.toBe(false);
  await expect(evaluate(pcb, "hidden")).resolves.toBe(false);
});

function fakeSession(replies: unknown[]) {
  const call = vi.fn(async (_method: string, _params?: Record<string, unknown>) => {
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    session: { call: call as <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
    call,
  };
}

const ok = { result: { value: true } };
const input = { result: { objectId: "handle", subtype: "node" } };
const details = { result: { value: { enabled: true } } };
const settleCard = { result: { value: "card" } };
const settleNotice = { result: { value: "notice" } };

test("install sends exactly one input and reads manager state, not merely CDP success", async () => {
  const { session, call } = fakeSession([ok, ok, ok, input, {}, settleCard, ok, ok, details, {}]);
  const guard = vi.fn(async () => {});
  await expect(
    new ExtensionManager(session, context, guard).install("staged.eext"),
  ).resolves.toEqual({ enabled: true });
  expect(guard).toHaveBeenCalledOnce();
  expect(call.mock.calls.filter(([method]) => method === "DOM.setFileInputFiles")).toEqual([
    ["DOM.setFileInputFiles", { objectId: "handle", files: ["staged.eext"] }],
  ]);
  expect(call.mock.calls[3]?.[1]).toMatchObject({ returnByValue: false });
});

test("install 会点掉 4.1.105 的「安全提示」再回读安装结果", async () => {
  const { session, call } = fakeSession([
    ok,
    ok,
    ok,
    input,
    {},
    settleNotice,
    ok,
    ok,
    ok,
    details,
    {},
  ]);
  await expect(
    new ExtensionManager(session, context, async () => {}).install("staged.eext"),
  ).resolves.toEqual({ enabled: true });
  expect(call.mock.calls.filter(([method]) => method === "DOM.setFileInputFiles")).toHaveLength(1);
  // open/installed/empty/file-input/setFiles/settle/installed/refresh/card/details + releaseObject
  expect(call).toHaveBeenCalledTimes(11);
});

test("ambiguous file selection stops; a failed submission attempt is never retried", async () => {
  const invalid = fakeSession([ok, ok, ok, { result: { subtype: "object", objectId: "wrong" } }]);
  await expect(
    new ExtensionManager(invalid.session, context, async () => {}).install("staged.eext"),
  ).rejects.toThrow(/文件输入/);
  expect(invalid.call.mock.calls.some(([method]) => method === "DOM.setFileInputFiles")).toBe(
    false,
  );
  const remote = fakeSession([ok, ok, ok, input, new Error("lost reply"), {}]);
  await expect(
    new ExtensionManager(remote.session, context, async () => {}).install("staged.eext"),
  ).rejects.toThrow(/不要直接重试/);
  expect(
    remote.call.mock.calls.filter(([method]) => method === "DOM.setFileInputFiles"),
  ).toHaveLength(1);
});

test("uninstall is stopped if PCB guard changes before confirmation", async () => {
  const { session, call } = fakeSession([ok, ok, ok, details, ok, ok]);
  const guard = vi
    .fn(async () => {})
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("changed"));
  await expect(new ExtensionManager(session, context, guard).uninstall()).rejects.toThrow(/未确认/);
  expect(call).toHaveBeenCalledTimes(6);
  expect(guard).toHaveBeenCalledTimes(2);
});

const deleteArgs = [
  "extension",
  "uninstall",
  "--uuid",
  context.uuid,
  "--name",
  context.name,
  "--display-name",
  context.displayName,
  "--extension-version",
  context.version,
  "--target",
  window.target,
  "--port",
  "9222",
  "--project",
  window.project,
  "--pcb",
  window.pcb,
];

test("complete uninstall parameters still preview offline without --confirm", async () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network allowed"));
  try {
    expect(await main({ argv: [...deleteArgs, "--isolated-profile"], io })).toBe(0);
    expect(JSON.parse(io.out.mock.calls[0]?.[0])).toMatchObject({
      mode: "preview",
      connected: false,
      extension: { uuid: context.uuid },
      window,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await main({ argv: [...deleteArgs, "--confirm"], io })).toBe(1);
    expect(
      await main({ argv: [...deleteArgs, "--confirm", "--isolated-profile", "--headless"], io }),
    ).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

// ─── 离线夹具与可测性接缝 ───────────────────────────────────────────────

function tempDir(prefix = "lceda-extension-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 测试专用最小 `.eext`：唯一的 stored `extension.json`，足够通过离线预检。 */
function buildEext(overrides: Record<string, unknown> = {}): Buffer {
  const manifest = Buffer.from(
    JSON.stringify({
      name: context.name,
      displayName: context.displayName,
      uuid: context.uuid,
      version: context.version,
      ...overrides,
    }),
  );
  const name = Buffer.from("extension.json");
  const crc = crc32(manifest);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(manifest.length, 18);
  local.writeUInt32LE(manifest.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(manifest.length, 20);
  central.writeUInt32LE(manifest.length, 24);
  central.writeUInt16LE(name.length, 28);
  const offset = local.length + name.length + manifest.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([local, name, manifest, central, name, eocd]);
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writePackage(dir: string, overrides: Record<string, unknown> = {}) {
  const bytes = buildEext(overrides);
  const file = path.join(dir, "probe.eext");
  fs.writeFileSync(file, bytes);
  return { file, bytes, sha: sha256Of(bytes) };
}

function memoryIo() {
  return { out: vi.fn(), err: vi.fn() };
}

/** 只在当前测试内改写 `process.platform`，结束后恢复原描述符。 */
async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) throw new Error("process.platform 描述符缺失");
  Object.defineProperty(process, "platform", { configurable: true, get: () => platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

interface ManagerHooksOptions {
  payload?: unknown;
  ok?: boolean;
  probeHref?: string;
  replies?: unknown[];
  evaluate?: (attempt: number) => { value?: unknown };
}

/** `withExtensionManager` 的离线接缝：只替换 HTTP/WS 传输，语义仍由被测代码决定。 */
function fakeManagerHooks(options: ManagerHooksOptions = {}) {
  const requests: string[] = [];
  const connects: string[] = [];
  const evaluations: string[] = [];
  const replies = [...(options.replies ?? [])];
  let closes = 0;
  const call = vi.fn(async (_method: string, _params?: Record<string, unknown>) => {
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const session = {
    call: call as <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
    close: () => {
      closes += 1;
    },
  };
  const hooks: ExtensionManagerHooks = {
    fetch: async (url) => {
      requests.push(url);
      return { ok: options.ok ?? true, json: async () => options.payload };
    },
    connect: async (wsUrl) => {
      connects.push(wsUrl);
      return session as unknown as CdpSession;
    },
    probe: async () => ({ href: options.probeHref ?? href }),
    evaluate: async (_session, expression) => {
      evaluations.push(expression);
      return options.evaluate ? options.evaluate(evaluations.length) : { value: true };
    },
  };
  return { hooks, requests, connects, evaluations, session, call, closes: () => closes };
}

const windowArgs = [
  "--target",
  window.target,
  "--port",
  "9222",
  "--project",
  window.project,
  "--pcb",
  window.pcb,
];

// ─── CLI：inspect / install 预览 / headless / 平台 / SHA-256 ─────────────

test("inspect 与 install 预览完全离线，且预览不连接客户端", async () => {
  const dir = tempDir();
  const io = memoryIo();
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
  try {
    const pkg = writePackage(dir);
    expect(await main({ argv: ["extension", "inspect", "--file", pkg.file], io })).toBe(0);
    expect(JSON.parse(io.out.mock.calls[0]?.[0])).toMatchObject({
      sha256: pkg.sha,
      uuid: context.uuid,
      version: "0.0.1",
    });
    io.out.mockClear();
    const argv = [
      "extension",
      "install",
      "--file",
      pkg.file,
      "--sha256",
      pkg.sha,
      "--isolated-profile",
      ...windowArgs,
    ];
    expect(await main({ argv, io })).toBe(0);
    expect(JSON.parse(io.out.mock.calls[0]?.[0])).toMatchObject({
      mode: "preview",
      action: "install",
      connected: false,
      window,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("install 确认路径在 SHA-256 不匹配时于暂存与连接之前拒绝", async () => {
  const dir = tempDir();
  const io = memoryIo();
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
  try {
    const pkg = writePackage(dir);
    const argv = [
      "extension",
      "install",
      "--file",
      pkg.file,
      "--sha256",
      "0".repeat(64),
      "--isolated-profile",
      "--confirm",
      ...windowArgs,
    ];
    expect(await main({ argv, io })).toBe(1);
    expect(io.err).toHaveBeenCalledWith(expect.stringMatching(/SHA-256 不匹配/));
    expect(io.out).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // 拒绝后源包未被改写，仍可按原 SHA-256 重新预检。
    expect(sha256Of(fs.readFileSync(pkg.file))).toBe(pkg.sha);
  } finally {
    fetchSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("install --headless 在读取包与连接客户端之前拒绝", async () => {
  const io = memoryIo();
  const missing = path.join(os.tmpdir(), `lceda-missing-${process.pid}-${Date.now()}.eext`);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
  try {
    const argv = [
      "extension",
      "install",
      "--file",
      missing,
      "--isolated-profile",
      "--confirm",
      "--headless",
      ...windowArgs,
    ];
    expect(await main({ argv, io })).toBe(1);
    expect(io.err).toHaveBeenCalledWith(expect.stringMatching(/无头入口/));
    expect(io.out).not.toHaveBeenCalled();
    expect(fs.existsSync(missing)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});

test("非 win32 在暂存与连接之前拒绝确认安装", async () => {
  const dir = tempDir();
  const io = memoryIo();
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
  try {
    const pkg = writePackage(dir);
    const argv = [
      "extension",
      "install",
      "--file",
      pkg.file,
      "--sha256",
      pkg.sha,
      "--isolated-profile",
      "--confirm",
      ...windowArgs,
    ];
    expect(await withPlatform("linux", () => main({ argv, io }))).toBe(1);
    expect(io.err).toHaveBeenCalledWith(expect.stringMatching(/只支持 Windows/));
    expect(io.out).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── staging：内容、权限、清理 ─────────────────────────────────────────

test("withStagedPackage 只交付预检字节的私有副本，结束后清理目录", async () => {
  const dir = tempDir();
  try {
    const pkg = writePackage(dir);
    const stagedPaths: string[] = [];
    const result = await withStagedPackage(pkg.file, pkg.sha, async (staged) => {
      stagedPaths.push(staged);
      expect(staged).not.toBe(pkg.file);
      expect(staged.startsWith(path.join(os.tmpdir(), "lceda-extension-"))).toBe(true);
      expect(path.basename(staged)).toBe("package.eext");
      expect(fs.readFileSync(staged).equals(pkg.bytes)).toBe(true);
      if (process.platform !== "win32") expect(fs.statSync(staged).mode & 0o777).toBe(0o600);
      return "staged-ok";
    });
    expect(result).toBe("staged-ok");
    const staged = stagedPaths[0];
    if (!staged) throw new Error("未取得暂存路径");
    expect(fs.existsSync(staged)).toBe(false);
    expect(fs.existsSync(path.dirname(staged))).toBe(false);
    expect(fs.existsSync(pkg.file)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withStagedPackage 在预检后文件被换成另一个合法包时拒绝且不暂存", async () => {
  const dir = tempDir();
  try {
    const first = writePackage(dir, { version: "0.0.1" });
    writePackage(dir, { version: "0.0.2" });
    const run = vi.fn(async () => "unused");
    await expect(withStagedPackage(first.file, first.sha, run)).rejects.toThrow(/预检后发生变化/);
    expect(run).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withStagedPackage 在 run 抛错时仍清理暂存目录", async () => {
  const dir = tempDir();
  try {
    const pkg = writePackage(dir);
    const stagedPaths: string[] = [];
    await expect(
      withStagedPackage(pkg.file, pkg.sha, async (staged) => {
        stagedPaths.push(staged);
        throw new Error("stage boom");
      }),
    ).rejects.toThrow("stage boom");
    const staged = stagedPaths[0];
    if (!staged) throw new Error("未取得暂存路径");
    expect(fs.existsSync(staged)).toBe(false);
    expect(fs.existsSync(path.dirname(staged))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 编排负例：install / uninstall ─────────────────────────────────────

test("install 在已安装列表非空时拒绝，且不发文件", async () => {
  const { session, call } = fakeSession([ok, ok, { result: { value: false } }]);
  await expect(
    new ExtensionManager(session, context, async () => {}).install("staged.eext"),
  ).rejects.toThrow(/empty 阶段未通过/);
  expect(call).toHaveBeenCalledTimes(3);
  expect(call.mock.calls.some(([method]) => method === "DOM.setFileInputFiles")).toBe(false);
});

test("install 提交后详情字段漂移只报告一次提交，不重试", async () => {
  const { session, call } = fakeSession([
    ok,
    ok,
    ok,
    input,
    {},
    settleCard,
    ok,
    ok,
    { result: { value: { enabled: "yes" } } },
    { exceptionDetails: { text: "详情漂移" } },
    {},
  ]);
  await expect(
    new ExtensionManager(session, context, async () => {}).install("staged.eext"),
  ).rejects.toThrow(/不要直接重试/);
  expect(call.mock.calls.filter(([method]) => method === "DOM.setFileInputFiles")).toHaveLength(1);
  expect(call).toHaveBeenCalledTimes(11);
});

test("install 在 settle 阶段异常时不重试提交", async () => {
  const { session, call } = fakeSession([
    ok,
    ok,
    ok,
    input,
    {},
    { exceptionDetails: { text: "card 不唯一" } },
    {},
  ]);
  await expect(
    new ExtensionManager(session, context, async () => {}).install("staged.eext"),
  ).rejects.toThrow(/不要直接重试/);
  expect(call.mock.calls.filter(([method]) => method === "DOM.setFileInputFiles")).toHaveLength(1);
  expect(call).toHaveBeenCalledTimes(7);
});

test("install 在 card 阶段异常时不重试提交", async () => {
  const { session, call } = fakeSession([
    ok,
    ok,
    ok,
    input,
    {},
    settleCard,
    ok,
    { exceptionDetails: { text: "card 抛错" } },
    {},
  ]);
  await expect(
    new ExtensionManager(session, context, async () => {}).install("staged.eext"),
  ).rejects.toThrow(/不要直接重试/);
  expect(call.mock.calls.filter(([method]) => method === "DOM.setFileInputFiles")).toHaveLength(1);
  expect(call).toHaveBeenCalledTimes(9);
});

test("install 在确认前 guard 变化时不发文件", async () => {
  const { session, call } = fakeSession([ok, ok, ok]);
  const guard = vi.fn(async () => {
    throw new Error("身份变化");
  });
  await expect(
    new ExtensionManager(session, context, guard).install("staged.eext"),
  ).rejects.toThrow(/身份变化/);
  expect(guard).toHaveBeenCalledOnce();
  expect(call).toHaveBeenCalledTimes(3);
  expect(call.mock.calls.some(([method]) => method === "DOM.setFileInputFiles")).toBe(false);
});

test("uninstall 在允许外部交互开启（remove-prompt 抛错）时拒绝，不进入确认", async () => {
  const { session, call } = fakeSession([
    ok,
    ok,
    ok,
    details,
    ok,
    { exceptionDetails: { text: "权限仍开启" } },
  ]);
  const guard = vi.fn(async () => {});
  await expect(new ExtensionManager(session, context, guard).uninstall()).rejects.toThrow(
    /未确认扩展已卸载/,
  );
  expect(guard).toHaveBeenCalledOnce();
  expect(call).toHaveBeenCalledTimes(6);
});

test("uninstall 遇到重复记录（card 抛错）时在配置与 guard 之前停止", async () => {
  const { session, call } = fakeSession([ok, ok, { exceptionDetails: { text: "card 不唯一" } }]);
  const guard = vi.fn(async () => {});
  await expect(new ExtensionManager(session, context, guard).uninstall()).rejects.toThrow(
    /card 阶段拒绝操作/,
  );
  expect(guard).not.toHaveBeenCalled();
  expect(call).toHaveBeenCalledTimes(3);
});

test("uninstall 遇到多个确认按钮（remove-confirm 抛错）时停止且不确认", async () => {
  const { session, call } = fakeSession([
    ok,
    ok,
    ok,
    details,
    ok,
    ok,
    { exceptionDetails: { text: "确认按钮不唯一" } },
  ]);
  const guard = vi.fn(async () => {});
  await expect(new ExtensionManager(session, context, guard).uninstall()).rejects.toThrow(
    /未确认扩展已卸载/,
  );
  expect(guard).toHaveBeenCalledTimes(2);
  expect(call).toHaveBeenCalledTimes(7);
});

// ─── withExtensionManager：发现/绑定/guard/session 关闭 ─────────────────

test("withExtensionManager 只连唯一 target 的 loopback WS，并总是关闭 session", async () => {
  const fake = fakeManagerHooks({ payload: [null, 7, target] });
  const action = vi.fn(async () => "done");
  await expect(withExtensionManager(window, context, action, fake.hooks)).resolves.toBe("done");
  expect(fake.requests).toEqual(["http://127.0.0.1:9222/json/list"]);
  expect(fake.connects).toEqual([target.webSocketDebuggerUrl]);
  expect(fake.evaluations).toEqual([editorIdentityExpression(window, href as string, title)]);
  expect(action).toHaveBeenCalledOnce();
  expect(fake.closes()).toBe(1);
});

test("withExtensionManager 在连接前拒绝重复 target、URL/WS 漂移与非列表响应", async () => {
  const action = vi.fn(async () => "unused");
  const cases: Array<{ name: string; payload?: unknown; ok?: boolean; reason: RegExp }> = [
    { name: "重复 target", payload: [target, target], reason: /未找到唯一/ },
    {
      name: "PCB 身份漂移",
      payload: [{ ...target, url: href.replace(`pcb=${window.pcb}`, "pcb=other") }],
      reason: /来源、工程 ID 或 PCB ID/,
    },
    {
      name: "WS 端口漂移",
      payload: [
        { ...target, webSocketDebuggerUrl: target.webSocketDebuggerUrl?.replace("9222", "9223") },
      ],
      reason: /WebSocket/,
    },
    { name: "非数组响应", payload: { pages: [target] }, reason: /CDP 页面列表/ },
    { name: "非 200 响应", payload: [target], ok: false, reason: /CDP 页面列表/ },
  ];
  for (const item of cases) {
    const fake = fakeManagerHooks({ payload: item.payload, ok: item.ok });
    await expect(
      withExtensionManager(window, context, action, fake.hooks),
      item.name,
    ).rejects.toThrow(item.reason);
    expect(fake.connects, item.name).toEqual([]);
    expect(fake.closes(), item.name).toBe(0);
  }
  expect(action).not.toHaveBeenCalled();
});

test("withExtensionManager 在探测到窗口切换时关闭 session 且不执行 action", async () => {
  const fake = fakeManagerHooks({ payload: [target], probeHref: `${href}&switched=1` });
  const action = vi.fn(async () => "unused");
  await expect(withExtensionManager(window, context, action, fake.hooks)).rejects.toThrow(
    /编辑器窗口已切换/,
  );
  expect(action).not.toHaveBeenCalled();
  expect(fake.evaluations).toEqual([]);
  expect(fake.closes()).toBe(1);
});

test("withExtensionManager 初始 guard 不通过时不执行 action，仍关闭 session", async () => {
  const fake = fakeManagerHooks({ payload: [target], evaluate: () => ({ value: false }) });
  const action = vi.fn(async () => "unused");
  await expect(withExtensionManager(window, context, action, fake.hooks)).rejects.toThrow(
    /工程、PCB 或编辑器状态变化/,
  );
  expect(action).not.toHaveBeenCalled();
  expect(fake.evaluations).toHaveLength(1);
  expect(fake.closes()).toBe(1);
});

test("withExtensionManager 在 action 抛错时仍关闭 session 并保留原错误", async () => {
  const fake = fakeManagerHooks({ payload: [target] });
  await expect(
    withExtensionManager(
      window,
      context,
      async () => {
        throw new Error("action boom");
      },
      fake.hooks,
    ),
  ).rejects.toThrow("action boom");
  expect(fake.closes()).toBe(1);
});

test("withExtensionManager 把 guard 接到每个阶段：guard 失败即停且不发文件", async () => {
  const fake = fakeManagerHooks({
    payload: [target],
    replies: [ok, ok, ok],
    evaluate: (attempt) => ({ value: attempt === 1 }),
  });
  await expect(
    withExtensionManager(window, context, (manager) => manager.install("staged.eext"), fake.hooks),
  ).rejects.toThrow(/工程、PCB 或编辑器状态变化/);
  expect(fake.evaluations).toHaveLength(2);
  expect(fake.call.mock.calls.some(([method]) => method === "DOM.setFileInputFiles")).toBe(false);
  expect(fake.closes()).toBe(1);
});
