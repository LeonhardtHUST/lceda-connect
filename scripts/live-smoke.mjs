import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { execute } from "../src/bridge/client.ts";
import { Board, ensureWritable } from "../src/cdp/board.ts";
import { activeDocument, listDocuments, openDocument } from "../src/cdp/docs.ts";
import { createDefaultExecContext } from "../src/eda/exec.ts";
import { smokeTextPayload } from "../src/eda/liveSmoke.ts";
import { readBoardState, runDrc } from "../src/eda/verbs.ts";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    "project-uuid": { type: "string" },
    window: { type: "string" },
    schematic: { type: "string" },
    confirm: { type: "boolean", default: false },
    out: { type: "string" },
    screenshot: { type: "string" },
    "cdp-port": { type: "string", default: "9222" },
    "bridge-port": { type: "string", default: "49620" },
  },
});
for (const key of ["project", "project-uuid", "window", "out"]) {
  assert.ok(values[key], `必须显式指定 --${key}`);
}
assert.equal(values.project, "agent-drill-rc50", "仅允许授权的测试工程");
assert.equal(values["project-uuid"], "eb9fbbc911a7432189e71aefcbb0ff69");
if (values.confirm) assert.equal(values.schematic, "6f1f9b1bd0cbeccc");
const cdpPort = Number(values["cdp-port"]);
const bridgePort = Number(values["bridge-port"]);
for (const port of [cdpPort, bridgePort]) {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "端口无效");
}
const report = {
  timestamp: new Date().toISOString(),
  project: values.project,
  projectUuid: values["project-uuid"],
  scope: { globalConfigurationWritesPlanned: false, saveRequested: false },
  steps: {},
  ok: false,
};
const guardBody = `
const project = await eda.dmt_Project.getCurrentProjectInfo();
if (project?.friendlyName !== ${JSON.stringify(values.project)} ||
    project?.uuid !== ${JSON.stringify(values["project-uuid"])}) throw Error("PROJECT_GUARD");
`;
const callBridge = async (body) =>
  await execute(bridgePort, guardBody + body, { windowId: values.window, timeoutMs: 30000 });
const board = await Board.open({ port: cdpPort, match: values.project, docType: null });
const context = createDefaultExecContext({
  cdpPort,
  bridgePortFirst: bridgePort,
  bridgePortLast: bridgePort,
  windowId: values.window,
  match: values.project,
});
let originalDocument;
try {
  report.steps.bridgeIdentity = await callBridge(
    "const doc=await eda.dmt_SelectControl.getCurrentDocumentInfo(); return {project:project.friendlyName, uuid:project.uuid, document:doc.uuid, documentType:doc.documentType};",
  );
  report.steps.cdpIdentity = await board.api(
    guardBody.replaceAll("eda.", "A.") +
      "const doc=await A.dmt_SelectControl.getCurrentDocumentInfo(); return {project:project.friendlyName, uuid:project.uuid, document:doc.uuid, documentType:doc.documentType};",
  );
  assert.deepEqual(report.steps.cdpIdentity, report.steps.bridgeIdentity);
  originalDocument = await activeDocument(board);
  assert.equal(originalDocument.kind, "pcb", "请先激活测试工程 PCB");
  assert.equal(originalDocument.uuid, "1df2fdad9f776448");
  const before = await readBoardState(context);
  report.steps.boardBefore = before.state;
  report.steps.drc = await runDrc(context);
  const documents = await listDocuments(board);
  report.steps.documents = documents.documents;
  if (values.confirm) {
    assert.ok(values.schematic, "写入测试需要 --schematic UUID");
    assert.ok(
      documents.documents.some((doc) => doc.uuid === values.schematic && doc.kind === "sch"),
    );
    report.steps.schematicOpened = await openDocument(board, {
      uuid: values.schematic,
      kind: "sch",
      wait: false,
    });
    await ensureWritable(board);
    const marker = `LCEDA_CONNECT_SMOKE_${Date.now()}`;
    report.steps.textPlan = {
      marker,
      document: values.schematic,
      beforeIds: await callBridge("return await eda.sch_PrimitiveText.getAllPrimitiveId();"),
    };
    mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
    writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n");
    report.steps.textRoundtrip = await callBridge(
      smokeTextPayload({
        projectName: values.project,
        projectUuid: values["project-uuid"],
        documentUuid: values.schematic,
        marker,
      }),
    );
    writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n");
    assert.equal(report.steps.textRoundtrip.failure, null);
    assert.equal(report.steps.textRoundtrip.cleanupFailure, null);
    assert.equal(report.steps.textRoundtrip.restored, true);
    report.steps.residualCheck = await callBridge(`
const texts = await eda.sch_PrimitiveText.getAll();
return {checked:true, ids:texts.filter(text=>text.getState_Content()===${JSON.stringify(marker)}).map(text=>text.getState_PrimitiveId())};
`);
    assert.deepEqual(report.steps.residualCheck.ids, []);
    report.steps.pcbRestored = await openDocument(board, {
      uuid: originalDocument.uuid,
      kind: "pcb",
      wait: false,
    });
  }
  const after = await readBoardState(context);
  report.steps.boardAfter = after.state;
  for (const key of [
    "lines",
    "vias",
    "comps",
    "pours",
    "details_hash",
    "silk_hash",
    "drc_leaf_hash",
  ]) {
    assert.deepEqual(after.state[key], before.state[key], `板状态发生变化：${key}`);
  }
  if (values.screenshot) {
    const capture = await board.session.call("Page.captureScreenshot", { format: "png" });
    mkdirSync(path.dirname(path.resolve(values.screenshot)), { recursive: true });
    writeFileSync(values.screenshot, Buffer.from(capture.data, "base64"));
    report.steps.screenshot = values.screenshot;
  }
  const client = new Client({ name: "lceda-connect-live-smoke", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli-mcp.mjs"],
    cwd: process.cwd(),
    stderr: "inherit",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(new Set(tools.tools.map((tool) => tool.name)).size, tools.tools.length);
    report.steps.mcp = { toolCount: tools.tools.length, calls: [] };
    for (const { name, args } of [
      { name: "lceda_info", args: {} },
      { name: "api_search", args: { query: "pcb_PrimitiveVia" } },
      { name: "eda_doc_info", args: { windowId: values.window, match: values.project } },
      { name: "eda_read_board", args: { windowId: values.window, match: values.project } },
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
      report.steps.mcp.calls.push({ name, isError: false });
    }
  } finally {
    await client.close();
  }
  report.ok = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (report.steps.textPlan && report.steps.residualCheck?.checked !== true) {
    try {
      report.steps.residualCheck = await callBridge(`
const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
if (doc?.uuid !== ${JSON.stringify(values.schematic)}) return {checked:false, reason:"document_changed"};
const texts = await eda.sch_PrimitiveText.getAll();
return {checked:true, ids:texts.filter(text=>text.getState_Content()===${JSON.stringify(report.steps.textPlan.marker)}).map(text=>text.getState_PrimitiveId())};
`);
      if (report.steps.residualCheck.ids?.length) {
        report.ok = false;
        process.exitCode = 1;
      }
    } catch (error) {
      report.residualCheckError = error instanceof Error ? error.message : String(error);
      report.ok = false;
      process.exitCode = 1;
    }
  }
  if (originalDocument?.uuid) {
    try {
      await callBridge("return {uuid:project.uuid};");
      if ((await activeDocument(board)).uuid !== originalDocument.uuid) {
        await openDocument(board, { uuid: originalDocument.uuid, kind: "pcb", wait: false });
      }
    } catch (error) {
      report.restoreError = error instanceof Error ? error.message : String(error);
      report.ok = false;
      process.exitCode = 1;
    }
  }
  board.close();
  mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ok: report.ok, out: values.out, error: report.error ?? null }));
}
