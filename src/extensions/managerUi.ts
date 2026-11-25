/**
 * 扩展管理器（高级 -> 扩展管理器）的固定 UI 驱动表达式。
 *
 * 这里只拼固定表达式：`stage` 是有限枚举，`ManagerContext` 是结构化字段，
 * 没有任何“把用户 JS 原样丢进 Runtime.evaluate”的入口。主线程负责 CDP 传输与
 * CLI 轮询；本模块不连接浏览器、不启动进程、不读写扩展包。
 *
 * 返回约定（主线程按此实现轮询）：
 *
 * | stage           | 返回                                                       |
 * |-----------------|------------------------------------------------------------|
 * | open            | true（已打开或本次打开成功）；失败抛错                      |
 * | installed       | true（已点“已安装”）；null=管理器还在装载；false=没有该页签  |
 * | empty           | true=列表就绪且只有“暂无数据”、无选中详情；false=不空；未就绪抛错 |
 * | card            | true=详情已选中或点到唯一卡片；false=就绪但无唯一卡片；null=就绪未知 |
 * | details         | {enabled:boolean}；null=详情未就绪                          |
 * | config          | true（已点 scoped“配置”）；失败抛错                         |
 * | remove-prompt   | true（已点 scoped“卸载”）；权限已开/不匹配抛错              |
 * | remove-confirm  | true（已点“确认”）；对话框/勾选/绑定未就绪抛错              |
 * | removed         | true=列表就绪且条目与卸载提示都消失；否则 false             |
 * | file-input      | 实际的 input DOM 对象（必须 returnByValue:false 取 objectId） |
 *
 * 所有表达式在开头、每次 await 之后、每次点击之前都会重新执行同一组硬前置：
 * `location.href` 精确相等、`document.title` 精确相等、`document` 可见。表达式内
 * 没有任意字符串插值；上下文值全部经 `JSON.stringify` 作为字面量嵌入。
 *
 * 管理器/详情/对话框的定位沿用 4.1.105 实测结构：
 * - 管理器根 = 唯一可见“扩展管理器”标题的 parentElement 三次；
 * - 详情范围 = 唯一可见“配置”按钮的 parentElement 三次；
 * - 卸载对话框 = “此操作将永久卸载如下扩展，是否继续？”的唯一可见文本节点，
 *   向上找到最近的、只含一个“确认”的祖先。
 *
 * 不点击“导入”：历史实测里导入按钮出现后，文件 input 仍可能由独立动作触发；
 * 文件选择只返回 input 本身，由主线程用 DOM.setFileInputFiles 设置文件。
 *
 * 读数安全：
 * - 空列表标记同时接受 `暂无数据` 与 `暂无数据。`，但两者合计必须唯一；出现
 *   exact displayName、任何 `Vx.y` 版本行、详情/配置/UUID 或非空搜索值时都不算空；
 * - 管理器内任何 text/search 输入只要带非空值，就视为列表被旧搜索过滤：card
 *   返回 null，empty/removed/file-input 直接抛错，绝不拿过滤后的列表做负向回读；
 * - 详情里的“名称/native name”只在面板实际出现“名称”标签时按唯一标签 exact
 *   校验；历史 permission_probe 只证实 displayName/uuid，缺标签不判失败；
 * - remove-prompt 的“允许外部交互”开关只在目标详情 scope（配置按钮 parentElement
 *   三次）内查找，不读 manager 其他区域的同名开关；
 * - file-input 拒绝 `multiple` 或 `disabled` 的文件控件；
 * - 卸载流程拒绝自动确认：进入 remove-prompt 时已有卸载对话框则抛错，
 *   remove-confirm 进入时勾选框已勾选也抛错（只接受本次流程亲手勾选的那一个）。
 */

export type ManagerStage =
  | "open"
  | "installed"
  | "empty"
  | "card"
  | "details"
  | "config"
  | "remove-prompt"
  | "remove-confirm"
  | "removed"
  | "file-input";

export interface ManagerContext {
  href: string;
  title: string;
  displayName: string;
  name?: string;
  uuid: string;
  version: string;
}

export const MANAGER_STAGES: readonly ManagerStage[] = [
  "open",
  "installed",
  "empty",
  "card",
  "details",
  "config",
  "remove-prompt",
  "remove-confirm",
  "removed",
  "file-input",
];

export class ManagerUiUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagerUiUsageError";
  }
}

const BARE_UUID = /^[0-9a-f]{32}$/i;
const NAME_PATTERN = /^[@A-Za-z0-9][A-Za-z0-9@._/-]*$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;

function hasControlOrLineBreak(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ManagerUiUsageError(`扩展管理器 UI 上下文：${label} 必须是字符串`);
  }
  if (value.length === 0 || value.length > maxLength) {
    throw new ManagerUiUsageError(`扩展管理器 UI 上下文：${label} 长度必须在 1..${maxLength}`);
  }
  if (hasControlOrLineBreak(value)) {
    throw new ManagerUiUsageError(`扩展管理器 UI 上下文：${label} 不能包含控制字符或换行`);
  }
  return value;
}

function exactText(value: unknown, label: string, maxLength: number): string {
  const text = requiredText(value, label, maxLength);
  if (text !== text.trim()) {
    throw new ManagerUiUsageError(`扩展管理器 UI 上下文：${label} 不能带首尾空白`);
  }
  return text;
}

function requireHref(value: unknown): string {
  const href = requiredText(value, "href", 2048);
  if (href.includes("*")) {
    throw new ManagerUiUsageError("扩展管理器 UI 上下文：href 不接受通配符");
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new ManagerUiUsageError("扩展管理器 UI 上下文：href 不是合法绝对 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ManagerUiUsageError("扩展管理器 UI 上下文：href 只接受 http/https 编辑器页");
  }
  if (!url.hostname) {
    throw new ManagerUiUsageError("扩展管理器 UI 上下文：href 缺少主机名");
  }
  if (url.username || url.password) {
    throw new ManagerUiUsageError("扩展管理器 UI 上下文：href 不接受内嵌凭据");
  }
  return href;
}

function requireTitle(value: unknown): string {
  const title = requiredText(value, "title", 500);
  if (title.includes("*")) {
    throw new ManagerUiUsageError("扩展管理器 UI 上下文：title 不接受通配符");
  }
  return title;
}

function requireUuid(value: unknown): string {
  const uuid = requiredText(value, "uuid", 32);
  if (!BARE_UUID.test(uuid)) {
    throw new ManagerUiUsageError("扩展管理器 UI 上下文：uuid 必须是 32 位十六进制");
  }
  return uuid;
}

function requireVersion(value: unknown): string {
  const version = exactText(value, "version", 64);
  if (!VERSION_PATTERN.test(version)) {
    throw new ManagerUiUsageError("扩展管理器 UI 上下文：version 只接受版本号字符");
  }
  return version;
}

function requireName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const name = exactText(value, "name", 214);
  if (!NAME_PATTERN.test(name)) {
    throw new ManagerUiUsageError("扩展管理器 UI 上下文：name 不是合法的扩展原生名");
  }
  return name;
}

function validateStage(stage: unknown): ManagerStage {
  if (!(MANAGER_STAGES as readonly string[]).includes(stage as string)) {
    throw new ManagerUiUsageError(`扩展管理器 UI：不认识的阶段 ${String(stage)}`);
  }
  return stage as ManagerStage;
}

export function managerExpression(stage: ManagerStage, ctx: ManagerContext): string {
  if (ctx === null || typeof ctx !== "object") {
    throw new ManagerUiUsageError("扩展管理器 UI 上下文：必须是对象");
  }
  const currentStage = validateStage(stage);
  const href = requireHref(ctx.href);
  const title = requireTitle(ctx.title);
  const displayName = exactText(ctx.displayName, "displayName", 200);
  const name = requireName(ctx.name);
  const uuid = requireUuid(ctx.uuid);
  const version = requireVersion(ctx.version);

  const literals = [
    `const __MGR_HREF = ${JSON.stringify(href)};`,
    `const __MGR_TITLE = ${JSON.stringify(title)};`,
    `const __MGR_DISPLAY_NAME = ${JSON.stringify(displayName)};`,
    `const __MGR_NATIVE_NAME = ${name === undefined ? "null" : JSON.stringify(name)};`,
    `const __MGR_UUID = ${JSON.stringify(uuid)};`,
    `const __MGR_VERSION = ${JSON.stringify(version)};`,
    `const __MGR_INSTRUCTION = ${JSON.stringify("此操作将永久卸载如下扩展，是否继续？")};`,
  ].join("\n  ");

  const asynchronous =
    currentStage !== "card" &&
    currentStage !== "details" &&
    currentStage !== "removed" &&
    currentStage !== "file-input";
  const wrapperOpen = asynchronous ? "(async () => {" : "(() => {";
  return `${wrapperOpen}\n  ${literals}\n${PRELUDE}\n${bodyFor(currentStage)}\n})();`;
}

const PRELUDE = String.raw`
  const __mgrFail = (message) => { throw new Error('扩展管理器 UI: ' + message); };
  const __mgrVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
    if (typeof getComputedStyle !== 'function') return true;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const __mgrText = (el) => String(el.textContent == null ? '' : el.textContent).trim();
  const __mgrFind = (text, root = document) => Array.prototype.slice.call(root.querySelectorAll('span,div,p,button'))
    .filter((el) => !el.childElementCount && __mgrVisible(el) && __mgrText(el) === text);
  const __mgrEmptyMarkers = (manager) => __mgrFind('暂无数据', manager).concat(__mgrFind('暂无数据。', manager));
  const __mgrOne = (list, label) => {
    if (list.length !== 1) __mgrFail(label + ' 必须唯一可见，实际 ' + list.length);
    return list[0];
  };
  const __mgrSearchValue = (manager) => {
    const inputs = Array.prototype.slice.call(manager.querySelectorAll('input'));
    for (const input of inputs) {
      const type = String(input.getAttribute('type') || 'text').toLowerCase();
      if (type !== 'text' && type !== 'search') continue;
      const value = String(input.value == null ? '' : input.value).trim();
      if (value.length > 0) return value;
    }
    return null;
  };
  const __mgrLines = (root) => String(root.innerText == null ? '' : root.innerText)
    .replace(/\r/g, '').split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const __mgrCount = (list, value) => list.reduce((total, item) => total + (item === value ? 1 : 0), 0);
  const __mgrSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const __mgrGuard = () => {
    if (String(location.href) !== __MGR_HREF) __mgrFail('href 与登记的编辑器页不一致');
    if (String(document.title) !== __MGR_TITLE) __mgrFail('title 与登记的编辑器页不一致');
    if (!document.body || document.visibilityState !== 'visible') __mgrFail('document 不可见，拒绝操作');
  };
  const __mgrManager = () => {
    const headings = __mgrFind('扩展管理器');
    if (headings.length === 0) return null;
    const heading = __mgrOne(headings, '扩展管理器 标题');
    const first = heading.parentElement;
    const second = first && first.parentElement;
    const manager = second && second.parentElement;
    if (!manager || !__mgrVisible(manager)) return null;
    return manager;
  };
  const __mgrRequireManager = (label) => {
    const manager = __mgrManager();
    if (!manager) __mgrFail(label + ' 需要扩展管理器已打开');
    return manager;
  };
  const __mgrWaitFor = async (probe, attempts, stepMs) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      __mgrGuard();
      const value = probe();
      if (value) return value;
      if (attempt + 1 < attempts) await __mgrSleep(stepMs);
    }
    return null;
  };
  const __mgrWaitManager = async (attempts, stepMs) => await __mgrWaitFor(__mgrManager, attempts, stepMs);
  const __mgrWaitOne = async (text, root, attempts, stepMs) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      __mgrGuard();
      const found = __mgrFind(text, root);
      if (found.length > 1) __mgrFail(text + ' 必须唯一可见，实际 ' + found.length);
      if (found.length === 1) return found[0];
      if (attempt + 1 < attempts) await __mgrSleep(stepMs);
    }
    return null;
  };
  const __mgrClickable = (el) => {
    if (!__mgrVisible(el)) return false;
    if (el.disabled === true) return false;
    if (typeof el.getAttribute === 'function' && el.getAttribute('aria-disabled') === 'true') return false;
    if (/disabled/i.test(String(el.className || ''))) return false;
    if (typeof getComputedStyle !== 'function') return true;
    const style = getComputedStyle(el);
    return style.pointerEvents !== 'none' && style.cursor !== 'not-allowed';
  };
  const __mgrDetails = (manager) => {
    const buttons = __mgrFind('配置', manager);
    if (buttons.length === 0) return null;
    const button = __mgrOne(buttons, '配置 按钮');
    const first = button.parentElement;
    const second = first && first.parentElement;
    const scope = second && second.parentElement;
    if (!scope || !__mgrVisible(scope)) return null;
    return { button: button, scope: scope };
  };
  const __mgrVersionMarkers = (manager) => Array.prototype.slice.call(manager.querySelectorAll('span,div,p'))
    .filter((el) => !el.childElementCount && __mgrVisible(el) && /^V[0-9]+\.[0-9]+/.test(__mgrText(el)));
  const __mgrListReady = (manager) => {
    if (__mgrFind('已安装', manager).length !== 1) return false;
    if (__mgrFind('导入', manager).length !== 1) return false;
    if (__mgrEmptyMarkers(manager).length === 1) return true;
    if (__mgrFind(__MGR_DISPLAY_NAME, manager).length > 0) return true;
    return __mgrVersionMarkers(manager).length > 0;
  };
  const __mgrHasUuidLine = (root) => __mgrLines(root).some((line) => /^[0-9a-f]{32}$/i.test(line));
  const __mgrDetailsState = (manager) => {
    const details = __mgrDetails(manager);
    if (!details) return null;
    const scope = details.scope;
    const lines = __mgrLines(scope);
    if (__mgrCount(lines, __MGR_DISPLAY_NAME) !== 1) __mgrFail('详情缺少唯一的显示名');
    if (__mgrCount(lines, 'V' + __MGR_VERSION) !== 1) __mgrFail('详情缺少唯一的版本');
    if (__mgrCount(lines, 'UUID') !== 1) __mgrFail('详情 UUID 标签不唯一');
    const uuidIndex = lines.indexOf('UUID');
    if (uuidIndex < 0 || lines[uuidIndex + 1] !== __MGR_UUID) __mgrFail('详情 UUID 值不匹配');
    let nativeNameIndex = -1;
    if (__MGR_NATIVE_NAME !== null) {
      // 4.1.105 实机样本只证实 displayName / uuid；机器名标签不是每次都出现。
      // 出现“名称”就按唯一标签 exact 校验，没出现则不把缺标签当成失败。
      const nameLabels = __mgrCount(lines, '名称');
      if (nameLabels > 1) __mgrFail('详情名称标签不唯一');
      if (nameLabels === 1) {
        nativeNameIndex = lines.indexOf('名称') + 1;
        if (lines[nativeNameIndex] !== __MGR_NATIVE_NAME) __mgrFail('详情原生名称不匹配');
      }
    }
    const uuidValues = lines.filter((line, index) => index !== nativeNameIndex && /^[0-9a-f]{32}$/i.test(line));
    if (uuidValues.length !== 1 || uuidValues[0] !== __MGR_UUID) __mgrFail('详情 UUID 记录不唯一');
    if (__mgrFind('卸载', scope).length !== 1) __mgrFail('详情卸载按钮不唯一');
    const enabled = __mgrCount(lines, '已启用');
    const disabled = __mgrCount(lines, '已禁用');
    if (enabled + disabled !== 1) __mgrFail('详情启用状态不唯一');
    return { enabled: enabled === 1 };
  };
  const __mgrEmptyState = (manager) => {
    if (__mgrDetails(manager) !== null) return false;
    if (__mgrFind('配置', manager).length !== 0) return false;
    if (__mgrFind('UUID', manager).length !== 0) return false;
    if (__mgrHasUuidLine(manager)) return false;
    if (__mgrFind(__MGR_DISPLAY_NAME, manager).length !== 0) return false;
    if (__mgrVersionMarkers(manager).length !== 0) return false;
    if (__mgrSearchValue(manager) !== null) return false;
    const permission = __mgrPermissionBox(manager);
    if (permission && __mgrVisible(permission)) return false;
    if (__mgrEmptyMarkers(manager).length !== 1) return false;
    if (__mgrFind('已安装', manager).length !== 1) return false;
    if (__mgrFind('导入', manager).length !== 1) return false;
    return true;
  };
  const __mgrPermissionBox = (root) => {
    const boxes = Array.prototype.slice.call(root.querySelectorAll('input[type=checkbox]'))
      .filter((el) => el.getAttribute('data-test') === 'Allow interactive with external');
    if (boxes.length === 0) return null;
    if (boxes.length > 1) __mgrFail('允许外部交互开关不唯一');
    return boxes[0];
  };
  const __mgrDialog = () => {
    const instructions = __mgrFind(__MGR_INSTRUCTION);
    if (instructions.length === 0) return null;
    const instruction = __mgrOne(instructions, '卸载确认说明');
    let scope = instruction.parentElement;
    while (scope && scope !== document.body) {
      const confirms = __mgrFind('确认', scope);
      if (confirms.length === 1) break;
      if (confirms.length > 1) __mgrFail('卸载确认按钮不唯一');
      scope = scope.parentElement;
    }
    if (!scope || scope === document.body || !__mgrVisible(scope)) __mgrFail('卸载确认对话框不可见');
    return { scope: scope, instruction: instruction };
  };
  const __mgrAssertDialog = (dialog) => {
    const scope = dialog.scope;
    const lines = __mgrLines(scope);
    if (__mgrCount(lines, __MGR_INSTRUCTION) !== 1) __mgrFail('卸载说明不唯一');
    const nameLines = lines.filter((line) => line.indexOf('名称：') === 0);
    if (nameLines.length !== 1 || nameLines[0] !== '名称：' + __MGR_DISPLAY_NAME) __mgrFail('卸载对话框名称不匹配');
    const versionLines = lines.filter((line) => line.indexOf('版本：') === 0);
    if (versionLines.length !== 1 || versionLines[0] !== '版本：V' + __MGR_VERSION) __mgrFail('卸载对话框版本不匹配');
    const uuidLines = lines.filter((line) => line.indexOf('UUID：') === 0);
    if (uuidLines.length !== 1 || uuidLines[0] !== 'UUID：' + __MGR_UUID) __mgrFail('卸载对话框 UUID 不匹配');
    const boxes = Array.prototype.slice.call(scope.querySelectorAll('input[type=checkbox]'));
    if (boxes.length !== 1) __mgrFail('卸载确认勾选框不唯一');
    const confirms = __mgrFind('确认', scope);
    if (confirms.length !== 1) __mgrFail('卸载确认按钮不唯一');
    return { scope: scope, box: boxes[0], confirm: confirms[0] };
  };
`;

function bodyFor(stage: ManagerStage): string {
  switch (stage) {
    case "open":
      return String.raw`
  __mgrGuard();
  if (__mgrManager()) return true;
  let entry = await __mgrWaitOne('扩展管理器(E)...', document, 3, 250);
  if (!entry) {
    const advanced = await __mgrWaitOne('高级', document, 3, 250);
    if (!advanced) __mgrFail('找不到「高级」菜单，无法打开扩展管理器');
    advanced.click();
    await __mgrSleep(350);
    __mgrGuard();
    entry = await __mgrWaitOne('扩展管理器(E)...', document, 8, 250);
    if (!entry) __mgrFail('「高级」菜单没有出现扩展管理器入口');
  }
  entry.click();
  await __mgrSleep(550);
  __mgrGuard();
  if (!(await __mgrWaitManager(10, 250))) __mgrFail('点击扩展管理器后没有出现管理器面板');
  return true;`;
    case "installed":
      return String.raw`
  __mgrGuard();
  const manager = await __mgrWaitManager(8, 250);
  __mgrGuard();
  if (!manager) return null;
  const tab = await __mgrWaitOne('已安装', manager, 6, 250);
  __mgrGuard();
  if (!tab) return false;
  tab.click();
  await __mgrSleep(250);
  __mgrGuard();
  return true;`;
    case "empty":
      return String.raw`
  __mgrGuard();
  const manager = await __mgrWaitManager(8, 250);
  __mgrGuard();
  if (!manager) __mgrFail('扩展管理器未打开，无法确认空列表');
  if (__mgrSearchValue(manager) !== null) __mgrFail('已安装列表被搜索框过滤，拒绝确认空列表');
  const ready = await __mgrWaitFor(() => (__mgrListReady(manager) ? manager : null), 8, 250);
  __mgrGuard();
  if (!ready) __mgrFail('已安装列表未就绪，无法确认空列表');
  if (__mgrSearchValue(manager) !== null) __mgrFail('已安装列表被搜索框过滤，拒绝确认空列表');
  if (!__mgrEmptyState(manager)) return false;
  // “暂无数据”可能是加载中的临时占位；隔一拍复查，只有仍然为空才认。
  await __mgrSleep(250);
  __mgrGuard();
  if (__mgrSearchValue(manager) !== null) __mgrFail('已安装列表被搜索框过滤，拒绝确认空列表');
  return __mgrEmptyState(manager);`;
    case "card":
      return String.raw`
  __mgrGuard();
  const manager = __mgrRequireManager('选择扩展卡片');
  if (__mgrDetails(manager) !== null) return true;
  if (__mgrSearchValue(manager) !== null) return null;
  if (!__mgrListReady(manager)) return null;
  const cards = __mgrFind(__MGR_DISPLAY_NAME, manager);
  if (cards.length !== 1) return false;
  if (!__mgrClickable(cards[0])) return false;
  cards[0].click();
  return true;`;
    case "details":
      return String.raw`
  __mgrGuard();
  const manager = __mgrManager();
  if (!manager) return null;
  if (!__mgrDetails(manager)) return null;
  return __mgrDetailsState(manager);`;
    case "config":
      return String.raw`
  __mgrGuard();
  const manager = __mgrRequireManager('打开配置');
  const details = await __mgrWaitFor(() => __mgrDetails(manager), 8, 250);
  if (!details) __mgrFail('详情面板没有出现');
  __mgrGuard();
  __mgrDetailsState(manager);
  if (__mgrFind(__MGR_INSTRUCTION).length !== 0) __mgrFail('已有卸载确认对话框，拒绝在对话框下操作配置');
  if (!__mgrClickable(details.button)) __mgrFail('配置按钮不可点击');
  details.button.click();
  await __mgrSleep(250);
  __mgrGuard();
  return true;`;
    case "remove-prompt":
      return String.raw`
  __mgrGuard();
  const manager = __mgrRequireManager('卸载扩展');
  let details = await __mgrWaitFor(() => __mgrDetails(manager), 8, 250);
  if (!details) __mgrFail('详情面板没有出现');
  __mgrDetailsState(manager);
  const box = await __mgrWaitFor(() => {
    const current = __mgrDetails(manager);
    return current ? __mgrPermissionBox(current.scope) : null;
  }, 8, 250);
  if (!box) __mgrFail('目标配置面板没有出现「允许外部交互」开关');
  __mgrGuard();
  details = __mgrDetails(manager);
  if (!details) __mgrFail('配置打开后详情面板消失');
  __mgrDetailsState(manager);
  const permission = __mgrPermissionBox(details.scope);
  if (!permission) __mgrFail('目标配置面板没有出现「允许外部交互」开关');
  if (permission.checked) __mgrFail('「允许外部交互」仍开启，拒绝卸载；请手动关闭权限后重试');
  if (!__mgrVisible(permission)) __mgrFail('「允许外部交互」开关不可见，拒绝卸载');
  if (__mgrFind(__MGR_INSTRUCTION).length !== 0) __mgrFail('已有卸载确认对话框，拒绝自动确认');
  const uninstall = __mgrOne(__mgrFind('卸载', details.scope), '卸载 按钮');
  if (!__mgrClickable(uninstall)) __mgrFail('卸载按钮不可点击');
  __mgrGuard();
  uninstall.click();
  await __mgrSleep(250);
  __mgrGuard();
  return true;`;
    case "remove-confirm":
      return String.raw`
  __mgrGuard();
  __mgrRequireManager('卸载确认');
  const dialog = await __mgrWaitFor(__mgrDialog, 8, 250);
  if (!dialog) __mgrFail('卸载确认对话框没有出现');
  let bound = __mgrAssertDialog(dialog);
  if (bound.box.checked) __mgrFail('进入确认阶段时勾选框已勾选，拒绝自动确认');
  if (bound.box.disabled === true) __mgrFail('卸载确认勾选框不可用');
  bound.box.click();
  let acknowledged = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await __mgrSleep(150);
    __mgrGuard();
    const next = __mgrDialog();
    if (!next) __mgrFail('勾选后卸载确认对话框消失');
    const re = __mgrAssertDialog(next);
    if (re.box.checked) { acknowledged = true; break; }
  }
  if (!acknowledged) __mgrFail('卸载确认勾选框未生效');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    __mgrGuard();
    const current = __mgrDialog();
    if (!current) __mgrFail('卸载确认对话框消失');
    const re = __mgrAssertDialog(current);
    if (re.box.checked && __mgrClickable(re.confirm)) break;
    await __mgrSleep(150);
  }
  __mgrGuard();
  const last = __mgrDialog();
  if (!last) __mgrFail('卸载确认对话框消失');
  bound = __mgrAssertDialog(last);
  if (!bound.box.checked) __mgrFail('卸载确认勾选框未生效');
  if (!__mgrClickable(bound.confirm)) __mgrFail('卸载确认按钮未就绪');
  bound.confirm.click();
  return true;`;
    case "removed":
      return String.raw`
  __mgrGuard();
  const manager = __mgrRequireManager('回读卸载结果');
  if (__mgrSearchValue(manager) !== null) __mgrFail('已安装列表被搜索框过滤，拒绝回读卸载结果');
  if (!__mgrListReady(manager)) return false;
  if (__mgrDetails(manager) !== null) return false;
  const permission = __mgrPermissionBox(manager);
  if (permission && __mgrVisible(permission)) return false;
  const row = __mgrFind(__MGR_DISPLAY_NAME, manager).length !== 0;
  const uuid = __mgrFind('UUID', manager).length !== 0 || __mgrHasUuidLine(manager);
  const prompt = __mgrFind(__MGR_INSTRUCTION).length !== 0;
  return !row && !uuid && !prompt;`;
    case "file-input":
      return String.raw`
  __mgrGuard();
  const manager = __mgrRequireManager('选择扩展包');
  if (__mgrSearchValue(manager) !== null) __mgrFail('已安装列表被搜索框过滤，拒绝选择扩展包');
  if (__mgrFind(__MGR_INSTRUCTION).length !== 0) __mgrFail('卸载确认对话框仍打开，拒绝选择扩展包');
  if (!__mgrEmptyState(manager)) __mgrFail('已安装列表不为空（需显示「暂无数据」），拒绝选择扩展包');
  const inputs = Array.prototype.slice.call(manager.querySelectorAll('input[type=file]'))
    .filter((el) => String(el.getAttribute('accept') || '').toLowerCase().indexOf('.eext') !== -1);
  const input = __mgrOne(inputs, '扩展包文件控件');
  if (input.multiple === true) __mgrFail('扩展包文件控件允许多选，拒绝');
  if (input.disabled === true) __mgrFail('扩展包文件控件不可用，拒绝');
  if (__mgrFind(__MGR_DISPLAY_NAME, manager).length !== 0) __mgrFail('管理器已显示同名扩展，拒绝覆盖导入');
  if (!__mgrEmptyState(manager)) __mgrFail('已安装列表不为空（需显示「暂无数据」），拒绝选择扩展包');
  __mgrGuard();
  return input;`;
    default: {
      const never: never = stage;
      throw new ManagerUiUsageError(`扩展管理器 UI：不认识的阶段 ${String(never)}`);
    }
  }
}
