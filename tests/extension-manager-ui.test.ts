import * as vm from "node:vm";

import { expect, test } from "vite-plus/test";

import {
  MANAGER_STAGES,
  ManagerUiUsageError,
  managerExpression,
} from "../src/extensions/managerUi.ts";
import type { ManagerContext, ManagerStage } from "../src/extensions/managerUi.ts";

const CTX: ManagerContext = {
  href: "https://example.test/editor?project=abc",
  title: "eprj3-example | 嘉立创EDA专业版",
  displayName: "PCBWorld M0 Temporary Probe",
  name: "pcbworld-m0-temp-probe",
  uuid: "6a6bb481d7654e9da3e98b8882c1c109",
  version: "0.0.1",
};

const UUID_OTHER = "00000000000000000000000000000001";
const HIDDEN_INSTRUCTION = "此操作将永久卸载如下扩展，是否继续？";

class FakeElement {
  readonly tagName: string;
  ownText: string;
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  readonly attrs = new Map<string, string>();
  hidden = false;
  checked = false;
  disabled = false;
  multiple = false;
  value = "";
  className = "";
  clicks = 0;
  onclick: (() => void) | null = null;
  readonly nodeType = 1;

  constructor(tagName: string, text = "", attrs: Record<string, string> = {}) {
    this.tagName = tagName.toLowerCase();
    this.ownText = text;
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value);
  }

  add(...children: FakeElement[]): this {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  get innerText(): string {
    if (this.isHidden()) return "";
    return [this.ownText, ...this.children.map((child) => child.innerText)]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  getClientRects(): unknown[] {
    return this.isHidden() ? [] : [{}];
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  click(): void {
    this.clicks += 1;
    this.onclick?.();
  }

  isHidden(): boolean {
    if (this.hidden) return true;
    return this.parentElement ? this.parentElement.isHidden() : false;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const selectors = selector
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const found: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (selectors.some((candidate) => matchesSelector(child, candidate))) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

const SELECTOR = /^([a-z][a-z0-9]*)(?:\[([a-z0-9_-]+)(?:=["']?([^"'\]]*)["']?)?\])?$/i;

function matchesSelector(element: FakeElement, selector: string): boolean {
  const match = SELECTOR.exec(selector);
  if (!match) throw new Error(`unsupported selector: ${selector}`);
  const tag = match[1] as string;
  if (element.tagName !== tag.toLowerCase()) return false;
  const attribute = match[2];
  if (attribute === undefined) return true;
  const actual = element.getAttribute(attribute);
  if (actual === null) return false;
  return match[3] === undefined || actual === match[3];
}

class FakeDocument {
  readonly body = new FakeElement("body");
  title: string;
  visibilityState = "visible";

  constructor(title: string) {
    this.title = title;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }
}

function styleOf(element: FakeElement): Record<string, string> {
  const hidden = element.isHidden();
  return {
    visibility: hidden ? "hidden" : "visible",
    display: hidden ? "none" : "block",
    opacity: "1",
    pointerEvents: element.disabled ? "none" : "auto",
    cursor: element.disabled ? "not-allowed" : "default",
  };
}

async function run(
  expression: string,
  document: FakeDocument,
  href = CTX.href,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  const sandbox = {
    document,
    location: { href },
    getComputedStyle: styleOf,
    setTimeout: (callback: () => void, _ms?: number) => {
      callback();
      return 0;
    },
    ...extra,
  };
  const result = vm.runInNewContext(expression, sandbox, { timeout: 5000 });
  return await result;
}

interface Shell {
  dom: FakeDocument;
  manager: FakeElement;
  layout: FakeElement;
  heading: FakeElement;
}

function addShell(dom: FakeDocument): Omit<Shell, "dom"> {
  const app = new FakeElement("div");
  const manager = new FakeElement("div");
  const layout = new FakeElement("div");
  const header = new FakeElement("div");
  const heading = new FakeElement("span", "扩展管理器");
  dom.body.add(app);
  app.add(manager);
  manager.add(layout);
  layout.add(header);
  header.add(heading);
  return { manager, layout, heading };
}

function makeShell(title = CTX.title): Shell {
  const dom = new FakeDocument(title);
  return { dom, ...addShell(dom) };
}

interface InstalledList {
  tab: FakeElement;
  importTab: FakeElement | null;
  empty: FakeElement | null;
  cards: FakeElement[];
  list: FakeElement;
}

function addInstalledList(
  manager: FakeElement,
  options: {
    empty?: boolean;
    emptyText?: string;
    cards?: string[];
    versionMarker?: string;
    importText?: string | null;
  } = {},
): InstalledList {
  const content = new FakeElement("div");
  const tabs = new FakeElement("div");
  const tab = new FakeElement("span", "已安装");
  tabs.add(tab);
  const importText = options.importText === undefined ? "导入" : options.importText;
  let importTab: FakeElement | null = null;
  if (importText !== null) {
    importTab = new FakeElement("span", importText);
    tabs.add(importTab);
  }
  const list = new FakeElement("div");
  let empty: FakeElement | null = null;
  if (options.empty) {
    empty = new FakeElement("div", options.emptyText ?? "暂无数据");
    list.add(empty);
  }
  const cards: FakeElement[] = [];
  for (const name of options.cards ?? []) {
    const card = new FakeElement("div", name);
    cards.push(card);
    list.add(card);
  }
  if (options.versionMarker) list.add(new FakeElement("span", options.versionMarker));
  content.add(tabs, list);
  manager.add(content);
  return { tab, importTab, empty, cards, list };
}

interface DetailsOptions {
  displayName?: string;
  version?: string;
  uuid?: string;
  nativeName?: string | null;
  enabled?: boolean;
  permission?: "unchecked" | "checked" | "missing" | "hidden";
  configDisabled?: boolean;
  withConfig?: boolean;
}

interface DetailsView {
  details: FakeElement;
  config: FakeElement | null;
  uninstall: FakeElement;
  permission: FakeElement | null;
  status: FakeElement;
  uuidValue: FakeElement;
  nameValue: FakeElement | null;
}

function addDetails(manager: FakeElement, options: DetailsOptions = {}): DetailsView {
  const details = new FakeElement("div");
  const head = new FakeElement("div");
  const displayName = new FakeElement("span", options.displayName ?? CTX.displayName);
  const description = new FakeElement("span", "PCBWorld local survey");
  const version = new FakeElement("span", `V${options.version ?? CTX.version}`);
  head.add(displayName, description, version);

  const actions = new FakeElement("div");
  const uninstall = new FakeElement("button", "卸载");
  const status = new FakeElement("span", options.enabled === false ? "已禁用" : "已启用");
  const detailButton = new FakeElement("button", "详情");
  actions.add(uninstall, status, detailButton);

  const config = options.withConfig === false ? null : new FakeElement("button", "配置");
  if (config) {
    if (options.configDisabled) config.disabled = true;
    const group = new FakeElement("div");
    group.add(config);
    const footer = new FakeElement("div");
    footer.add(group);
    details.add(footer);
  }

  const meta = new FakeElement("div");
  let nameValue: FakeElement | null = null;
  if (options.nativeName !== null) {
    nameValue = new FakeElement("span", options.nativeName ?? CTX.name ?? "");
    meta.add(new FakeElement("span", "名称"), nameValue);
  }
  const uuidValue = new FakeElement("span", options.uuid ?? CTX.uuid);
  meta.add(new FakeElement("span", "UUID"), uuidValue);
  details.add(head, actions, meta);
  manager.add(details);

  let permission: FakeElement | null = null;
  if (options.permission !== "missing") {
    permission = new FakeElement("input", "", {
      type: "checkbox",
      "data-test": "Allow interactive with external",
    });
    permission.checked = options.permission === "checked";
    permission.hidden = options.permission === "hidden";
    details.add(permission);
  }

  return { details, config, uninstall, permission, status, uuidValue, nameValue };
}

function addFileInput(target: FakeElement, accept = ".eext", hidden = true): FakeElement {
  const input = new FakeElement("input", "", { type: "file", accept });
  input.hidden = hidden;
  target.add(input);
  return input;
}

function addSearch(manager: FakeElement, value: string): FakeElement {
  const input = new FakeElement("input", "", { type: "text", placeholder: "搜索" });
  input.value = value;
  manager.add(input);
  return input;
}

interface DialogOptions {
  instruction?: string;
  nameLine?: string;
  versionLine?: string;
  uuidLines?: string[];
  checked?: boolean;
  confirmCount?: number;
  confirmDisabled?: boolean;
  onAcknowledge?: (ack: FakeElement, confirm: FakeElement | null) => void;
}

interface DialogView {
  dialog: FakeElement;
  ack: FakeElement;
  confirm: FakeElement | null;
  uuidLine: FakeElement;
}

function addDialog(dom: FakeDocument, options: DialogOptions = {}): DialogView {
  const overlay = new FakeElement("div");
  const dialog = new FakeElement("div");
  const instruction = new FakeElement("p", options.instruction ?? HIDDEN_INSTRUCTION);
  const nameLine = new FakeElement("p", options.nameLine ?? `名称：${CTX.displayName}`);
  const versionLine = new FakeElement("p", options.versionLine ?? `版本：V${CTX.version}`);
  const uuidLines = options.uuidLines ?? [`UUID：${CTX.uuid}`];
  const uuidLine = new FakeElement("p", uuidLines[0] as string);
  const ack = new FakeElement("input", "", { type: "checkbox" });
  ack.checked = options.checked === true;
  dialog.add(instruction, nameLine, versionLine, uuidLine, ack);

  const footer = new FakeElement("div");
  const confirms: FakeElement[] = [];
  for (let index = 0; index < (options.confirmCount ?? 1); index += 1) {
    const confirm = new FakeElement("button", "确认");
    confirm.disabled = options.confirmDisabled === true;
    confirms.push(confirm);
    footer.add(confirm);
  }
  dialog.add(footer);
  for (const line of uuidLines.slice(1)) dialog.add(new FakeElement("p", line));

  overlay.add(dialog);
  dom.body.add(overlay);

  const confirm = confirms[0] ?? null;
  ack.onclick = () => {
    ack.checked = !ack.checked;
    options.onAcknowledge?.(ack, confirm);
  };

  return { dialog, ack, confirm, uuidLine };
}

function expression(stage: ManagerStage, ctx: ManagerContext = CTX): string {
  return managerExpression(stage, ctx);
}

test("上下文只接受精确 http(s) 编辑器页、精确 UUID 与安全名称", () => {
  expect(() => expression("open", { ...CTX, href: "https://*/*" })).toThrow(/通配符/);
  expect(() =>
    expression("open", { ...CTX, href: "https://user:pass@example.test/editor" }),
  ).toThrow(/凭据/);
  expect(() => expression("open", { ...CTX, href: "file:///C:/lceda/index.html" })).toThrow(
    /http\/https/,
  );
  expect(() => expression("open", { ...CTX, uuid: "not-a-uuid" })).toThrow(/uuid/);
  expect(() => expression("open", { ...CTX, displayName: "" })).toThrow(/displayName/);
  expect(() => expression("open", { ...CTX, displayName: " padded " })).toThrow(/首尾空白/);
  expect(() => expression("open", { ...CTX, version: "1.0 0" })).toThrow(/version/);
  expect(() => expression("open", { ...CTX, name: "bad name" })).toThrow(/name/);
  expect(() => managerExpression("nope" as ManagerStage, CTX)).toThrow(ManagerUiUsageError);

  const expressionText = expression("details");
  expect(expressionText).toContain(JSON.stringify(CTX.uuid));
  expect(expressionText).toContain(JSON.stringify(CTX.displayName));
  expect(expressionText).not.toContain("eval(");
});

test("每个阶段在任何 href/title/document 漂移时都先失败且不点击", async () => {
  for (const stage of MANAGER_STAGES) {
    const shell = makeShell();
    shell.heading.onclick = () => {
      throw new Error("guard 之前不应点击任何东西");
    };
    const text = expression(stage);

    await expect(run(text, shell.dom, "https://other.test/editor")).rejects.toThrow(/href/);
    shell.dom.title = "other title";
    await expect(run(text, shell.dom)).rejects.toThrow(/title/);
    shell.dom.title = CTX.title;
    shell.dom.visibilityState = "hidden";
    await expect(run(text, shell.dom)).rejects.toThrow(/不可见/);
    expect(shell.heading.clicks).toBe(0);
  }
});

test("open 直接复用已打开的管理器", async () => {
  const shell = makeShell();
  addInstalledList(shell.manager, { empty: true });
  await expect(run(expression("open"), shell.dom)).resolves.toBe(true);
});

test("open 从高级菜单分两步打开管理器", async () => {
  const dom = new FakeDocument(CTX.title);
  const advanced = new FakeElement("span", "高级");
  const entry = new FakeElement("span", "扩展管理器(E)...");
  dom.body.add(advanced);
  advanced.onclick = () => {
    dom.body.add(entry);
  };
  entry.onclick = () => {
    addShell(dom);
  };

  await expect(run(expression("open"), dom)).resolves.toBe(true);
  expect(advanced.clicks).toBe(1);
  expect(entry.clicks).toBe(1);
});

test("open 遇到重复入口或没有高级菜单时拒绝", async () => {
  const dom = new FakeDocument(CTX.title);
  dom.body.add(new FakeElement("span", "扩展管理器(E)..."));
  dom.body.add(new FakeElement("span", "扩展管理器(E)..."));
  await expect(run(expression("open"), dom)).rejects.toThrow(/必须唯一/);

  const empty = new FakeDocument(CTX.title);
  await expect(run(expression("open"), empty)).rejects.toThrow(/高级/);
});

test("installed 对装载中返回 null、缺页签返回 false、点中返回 true", async () => {
  const loading = new FakeDocument(CTX.title);
  await expect(run(expression("installed"), loading)).resolves.toBeNull();

  const shell = makeShell();
  await expect(run(expression("installed"), shell.dom)).resolves.toBe(false);

  const withTab = makeShell();
  const list = addInstalledList(withTab.manager, { empty: true });
  await expect(run(expression("installed"), withTab.dom)).resolves.toBe(true);
  expect(list.tab.clicks).toBe(1);
});

test("installed 遇到重复已安装页签时拒绝", async () => {
  const shell = makeShell();
  addInstalledList(shell.manager, { empty: true });
  shell.manager.add(new FakeElement("span", "已安装"));
  await expect(run(expression("installed"), shell.dom)).rejects.toThrow(/必须唯一/);
});

test("empty 只认真正的暂无数据且没有选中详情", async () => {
  const empty = makeShell();
  addInstalledList(empty.manager, { empty: true });
  await expect(run(expression("empty"), empty.dom)).resolves.toBe(true);

  const withCard = makeShell();
  addInstalledList(withCard.manager, { cards: [CTX.displayName] });
  await expect(run(expression("empty"), withCard.dom)).resolves.toBe(false);

  const withDetails = makeShell();
  addInstalledList(withDetails.manager, { empty: true });
  addDetails(withDetails.manager);
  await expect(run(expression("empty"), withDetails.dom)).resolves.toBe(false);

  const withCardAndEmptyMarker = makeShell();
  addInstalledList(withCardAndEmptyMarker.manager, {
    empty: true,
    cards: [CTX.displayName],
    versionMarker: "V9.9.9",
  });
  await expect(run(expression("empty"), withCardAndEmptyMarker.dom)).resolves.toBe(false);

  const withOtherCard = makeShell();
  addInstalledList(withOtherCard.manager, {
    empty: true,
    cards: ["Other Extension"],
    versionMarker: "V9.9.9",
  });
  await expect(run(expression("empty"), withOtherCard.dom)).resolves.toBe(false);

  const notReady = makeShell();
  addInstalledList(notReady.manager, { empty: true, importText: null });
  await expect(run(expression("empty"), notReady.dom)).rejects.toThrow(/列表未就绪/);

  await expect(run(expression("empty"), new FakeDocument(CTX.title))).rejects.toThrow(/管理器/);
});

test("empty 同时接受 暂无数据 与 暂无数据。，合计仍须唯一", async () => {
  const dotted = makeShell();
  addInstalledList(dotted.manager, { empty: true, emptyText: "暂无数据。" });
  await expect(run(expression("empty"), dotted.dom)).resolves.toBe(true);

  const dottedFile = makeShell();
  addInstalledList(dottedFile.manager, { empty: true, emptyText: "暂无数据。" });
  const dottedInput = addFileInput(dottedFile.manager);
  await expect(run(expression("file-input"), dottedFile.dom)).resolves.toBe(dottedInput);

  const dottedCard = makeShell();
  addInstalledList(dottedCard.manager, { empty: true, emptyText: "暂无数据。" });
  await expect(run(expression("card"), dottedCard.dom)).resolves.toBe(false);

  const double = makeShell();
  addInstalledList(double.manager, { empty: true });
  double.manager.add(new FakeElement("div", "暂无数据。"));
  await expect(run(expression("empty"), double.dom)).rejects.toThrow(/列表未就绪/);
  await expect(run(expression("card"), double.dom)).resolves.toBeNull();
});

test("empty 对加载中的临时暂无数据不认账，出现卡片后返回 false", async () => {
  const shell = makeShell();
  const list = addInstalledList(shell.manager, { empty: true });
  const transient = await run(expression("empty"), shell.dom, CTX.href, {
    setTimeout: (callback: () => void) => {
      if (list.empty) list.empty.hidden = true;
      list.list.add(new FakeElement("div", CTX.displayName));
      callback();
      return 0;
    },
  });
  expect(transient).toBe(false);
});

test("card 在列表就绪未知时返回 null，不误报 false", async () => {
  const shell = makeShell();
  addInstalledList(shell.manager, { importText: null });
  await expect(run(expression("card"), shell.dom)).resolves.toBeNull();

  const loading = makeShell();
  const list = addInstalledList(loading.manager, {});
  // 只有页签和导入，没有任何列表标记；不能把它当成“没有卡片”。
  await expect(run(expression("card"), loading.dom)).resolves.toBeNull();
  expect(list.tab.clicks).toBe(0);
});

test("card 只有唯一 exact displayName 才点击，0 或多张都不点", async () => {
  const one = makeShell();
  const oneList = addInstalledList(one.manager, { cards: [CTX.displayName] });
  await expect(run(expression("card"), one.dom)).resolves.toBe(true);
  expect(oneList.cards[0]?.clicks).toBe(1);

  const zero = makeShell();
  addInstalledList(zero.manager, { empty: true });
  await expect(run(expression("card"), zero.dom)).resolves.toBe(false);

  const duplicate = makeShell();
  const duplicateList = addInstalledList(duplicate.manager, {
    cards: [CTX.displayName, CTX.displayName],
  });
  await expect(run(expression("card"), duplicate.dom)).resolves.toBe(false);
  expect(duplicateList.cards.map((card) => card.clicks)).toEqual([0, 0]);

  const mixed = makeShell();
  const mixedList = addInstalledList(mixed.manager, {
    cards: [CTX.displayName, "Other Extension"],
    versionMarker: "V9.9.9",
  });
  await expect(run(expression("card"), mixed.dom)).resolves.toBe(true);
  expect(mixedList.cards.map((card) => card.clicks)).toEqual([1, 0]);

  const selected = makeShell();
  const selectedList = addInstalledList(selected.manager, { cards: [CTX.displayName] });
  addDetails(selected.manager);
  await expect(run(expression("card"), selected.dom)).resolves.toBe(true);
  expect(selectedList.cards[0]?.clicks).toBe(0);
});

test("details 未就绪返回 null，读取 exact 详情返回 enabled", async () => {
  const shell = makeShell();
  addInstalledList(shell.manager, { empty: true });
  await expect(run(expression("details"), shell.dom)).resolves.toBeNull();

  const view = makeShell();
  addInstalledList(view.manager, { cards: [CTX.displayName] });
  addDetails(view.manager);
  await expect(run(expression("details"), view.dom)).resolves.toEqual({ enabled: true });

  const disabled = makeShell();
  addInstalledList(disabled.manager, { cards: [CTX.displayName] });
  addDetails(disabled.manager, { enabled: false });
  await expect(run(expression("details"), disabled.dom)).resolves.toEqual({ enabled: false });

  const noNameContext = { ...CTX } as ManagerContext;
  delete noNameContext.name;
  const withoutName = makeShell();
  addInstalledList(withoutName.manager, { cards: [CTX.displayName] });
  addDetails(withoutName.manager);
  await expect(run(expression("details", noNameContext), withoutName.dom)).resolves.toEqual({
    enabled: true,
  });
});

test("details 对名称、版本、UUID、状态、原生名的漂移全部拒绝", async () => {
  const wrongName = makeShell();
  addInstalledList(wrongName.manager, { cards: [CTX.displayName] });
  addDetails(wrongName.manager, { displayName: "Other Extension" });
  await expect(run(expression("details"), wrongName.dom)).rejects.toThrow(/显示名/);

  const wrongVersion = makeShell();
  addInstalledList(wrongVersion.manager, { cards: [CTX.displayName] });
  addDetails(wrongVersion.manager, { version: "9.9.9" });
  await expect(run(expression("details"), wrongVersion.dom)).rejects.toThrow(/版本/);

  const wrongUuid = makeShell();
  addInstalledList(wrongUuid.manager, { cards: [CTX.displayName] });
  addDetails(wrongUuid.manager, { uuid: UUID_OTHER });
  await expect(run(expression("details"), wrongUuid.dom)).rejects.toThrow(/UUID/);

  const duplicateUuid = makeShell();
  addInstalledList(duplicateUuid.manager, { cards: [CTX.displayName] });
  const duplicateView = addDetails(duplicateUuid.manager);
  duplicateView.details.add(new FakeElement("span", "UUID"));
  await expect(run(expression("details"), duplicateUuid.dom)).rejects.toThrow(/UUID 标签/);

  const wrongStatus = makeShell();
  addInstalledList(wrongStatus.manager, { cards: [CTX.displayName] });
  addDetails(wrongStatus.manager).status.ownText = "已停用";
  await expect(run(expression("details"), wrongStatus.dom)).rejects.toThrow(/启用状态/);

  const wrongNative = makeShell();
  addInstalledList(wrongNative.manager, { cards: [CTX.displayName] });
  const nativeView = addDetails(wrongNative.manager);
  if (nativeView.nameValue) nativeView.nameValue.ownText = "other-native";
  await expect(run(expression("details"), wrongNative.dom)).rejects.toThrow(/原生名称/);

  const missingUninstall = makeShell();
  addInstalledList(missingUninstall.manager, { cards: [CTX.displayName] });
  addDetails(missingUninstall.manager).uninstall.hidden = true;
  await expect(run(expression("details"), missingUninstall.dom)).rejects.toThrow(/卸载按钮/);
});

test("details 在没有 名称 标签时仍按 displayName/uuid 通过", async () => {
  const shell = makeShell();
  addInstalledList(shell.manager, { cards: [CTX.displayName] });
  addDetails(shell.manager, { nativeName: null });
  await expect(run(expression("details"), shell.dom)).resolves.toEqual({ enabled: true });
});

test("config 只在 exact 详情上点击一次", async () => {
  const shell = makeShell();
  addInstalledList(shell.manager, { cards: [CTX.displayName] });
  const view = addDetails(shell.manager);
  await expect(run(expression("config"), shell.dom)).resolves.toBe(true);
  expect(view.config?.clicks).toBe(1);

  const missing = makeShell();
  addInstalledList(missing.manager, { cards: [CTX.displayName] });
  await expect(run(expression("config"), missing.dom)).rejects.toThrow(/详情面板/);

  const wrong = makeShell();
  addInstalledList(wrong.manager, { cards: [CTX.displayName] });
  const wrongView = addDetails(wrong.manager, { uuid: UUID_OTHER });
  await expect(run(expression("config"), wrong.dom)).rejects.toThrow(/UUID/);
  expect(wrongView.config?.clicks).toBe(0);

  const disabled = makeShell();
  addInstalledList(disabled.manager, { cards: [CTX.displayName] });
  const disabledView = addDetails(disabled.manager, { configDisabled: true });
  await expect(run(expression("config"), disabled.dom)).rejects.toThrow(/不可点击/);
  expect(disabledView.config?.clicks).toBe(0);
});

test("remove-prompt 只在权限未开启时点 scoped 卸载，且从不改权限", async () => {
  const shell = makeShell();
  addInstalledList(shell.manager, { cards: [CTX.displayName] });
  const view = addDetails(shell.manager);
  await expect(run(expression("remove-prompt"), shell.dom)).resolves.toBe(true);
  expect(view.uninstall.clicks).toBe(1);
  expect(view.permission?.clicks).toBe(0);
  expect(view.permission?.checked).toBe(false);

  const checked = makeShell();
  addInstalledList(checked.manager, { cards: [CTX.displayName] });
  const checkedView = addDetails(checked.manager, { permission: "checked" });
  await expect(run(expression("remove-prompt"), checked.dom)).rejects.toThrow(/仍开启/);
  expect(checkedView.uninstall.clicks).toBe(0);
  expect(checkedView.permission?.clicks).toBe(0);
  expect(checkedView.permission?.checked).toBe(true);

  const missing = makeShell();
  addInstalledList(missing.manager, { cards: [CTX.displayName] });
  const missingView = addDetails(missing.manager, { permission: "missing" });
  await expect(run(expression("remove-prompt"), missing.dom)).rejects.toThrow(/允许外部交互/);
  expect(missingView.uninstall.clicks).toBe(0);

  const hidden = makeShell();
  addInstalledList(hidden.manager, { cards: [CTX.displayName] });
  const hiddenView = addDetails(hidden.manager, { permission: "hidden" });
  await expect(run(expression("remove-prompt"), hidden.dom)).rejects.toThrow(/不可见/);
  expect(hiddenView.uninstall.clicks).toBe(0);

  const wrong = makeShell();
  addInstalledList(wrong.manager, { cards: [CTX.displayName] });
  const wrongView = addDetails(wrong.manager, { uuid: UUID_OTHER });
  await expect(run(expression("remove-prompt"), wrong.dom)).rejects.toThrow(/UUID/);
  expect(wrongView.uninstall.clicks).toBe(0);

  const scoped = makeShell();
  addInstalledList(scoped.manager, { cards: [CTX.displayName] });
  const scopedView = addDetails(scoped.manager);
  const outside = new FakeElement("button", "卸载");
  scoped.manager.add(outside);
  await expect(run(expression("remove-prompt"), scoped.dom)).resolves.toBe(true);
  expect(scopedView.uninstall.clicks).toBe(1);
  expect(outside.clicks).toBe(0);
});

test("已有卸载对话框时 remove-prompt/config 拒绝自动确认", async () => {
  const prompt = makeShell();
  addInstalledList(prompt.manager, { cards: [CTX.displayName] });
  const promptView = addDetails(prompt.manager);
  addDialog(prompt.dom);
  await expect(run(expression("remove-prompt"), prompt.dom)).rejects.toThrow(/已有卸载确认对话框/);
  expect(promptView.uninstall.clicks).toBe(0);

  const config = makeShell();
  addInstalledList(config.manager, { cards: [CTX.displayName] });
  const configView = addDetails(config.manager);
  addDialog(config.dom);
  await expect(run(expression("config"), config.dom)).rejects.toThrow(/已有卸载确认对话框/);
  expect(configView.config?.clicks).toBe(0);
});

test("remove-prompt 只读目标详情 scope 内的权限开关", async () => {
  const shell = makeShell();
  addInstalledList(shell.manager, { cards: [CTX.displayName] });
  const view = addDetails(shell.manager, { permission: "missing" });
  const other = new FakeElement("input", "", {
    type: "checkbox",
    "data-test": "Allow interactive with external",
  });
  other.checked = false;
  shell.manager.add(other);
  await expect(run(expression("remove-prompt"), shell.dom)).rejects.toThrow(/目标配置面板/);
  expect(view.uninstall.clicks).toBe(0);
  expect(other.clicks).toBe(0);
});

test("remove-confirm 勾选后重验绑定再确认，且只点该对话框的按钮", async () => {
  const dom = new FakeDocument(CTX.title);
  addShell(dom);
  const dialog = addDialog(dom);
  await expect(run(expression("remove-confirm"), dom)).resolves.toBe(true);
  expect(dialog.ack.clicks).toBe(1);
  expect(dialog.confirm?.clicks).toBe(1);

  const already = new FakeDocument(CTX.title);
  addShell(already);
  const checked = addDialog(already, { checked: true });
  await expect(run(expression("remove-confirm"), already)).rejects.toThrow(/已勾选/);
  expect(checked.ack.clicks).toBe(0);
  expect(checked.confirm?.clicks).toBe(0);

  const outside = new FakeDocument(CTX.title);
  addShell(outside);
  const outsideDialog = addDialog(outside);
  const outsideConfirm = new FakeElement("button", "确认");
  outside.body.add(outsideConfirm);
  await expect(run(expression("remove-confirm"), outside)).resolves.toBe(true);
  expect(outsideDialog.confirm?.clicks).toBe(1);
  expect(outsideConfirm.clicks).toBe(0);
});

test("remove-confirm 对名称、版本、UUID、重复对话框/按钮全部拒绝", async () => {
  const wrongName = new FakeDocument(CTX.title);
  addShell(wrongName);
  const nameDialog = addDialog(wrongName, { nameLine: "名称：Other Extension" });
  await expect(run(expression("remove-confirm"), wrongName)).rejects.toThrow(/名称/);
  expect(nameDialog.ack.clicks).toBe(0);
  expect(nameDialog.confirm?.clicks).toBe(0);

  const wrongVersion = new FakeDocument(CTX.title);
  addShell(wrongVersion);
  addDialog(wrongVersion, { versionLine: "版本：V9.9.9" });
  await expect(run(expression("remove-confirm"), wrongVersion)).rejects.toThrow(/版本/);

  const wrongUuid = new FakeDocument(CTX.title);
  addShell(wrongUuid);
  addDialog(wrongUuid, { uuidLines: [`UUID：${UUID_OTHER}`] });
  await expect(run(expression("remove-confirm"), wrongUuid)).rejects.toThrow(/UUID/);

  const duplicateUuid = new FakeDocument(CTX.title);
  addShell(duplicateUuid);
  addDialog(duplicateUuid, { uuidLines: [`UUID：${CTX.uuid}`, `UUID：${UUID_OTHER}`] });
  await expect(run(expression("remove-confirm"), duplicateUuid)).rejects.toThrow(/UUID/);

  const duplicateDialog = new FakeDocument(CTX.title);
  addShell(duplicateDialog);
  addDialog(duplicateDialog);
  addDialog(duplicateDialog);
  await expect(run(expression("remove-confirm"), duplicateDialog)).rejects.toThrow(/必须唯一/);

  const duplicateConfirm = new FakeDocument(CTX.title);
  addShell(duplicateConfirm);
  addDialog(duplicateConfirm, { confirmCount: 2 });
  await expect(run(expression("remove-confirm"), duplicateConfirm)).rejects.toThrow(/确认按钮/);

  const noConfirm = new FakeDocument(CTX.title);
  addShell(noConfirm);
  addDialog(noConfirm, { confirmCount: 0 });
  await expect(run(expression("remove-confirm"), noConfirm)).rejects.toThrow(/对话框不可见/);
});

test("remove-confirm 勾选未生效或确认按钮未就绪时抛错且不确认", async () => {
  const noAck = new FakeDocument(CTX.title);
  addShell(noAck);
  const noAckDialog = addDialog(noAck);
  if (noAckDialog.ack) noAckDialog.ack.onclick = null;
  await expect(run(expression("remove-confirm"), noAck)).rejects.toThrow(/勾选框未生效/);
  expect(noAckDialog.confirm?.clicks).toBe(0);

  const broken = new FakeDocument(CTX.title);
  addShell(broken);
  const brokenDialog = addDialog(broken, {
    onAcknowledge: (ack, confirm) => {
      ack.checked = true;
      brokenDialog.uuidLine.ownText = `UUID：${UUID_OTHER}`;
      if (confirm) confirm.disabled = true;
    },
  });
  await expect(run(expression("remove-confirm"), broken)).rejects.toThrow(/UUID/);
  expect(brokenDialog.confirm?.clicks).toBe(0);

  const disabled = new FakeDocument(CTX.title);
  addShell(disabled);
  const disabledDialog = addDialog(disabled, {
    onAcknowledge: (ack, confirm) => {
      ack.checked = true;
      if (confirm) confirm.disabled = true;
    },
  });
  await expect(run(expression("remove-confirm"), disabled)).rejects.toThrow(/确认按钮未就绪/);
  expect(disabledDialog.confirm?.clicks).toBe(0);

  const notReady = new FakeDocument(CTX.title);
  addShell(notReady);
  await expect(run(expression("remove-confirm"), notReady)).rejects.toThrow(/对话框没有出现/);
});

test("removed 只在列表就绪、条目与卸载提示都消失时返回 true", async () => {
  const shell = makeShell();
  addInstalledList(shell.manager, { empty: true });
  await expect(run(expression("removed"), shell.dom)).resolves.toBe(true);

  const withCard = makeShell();
  addInstalledList(withCard.manager, { cards: [CTX.displayName] });
  await expect(run(expression("removed"), withCard.dom)).resolves.toBe(false);

  const withPrompt = makeShell();
  addInstalledList(withPrompt.manager, { empty: true });
  addDialog(withPrompt.dom);
  await expect(run(expression("removed"), withPrompt.dom)).resolves.toBe(false);

  const withUuid = makeShell();
  addInstalledList(withUuid.manager, { empty: true });
  withUuid.manager.add(new FakeElement("span", "UUID"));
  await expect(run(expression("removed"), withUuid.dom)).resolves.toBe(false);

  const notReady = makeShell();
  addInstalledList(notReady.manager, { empty: true, importText: null });
  await expect(run(expression("removed"), notReady.dom)).resolves.toBe(false);

  await expect(run(expression("removed"), new FakeDocument(CTX.title))).rejects.toThrow(/管理器/);
});

test("旧搜索值不参与负向回读", async () => {
  const card = makeShell();
  addInstalledList(card.manager, { empty: true });
  addSearch(card.manager, "pcb");
  await expect(run(expression("card"), card.dom)).resolves.toBeNull();

  const empty = makeShell();
  addInstalledList(empty.manager, { empty: true });
  addSearch(empty.manager, "pcb");
  await expect(run(expression("empty"), empty.dom)).rejects.toThrow(/搜索框过滤/);

  const removed = makeShell();
  addInstalledList(removed.manager, { empty: true });
  addSearch(removed.manager, "pcb");
  await expect(run(expression("removed"), removed.dom)).rejects.toThrow(/搜索框过滤/);

  const fileInput = makeShell();
  addInstalledList(fileInput.manager, { empty: true });
  addFileInput(fileInput.manager);
  addSearch(fileInput.manager, "pcb");
  await expect(run(expression("file-input"), fileInput.dom)).rejects.toThrow(/搜索框过滤/);

  const cleared = makeShell();
  addInstalledList(cleared.manager, { empty: true });
  addSearch(cleared.manager, "   ");
  await expect(run(expression("empty"), cleared.dom)).resolves.toBe(true);
});

test("file-input 返回实际 input 对象，并在同一 eval 内复用 empty 判定", async () => {
  const shell = makeShell();
  const list = addInstalledList(shell.manager, { empty: true });
  const input = addFileInput(shell.manager);
  if (list.importTab)
    list.importTab.onclick = () => {
      throw new Error("不得点击导入");
    };
  await expect(run(expression("file-input"), shell.dom)).resolves.toBe(input);
  expect(list.importTab?.clicks).toBe(0);

  const wrongAccept = makeShell();
  addInstalledList(wrongAccept.manager, { empty: true });
  addFileInput(wrongAccept.manager, ".zip");
  await expect(run(expression("file-input"), wrongAccept.dom)).rejects.toThrow(/文件控件/);

  const multiple = makeShell();
  addInstalledList(multiple.manager, { empty: true });
  const multipleInput = addFileInput(multiple.manager);
  multipleInput.multiple = true;
  await expect(run(expression("file-input"), multiple.dom)).rejects.toThrow(/多选/);

  const disabled = makeShell();
  addInstalledList(disabled.manager, { empty: true });
  const disabledInput = addFileInput(disabled.manager);
  disabledInput.disabled = true;
  await expect(run(expression("file-input"), disabled.dom)).rejects.toThrow(/不可用/);

  const duplicate = makeShell();
  addInstalledList(duplicate.manager, { empty: true });
  addFileInput(duplicate.manager);
  addFileInput(duplicate.manager);
  await expect(run(expression("file-input"), duplicate.dom)).rejects.toThrow(/必须唯一/);

  const outside = makeShell();
  addInstalledList(outside.manager, { empty: true });
  addFileInput(outside.dom.body);
  await expect(run(expression("file-input"), outside.dom)).rejects.toThrow(/文件控件/);

  const occupied = makeShell();
  addInstalledList(occupied.manager, { cards: [CTX.displayName] });
  addFileInput(occupied.manager);
  await expect(run(expression("file-input"), occupied.dom)).rejects.toThrow(/已安装列表不为空/);

  const withPrompt = makeShell();
  addInstalledList(withPrompt.manager, { empty: true });
  addFileInput(withPrompt.manager);
  addDialog(withPrompt.dom);
  await expect(run(expression("file-input"), withPrompt.dom)).rejects.toThrow(/卸载确认对话框/);

  const withPermission = makeShell();
  addInstalledList(withPermission.manager, { empty: true });
  addFileInput(withPermission.manager);
  withPermission.manager.add(
    new FakeElement("input", "", {
      type: "checkbox",
      "data-test": "Allow interactive with external",
    }),
  );
  await expect(run(expression("file-input"), withPermission.dom)).rejects.toThrow(
    /已安装列表不为空/,
  );
});

test("displayName 里的引号/分号只作为字面量，不会变成脚本", async () => {
  const shell = makeShell();
  addInstalledList(shell.manager, { empty: true });
  const malicious = `x");globalThis.__mgrPwned = true;//`;
  const sandbox = { __mgrPwned: false } as Record<string, unknown>;
  await expect(
    run(expression("card", { ...CTX, displayName: malicious }), shell.dom, CTX.href, sandbox),
  ).resolves.toBe(false);
  expect(sandbox.__mgrPwned).toBe(false);
});
