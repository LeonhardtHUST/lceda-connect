import { runInNewContext } from "node:vm";
import { expect, test, vi } from "vite-plus/test";
import type { CdpTarget } from "../src/cdp/targets.ts";
import {
  editorIdentityExpression,
  ExtensionManager,
  selectExtensionWindow,
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

test("install sends exactly one input and reads manager state, not merely CDP success", async () => {
  const { session, call } = fakeSession([ok, ok, ok, input, {}, ok, ok, details, {}]);
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
