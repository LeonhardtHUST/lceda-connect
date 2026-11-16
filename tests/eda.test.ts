import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";
import WebSocket from "ws";

import { health } from "../src/bridge/client.ts";
import { rawDataText } from "../src/bridge/protocol.ts";
import { startBridgeServer } from "../src/bridge/server.ts";
import { loadConfig } from "../src/core/config.ts";
import { createMemoryIo } from "../src/core/io.ts";
import { createServer, invokeTool } from "../src/mcp/server.ts";
import { ToolError } from "../src/mcp/types.ts";
import { capabilitySummary, lookupCapability } from "../src/eda/capabilities.ts";
import { checkEnvironment, type ChannelCheck } from "../src/eda/channels.ts";
import { runEdaCommand } from "../src/eda/cli.ts";
import { writeEvidence } from "../src/eda/evidence.ts";
import {
  ChannelError,
  DefaultBridgeChannel,
  EdaVerbError,
  type BridgeChannel,
  type CdpChannel,
} from "../src/eda/exec.ts";
import { edaTools } from "../src/eda/mcpTools.ts";
import { BOARD_READ_JS_V2, DRC_JS, autoRouteJs } from "../src/eda/payloads.ts";
import {
  boardDigestState,
  docInfo,
  evalApi,
  readBoardState,
  routeNets,
  runDrc,
} from "../src/eda/verbs.ts";

// 用假通道与本地 bridge 服务测路由、闸口与回读；不依赖真实立创EDA。

function pcbRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    doc_type: 3,
    doc_type_mismatch: false,
    settled: true,
    settled_mismatch_keys: [],
    settled_retried: false,
    lines: 10,
    vias: 2,
    comps: 3,
    pours: 1,
    nets: ["GND", "VCC"],
    drc_leaves: [
      {
        cat: "Clearance",
        sub: "Track",
        obj1: "A",
        obj2: "B",
        name: "Clearance",
        x: 1.0,
        y: 2.0,
      },
    ],
    eda_groups: [{ name: "Clearance", count: 1 }],
    details: [
      { id: "R1", x: 3.0, y: 4.0, rot: 0 },
      { id: "U9", x: 1.5, y: -2.25, rot: 90 },
    ],
    silks: [],
    reader_id: "BOARD_READ_JS@v2",
    ...over,
  };
}

function docMismatchRaw(): Record<string, unknown> {
  return {
    doc_type: 1,
    doc_type_mismatch: true,
    lines: null,
    vias: null,
    comps: null,
    pours: null,
    nets: null,
    drc_leaves: null,
    eda_groups: null,
    details: null,
    settled: null,
    settled_mismatch_keys: [],
    silks: null,
    reader_id: "BOARD_READ_JS@v2",
  };
}

function drcRaw(leaves: unknown[], categories: Array<{ category: string; count: number }>) {
  return {
    total: leaves.length,
    categories: categories.map((item) => ({ ...item, items: [] })),
    leaves,
  };
}

function fakeBridge(
  execute: BridgeChannel["execute"],
  extra: Partial<BridgeChannel> = {},
): BridgeChannel & { calls: Array<{ code: string; windowId?: string }> } {
  const calls: Array<{ code: string; windowId?: string }> = [];
  return {
    calls,
    execute: async (code, options) => {
      calls.push({ code, windowId: options?.windowId });
      return await execute(code, options);
    },
    ...extra,
  };
}

function fakeCdp(evalApi: CdpChannel["evalApi"]): CdpChannel & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    evalApi: async (body, options) => {
      calls.push(body);
      return await evalApi(body, options);
    },
  };
}

function failed(channel: "bridge" | "cdp", code: string, exitCode: number): ChannelError {
  return new ChannelError(channel, code, `${channel} 不可用：${code}`, exitCode);
}

function readyCheck(id: string): ChannelCheck {
  return { id, status: "ready", reason_code: "ok", detail: `${id} ok`, hint: "" };
}

function missingCheck(id: string): ChannelCheck {
  return {
    id,
    status: "missing",
    reason_code: "service_absent",
    detail: "",
    hint: "先启动服务",
  };
}

// ─── 路由与换路 ───────────────────────────────────────────────────────

test("读板路由：bridge 通道级失败后换 CDP，attempts 保留两跳", async () => {
  const bridge = fakeBridge(async () => {
    throw failed("bridge", "NO_BRIDGE", 2);
  });
  const cdp = fakeCdp(async () => pcbRaw());
  const result = await readBoardState({ bridge, cdp });
  expect(result.channel).toBe("cdp");
  expect(result.attempts.map((attempt) => attempt.channel)).toEqual(["bridge", "cdp"]);
  expect(result.attempts[0]?.ok).toBe(false);
  expect(result.attempts[1]?.ok).toBe(true);
  expect(result.state.lines).toBe(10);
  expect(result.state.comparable).toBe(true);
});

test("读板路由：bridge 成功就不碰 CDP", async () => {
  const bridge = fakeBridge(async () => pcbRaw());
  const cdp = fakeCdp(async () => {
    throw new Error("不该走到 CDP");
  });
  const result = await readBoardState({ bridge, cdp });
  expect(result.channel).toBe("bridge");
  expect(result.attempts).toHaveLength(1);
});

test("PCB 动词在 bridge 通道先按文档类型挑窗口", async () => {
  const bridge = fakeBridge(async () => pcbRaw(), {
    resolveWindow: async () => "win-pcb",
  });
  const result = await readBoardState({ bridge });
  expect(result.channel).toBe("bridge");
  expect(bridge.calls[0]?.windowId).toBe("win-pcb");
});

test("非 PCB 文档拒绝：不把全 0 当读数，也不换路", async () => {
  const bridge = fakeBridge(async () => docMismatchRaw());
  const cdp = fakeCdp(async () => pcbRaw());
  const error = (await readBoardState({ bridge, cdp }).catch(
    (caught: unknown) => caught,
  )) as EdaVerbError;
  expect(error).toBeInstanceOf(EdaVerbError);
  expect(error.code).toBe("BOARD_NOT_PCB");
  expect(error.exitCode).toBe(3);
  expect(error.message).toContain("假读数");
  expect(cdp.calls).toHaveLength(0);
});

test("双通道都不可用：NO_CHANNEL，attempts 带每跳失败原因", async () => {
  const bridge = fakeBridge(async () => {
    throw failed("bridge", "NO_BRIDGE", 2);
  });
  const cdp = fakeCdp(async () => {
    throw failed("cdp", "CDP_NOT_FOUND", 2);
  });
  const error = (await readBoardState({ bridge, cdp }).catch(
    (caught: unknown) => caught,
  )) as EdaVerbError;
  expect(error.code).toBe("NO_CHANNEL");
  expect(error.exitCode).toBe(2);
  const details = error.details as { attempts: Array<{ channel: string }> };
  expect(details.attempts.map((attempt) => attempt.channel)).toEqual(["bridge", "cdp"]);
});

test("超时是通道级故障，会继续换路；前置失败不会", async () => {
  const bridge = fakeBridge(async () => {
    throw failed("bridge", "TIMEOUT", 5);
  });
  const cdp = fakeCdp(async () => pcbRaw());
  expect((await readBoardState({ bridge, cdp })).channel).toBe("cdp");

  const precheck = fakeBridge(async () => {
    throw new EdaVerbError("BOARD_NOT_PCB", "不是 PCB", { exitCode: 3 });
  });
  const error = (await readBoardState({ bridge: precheck, cdp }).catch(
    (caught: unknown) => caught,
  )) as EdaVerbError;
  expect(error.code).toBe("BOARD_NOT_PCB");
});

// ─── 动词 ─────────────────────────────────────────────────────────────

test("doc_info 用合成路由：bridge 失败换 CDP", async () => {
  const bridge = fakeBridge(async () => {
    throw failed("bridge", "NOT_CONNECTED", 2);
  });
  const cdp = fakeCdp(async () => ({ type: 3, uuid: "uuid-pcb" }));
  const result = await docInfo({ bridge, cdp });
  expect(result.channel).toBe("cdp");
  expect(result.doc_type).toBe(3);
  expect(result.doc_type_name).toBe("pcb");
  expect(result.uuid).toBe("uuid-pcb");
});

test("doc_info：没有打开文档时返回 doc_type=null，不报协议错误", async () => {
  const bridge = fakeBridge(async () => null);
  const result = await docInfo({ bridge });
  expect(result.doc_type).toBeNull();
  expect(result.doc_type_name).toBe("unknown");
  expect(result.uuid).toBeNull();
});

test("PCB 动词挑不到 PCB 窗口：前置失败，不换路", async () => {
  const bridge = fakeBridge(async () => pcbRaw(), {
    resolveWindow: async () => null,
  });
  const cdp = fakeCdp(async () => pcbRaw());
  const error = (await readBoardState({ bridge, cdp }).catch(
    (caught: unknown) => caught,
  )) as EdaVerbError;
  expect(error.code).toBe("NO_TARGET_WINDOW");
  expect(error.exitCode).toBe(3);
  expect(cdp.calls).toHaveLength(0);
});

test("run_drc：类别统计 + 去重叶 + 双探针回读", async () => {
  const leaves = [
    { cat: "Clearance", sub: "Track", obj1: "A", obj2: "B", x: 1.0, y: 2.0 },
    { cat: "Clearance", sub: "Track", obj1: "A", obj2: "B", x: 1.01, y: 2.0 },
    { cat: "Netlist Error", sub: "Unrouted", obj1: "U1", obj2: "U2", x: 5.0, y: 6.0 },
  ];
  const bridge = fakeBridge(async () =>
    drcRaw(leaves, [
      { category: "Clearance", count: 1 },
      { category: "Netlist Error", count: 1 },
    ]),
  );
  const result = await runDrc({ bridge });
  expect(result.total).toBe(3);
  expect(result.drc).toBe(2);
  expect(result.cats).toEqual(["Clearance:1", "Netlist Error:1"]);
  expect(result.readback.raw_leaf_count).toBe(3);
  expect(result.readback.leaf_count).toBe(2);
  expect(result.readback.dup_removed).toBe(1);
  expect(result.readback.count_mismatch).toBe(false);
  expect(result.readback.probe_complete).toBe(true);
  expect(result.data_trustworthy).toBe(true);
  expect(bridge.calls[0]?.code).toBe(DRC_JS);
});

test("run_drc：EDA 自报计数对不上时不可信，不报通过", async () => {
  const leaves = [
    { cat: "Clearance", sub: "Track", obj1: "A", obj2: "B", x: 1.0, y: 2.0 },
    { cat: "Clearance", sub: "Track", obj1: "A", obj2: "B", x: 1.0, y: 2.0 },
  ];
  const bridge = fakeBridge(async () => drcRaw(leaves, [{ category: "Clearance", count: 3 }]));
  const result = await runDrc({ bridge });
  expect(result.readback.count_mismatch).toBe(true);
  expect(result.data_trustworthy).toBe(false);
});

test("route_nets：没有 confirm 只报预演，调用不到通道", async () => {
  const bridge = fakeBridge(async () => {
    throw new Error("不该执行");
  });
  const error = (await routeNets({ bridge }, { nets: ["GND", "VCC"] }).catch(
    (caught: unknown) => caught,
  )) as EdaVerbError;
  expect(error.code).toBe("CONFIRM_REQUIRED");
  const details = error.details as {
    object: { nets: string[] };
    impact: string;
    rollback: string;
  };
  expect(details.object.nets).toEqual(["GND", "VCC"]);
  expect(details.impact).toContain("autoRouting");
  expect(details.rollback).toContain("撤销");
  expect(bridge.calls).toHaveLength(0);
});

test("route_nets：confirm 后执行，成败只认前后线数回读", async () => {
  const bridge = fakeBridge(async () => ({ before: 10, after: 14, result: { ok: true } }));
  const result = await routeNets({ bridge }, { nets: ["GND"], confirm: true });
  expect(bridge.calls[0]?.code).toBe(autoRouteJs(["GND"]));
  expect(result.ok).toBe(true);
  expect(result.before).toBe(10);
  expect(result.after).toBe(14);
  expect(result.delta).toBe(4);
  expect(result.readback_ok).toBe(true);
});

test("route_nets：线数没增加算失败并给出原因", async () => {
  const bridge = fakeBridge(async () => ({ before: 10, after: 10, result: null }));
  const result = await routeNets({ bridge }, { nets: ["GND"], confirm: true });
  expect(result.ok).toBe(false);
  expect(result.changed).toBe(false);
  expect(result.warning).toContain("线数没有增加");
});

test("eval_api：confirm 闸口与执行", async () => {
  const bridge = fakeBridge(async () => "value-42");
  const gated = (await evalApi({ bridge }, { code: "return 42;" }).catch(
    (caught: unknown) => caught,
  )) as EdaVerbError;
  expect(gated.code).toBe("CONFIRM_REQUIRED");
  expect(bridge.calls).toHaveLength(0);

  const result = await evalApi({ bridge }, { code: "return 42;", confirm: true });
  expect(result.channel).toBe("bridge");
  expect(result.value).toBe("value-42");
});

test("board_digest：同读数 pass，改位号 fail，跨 reader unjudgeable", async () => {
  const bridge = fakeBridge(async () => pcbRaw());
  const first = await boardDigestState({ bridge });
  expect(first.digest.judge).toBe("judgeable");
  expect(first.digest.snapshot_key).toHaveLength(16);

  const same = await boardDigestState(
    { bridge },
    { baseline: JSON.stringify({ snapshot_key: first.digest.snapshot_key }) },
  );
  expect(same.comparison?.verdict).toBe("pass");

  const renamed = fakeBridge(async () =>
    pcbRaw({
      details: [
        { id: "R9", x: 3.0, y: 4.0, rot: 0 },
        { id: "U9", x: 1.5, y: -2.25, rot: 90 },
      ],
    }),
  );
  const changed = await boardDigestState({ bridge }, { baseline: JSON.stringify(first.digest) });
  expect(changed.comparison?.verdict).toBe("pass");
  const mismatched = await boardDigestState(
    { bridge: renamed },
    { baseline: JSON.stringify(first.digest) },
  );
  expect(mismatched.comparison?.verdict).toBe("fail");

  const cross = fakeBridge(async () => pcbRaw({ reader_id: "BOARD_READ_JS@v1" }));
  const crossResult = await boardDigestState(
    { bridge: cross },
    { baseline: JSON.stringify(first.digest) },
  );
  expect(crossResult.digest.judge).toBe("unjudgeable");
  expect(crossResult.comparison?.verdict).toBe("unjudgeable");
});

// ─── 环境自检四态 ─────────────────────────────────────────────────────

test("channels：四态与退出码、checks 的 reason_code", async () => {
  const both = await checkEnvironment({
    nodeVersion: "v20.11.0",
    probeBridge: async () => readyCheck("bridge-probe"),
    probeCdp: async () => readyCheck("cdp-endpoint"),
  });
  expect(both.channel_state).toBe("both");
  expect(both.status).toBe("ready");
  expect(both.exit_code).toBe(0);
  expect(both.checks.map((check) => check.id)).toEqual([
    "node-version",
    "cdp-module",
    "client-session",
    "bridge-probe",
    "cdp-endpoint",
  ]);
  expect(both.next_action).toContain("两条通道");

  const bridgeOnly = await checkEnvironment({
    probeBridge: async () => readyCheck("bridge-probe"),
    probeCdp: async () => missingCheck("cdp-endpoint"),
  });
  expect(bridgeOnly.channel_state).toBe("bridge-only");
  expect(bridgeOnly.status).toBe("partial");
  expect(bridgeOnly.exit_code).toBe(1);
  expect(bridgeOnly.functional_degradations.join("")).toContain("视觉回路");

  const cdpOnly = await checkEnvironment({
    probeBridge: async () => missingCheck("bridge-probe"),
    probeCdp: async () => readyCheck("cdp-endpoint"),
  });
  expect(cdpOnly.channel_state).toBe("cdp-only");

  const none = await checkEnvironment({
    probeBridge: async () => missingCheck("bridge-probe"),
    probeCdp: async () => missingCheck("cdp-endpoint"),
  });
  expect(none.channel_state).toBe("none");
  expect(none.status).toBe("needs_setup");
  expect(none.exit_code).toBe(2);
  expect(none.checks.find((check) => check.id === "client-session")?.reason_code).toBe(
    "service_unavailable",
  );

  const oldNode = await checkEnvironment({
    nodeVersion: "v18.20.0",
    probeBridge: async () => missingCheck("bridge-probe"),
    probeCdp: async () => missingCheck("cdp-endpoint"),
  });
  expect(oldNode.checks[0]?.reason_code).toBe("version_incompatible");
});

// ─── 台账检索 ─────────────────────────────────────────────────────────

test("capability lookup：精确命中、意图检索、零命中返回空", () => {
  const hit = lookupCapability("read_board_state");
  expect(hit.hits[0]?.id).toBe("read_board_state");
  expect(hit.hits[0]?.routes[0]).toMatchObject({ priority: 1, channel: "bridge" });
  expect(hit.hits[0]?.routes[1]).toMatchObject({ priority: 2, channel: "cdp" });

  const drc = lookupCapability("DRC");
  expect(drc.hits.map((item) => item.id)).toContain("run_drc");

  const empty = lookupCapability("没有这个动词-xyz");
  expect(empty.total).toBe(0);
  expect(empty.hits).toEqual([]);
  expect(empty.hint).toBeTruthy();

  const summary = capabilitySummary();
  expect(summary.verbCount).toBeGreaterThan(100);
  expect(summary.schemaVersion).toBeTruthy();
});

// ─── 证据包 ───────────────────────────────────────────────────────────

test("writeEvidence：result.json + evidence.md 含版本指纹与换路记录", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-eda-evidence-"));
  try {
    const written = writeEvidence(
      {
        verb: "read_board_state",
        ok: true,
        channel: "cdp",
        result: { lines: 10 },
        attempts: [{ channel: "bridge", ok: false, detail: "NO_BRIDGE" }],
        fingerprint: { reader_id: "BOARD_READ_JS@v2", channel: "cdp" },
      },
      { outDir: dir },
    );
    const record = JSON.parse(fs.readFileSync(written.resultJson, "utf8")) as {
      verb: string;
      version_fingerprint: { reader_id: string; tool: string };
      attempts: unknown[];
    };
    expect(record.verb).toBe("read_board_state");
    expect(record.version_fingerprint.reader_id).toBe("BOARD_READ_JS@v2");
    expect(record.version_fingerprint.tool).toContain("lceda-connect@");
    expect(record.attempts).toHaveLength(1);
    const markdown = fs.readFileSync(written.evidenceMd, "utf8");
    expect(markdown).toContain("版本指纹");
    expect(markdown).toContain("换路记录");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 真实内置 bridge 服务 ─────────────────────────────────────────────

interface FakeEditor {
  ws: WebSocket;
  onExecute: ((message: Record<string, unknown>) => Record<string, unknown> | null) | null;
  close: () => void;
}

async function waitFor<T>(probe: () => Promise<T | null> | T | null, timeoutMs = 4000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function connectEditor(port: number, windowId: string): Promise<FakeEditor> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/eda`);
  const editor: FakeEditor = { ws, onExecute: null, close: () => ws.terminate() };
  ws.on("message", (raw) => {
    const message = JSON.parse(rawDataText(raw)) as Record<string, unknown>;
    if (message.type === "execute" && editor.onExecute) {
      const reply = editor.onExecute(message);
      if (reply) ws.send(JSON.stringify(reply));
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "register", windowId }));
  return editor;
}

test("DefaultBridgeChannel：真实 HTTP + WS 往返，PCB 动词先探测窗口", async () => {
  const server = await startBridgeServer({ port: 0, logger: () => {} });
  const editor = await connectEditor(server.port, "win-test");
  editor.onExecute = (message) => {
    const code = String(message.code);
    if (code.includes("BOARD_READ_JS@v2")) {
      return { type: "result", id: message.id, result: pcbRaw(), timestamp: 1 };
    }
    if (code.includes("pcb_Drc.check")) {
      return {
        type: "result",
        id: message.id,
        result: drcRaw(
          [{ cat: "Clearance", sub: "Track", obj1: "A", obj2: "B", x: 1.0, y: 2.0 }],
          [{ category: "Clearance", count: 1 }],
        ),
        timestamp: 1,
      };
    }
    if (code.includes("getCurrentDocumentInfo")) {
      return { type: "result", id: message.id, result: { type: 3, uuid: "uuid-1" }, timestamp: 1 };
    }
    return { type: "result", id: message.id, result: { ok: true }, timestamp: 1 };
  };
  try {
    await waitFor(async () => {
      const state = await health(server.port);
      return state.edaWindowCount === 1 ? state : null;
    });
    const channel = new DefaultBridgeChannel({ portFirst: server.port, portLast: server.port });
    const windows = await channel.listWindows();
    expect(windows).toEqual(["win-test"]);
    const result = await readBoardState({ bridge: channel });
    expect(result.channel).toBe("bridge");
    expect(result.state.lines).toBe(10);
    expect(result.state.nets).toEqual(["GND", "VCC"]);

    const drc = await runDrc({ bridge: channel });
    expect(drc.total).toBe(1);
  } finally {
    editor.close();
    await server.close();
  }
});

test("真实 bridge 不在时换 CDP：NO_BRIDGE 属于通道级故障", async () => {
  const channel = new DefaultBridgeChannel({ portFirst: 1, portLast: 1 });
  const cdp = fakeCdp(async () => pcbRaw());
  const result = await readBoardState({ bridge: channel, cdp });
  expect(result.channel).toBe("cdp");
  expect(result.attempts[0]?.detail).toContain("NO_BRIDGE");
});

// ─── MCP 工具与 CLI ──────────────────────────────────────────────────

test("MCP：8 个工具名与中文描述里的硬约束", () => {
  expect(edaTools.map((tool) => tool.name)).toEqual([
    "lceda_status",
    "eda_doc_info",
    "eda_read_board",
    "eda_run_drc",
    "eda_board_digest",
    "eda_route_nets",
    "eda_eval_api",
    "eda_capability_lookup",
  ]);
  const read = edaTools.find((tool) => tool.name === "eda_read_board");
  expect(read?.description).toContain("回读");
  expect(read?.description).toContain("假的全 0");
  expect(read?.description).toContain("PCB");
  const route = edaTools.find((tool) => tool.name === "eda_route_nets");
  expect(route?.description).toContain("影响");
  expect(route?.description).toContain("回滚");
  expect(route?.description).toContain("线数");
  const evalTool = edaTools.find((tool) => tool.name === "eda_eval_api");
  expect(evalTool?.description).toContain("confirm: true");
  expect(evalTool?.description).toContain("回滚");
});

test("MCP：写工具没有 confirm 时抛 CONFIRM_REQUIRED，且不碰通道", async () => {
  const env = { ...process.env };
  const ctx = { cfg: loadConfig(env), env };
  const routeTool = edaTools.find((tool) => tool.name === "eda_route_nets");
  const routeError = (await routeTool
    ?.run({ nets: ["GND"] }, ctx)
    .catch((caught: unknown) => caught)) as ToolError;
  expect(routeError).toBeInstanceOf(ToolError);
  expect(routeError.code).toBe("CONFIRM_REQUIRED");
  const routeDetails = routeError.details as {
    preview: { object: { nets: string[] } };
  };
  expect(routeDetails.preview.object.nets).toEqual(["GND"]);

  const evalTool = edaTools.find((tool) => tool.name === "eda_eval_api");
  const evalError = (await evalTool
    ?.run({ code: "return 1;" }, ctx)
    .catch((caught: unknown) => caught)) as ToolError;
  expect(evalError).toBeInstanceOf(ToolError);
  expect(evalError.code).toBe("CONFIRM_REQUIRED");
});

test("MCP registry 可注册 edaTools 且能调用只读工具", async () => {
  const env = { ...process.env };
  const server = createServer({ env, tools: edaTools });
  expect(server).toBeTruthy();
  expect(new Set(edaTools.map((tool) => tool.name)).size).toBe(edaTools.length);
  const tool = edaTools.find((item) => item.name === "eda_capability_lookup");
  expect(tool).toBeTruthy();
  const result = await invokeTool(
    tool!,
    { query: "read_board_state" },
    { cfg: loadConfig(env), env },
  );
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain("read_board_state");
});

test("CLI：route 无 --confirm 只打印计划，exit 0 且不探测端口", async () => {
  const io = createMemoryIo();
  const code = await runEdaCommand(["route", "--nets", "GND,VCC"], io, { ...process.env });
  expect(code).toBe(0);
  const text = io.lines.join("\n");
  expect(text).toContain("没有改动任何数据");
  expect(text).toContain("回滚");

  const jsonIo = createMemoryIo();
  expect(
    await runEdaCommand(["route", "--nets", "GND", "--json"], jsonIo, { ...process.env }),
  ).toBe(0);
  const preview = JSON.parse(jsonIo.lines.join("\n")) as { object: { nets: string[] } };
  expect(preview.object.nets).toEqual(["GND"]);
});

test("CLI：eval 无 --confirm 只打印计划；缺 --code 返回用法错误", async () => {
  const io = createMemoryIo();
  expect(await runEdaCommand(["eval", "--code", "return 1;"], io, { ...process.env })).toBe(0);
  expect(io.lines.join("\n")).toContain("没有执行任何代码");

  const missing = createMemoryIo();
  expect(await runEdaCommand(["eval"], missing, { ...process.env })).toBe(1);
  expect(missing.errors.join("\n")).toContain("--code 或 --file");
});

test("CLI：lookup 输出命中，零命中输出 0", async () => {
  const io = createMemoryIo();
  expect(
    await runEdaCommand(["lookup", "read_board_state", "--json"], io, { ...process.env }),
  ).toBe(0);
  const result = JSON.parse(io.lines.join("\n")) as { total: number; hits: { id: string }[] };
  expect(result.total).toBeGreaterThan(0);
  expect(result.hits[0]?.id).toBe("read_board_state");

  const empty = createMemoryIo();
  expect(
    await runEdaCommand(["lookup", "不存在的动词-xyz", "--json"], empty, { ...process.env }),
  ).toBe(0);
  expect((JSON.parse(empty.lines.join("\n")) as { total: number }).total).toBe(0);
});

test("CLI：帮助与未知动作", async () => {
  const help = createMemoryIo();
  expect(await runEdaCommand(["help"], help, { ...process.env })).toBe(0);
  expect(help.lines.join("\n")).toContain("双通道");

  const unknown = createMemoryIo();
  expect(await runEdaCommand(["nope"], unknown, { ...process.env })).toBe(1);
  expect(unknown.errors.join("\n")).toContain("不认识的 eda 动作");
});

test("载荷：读板与 DRC 的关键字面串与自动布线参数注入", () => {
  expect(BOARD_READ_JS_V2).toContain("if (docType !== 3)");
  expect(BOARD_READ_JS_V2).toContain("reader_id: 'BOARD_READ_JS@v2'");
  expect(DRC_JS).toContain("eda.pcb_Drc.check(false, true, true)");
  expect(DRC_JS).toContain("return { total: leaves.length, categories, leaves };");
  const routed = autoRouteJs(["GND", "VCC"]);
  expect(routed).toContain('const nets = ["GND", "VCC"];');
  expect(routed).toContain("autoRouting({ RoutingNets: nets })");
});
