/**
 * 编辑器状态探针（历史预览态 / 模态框句柄 / 工程与文档信息）的 JS 载荷。
 *
 * 这里是**单一真源**：DETECT_JS 与 CLICK_MODAL_BUTTON_JS 共用同一段模态框探针，
 * 抄两遍必然漂移——检测说能点、点击路径判不能点，就是假绿。字符串原样搬自
 * leonskill-easyeda-cdp-connect/scripts/_board.py（MIT），只改了容器写法。
 */

/** 模态框探针的公共函数块（可见性、唯一选择器、按钮识别、层级、命中测试、React 合成事件）。 */
export const MODAL_PROBE_JS = String.raw`
  // ---- 模态框探针（DETECT_JS / CLICK_MODAL_BUTTON_JS 共用） ----
  function __mEsc(s){
    if (globalThis.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function(c){ return '\\' + c; });
  }
  function __mVisible(el){
    if (!el || el.nodeType !== 1) return false;
    // 与 topTabTip 同一类坑：容器常驻 DOM，只按 rect 判会误判。可选 API，老 Engine 退回 rect。
    // **但窗口最小化/被遮挡时 ${"`"}checkVisibility()${"`"} 对整页恒为 false**（实测 2026-11-11：窗口
    // 最小化后 5 个 1200×753 的对话框节点全被判定不可见 → modals=[] → writable=true），
    // 那会让写闸口在后台静默放行。此时只能退回几何判据（后面的 rect 与尺寸门仍然生效）。
    if (document.visibilityState === 'visible' && el.checkVisibility && !el.checkVisibility()) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function __mRect(el){
    var r = el.getBoundingClientRect();
    return {x: Math.round(r.left), y: Math.round(r.top),
            w: Math.round(r.width), h: Math.round(r.height)};
  }
  function __mUnique(sel){
    try { return !!sel && document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }
  function __mPath(el){
    // 逐层向上拼，每加一层就用 querySelectorAll 复核「唯一」：唯一即停（短路径最好读）。
    // 拼到 body 仍不唯一就返回 null —— 宁可给 null，也不给一个会选中别人的假选择器。
    if (!el || el.nodeType !== 1) return null;
    if (el.id && __mUnique('#' + __mEsc(el.id))) return '#' + __mEsc(el.id);
    var parts = [], cur = el, guard = 0;
    while (cur && cur.nodeType === 1 && guard++ < 12) {
      if (cur.id && __mUnique('#' + __mEsc(cur.id))) {
        parts.unshift('#' + __mEsc(cur.id));
        var viaId = parts.join(' > ');
        return __mUnique(viaId) ? viaId : null;
      }
      var seg = cur.tagName.toLowerCase();
      var cls = [];
      if (typeof cur.className === 'string') {
        cls = cur.className.trim().split(/\s+/).filter(function(c){ return c && !/^\d/.test(c); });
      }
      if (cls.length) seg += '.' + cls.map(__mEsc).join('.');
      var parent = cur.parentElement;
      if (parent) {
        var same = 0, idx = 0, kids = parent.children;
        for (var i = 0; i < kids.length; i++) {
          if (kids[i].tagName !== cur.tagName) continue;
          same += 1;
          if (kids[i] === cur) idx = same;
        }
        if (same > 1) seg += ':nth-of-type(' + idx + ')';
      }
      parts.unshift(seg);
      var sel = parts.join(' > ');
      if (__mUnique(sel)) return sel;
      cur = parent;
    }
    return null;
  }
  function __mText(el){
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function __mKind(text){
    // 只做「要不要拦」的粗分类；真正的「不许点」策略在 Python 侧（dismiss_modal）。
    var t = (text || '').trim();
    if (/^(确定|确认|应用|保存|是|好|ok|yes|apply|save)$/i.test(t)) return 'primary';
    if (/^(取消|关闭|否|放弃|cancel|close|no|dismiss)$/i.test(t)) return 'cancel';
    return 'other';
  }
  function __mTopmost(el){
    // 命中测试：按钮中心点上最顶层的元素必须是自己或自己的后代，否则就是被遮挡。
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit) return false;                       // 中心点在视口外
    return el === hit || el.contains(hit);
  }
  function __mClickable(el){
    if ('disabled' in el && el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    // EDA 的「禁用」多数是 **class + cursor** 表达的，不是 disabled 属性：实测「设计规则」
    // 对话框里「默认」按钮带 ${"`"}_disabled_${"`"} 类、${"`"}cursor:not-allowed${"`"}，但 ${"`"}disabled${"`"} 属性是 false、
    // ${"`"}pointer-events${"`"} 仍是 auto —— 只看属性 + 命中测试会把它误报成「可点」。宁可保守：
    // 带 disabled 类或 cursor:not-allowed 一律不算可点（假阴性代价是「请手动关」，可接受）。
    if (/disabled/i.test(String(el.className || ''))) return false;
    var cs = globalThis.getComputedStyle ? getComputedStyle(el) : null;
    if (cs) {
      if (cs.pointerEvents === 'none') return false;
      if (cs.cursor === 'not-allowed') return false;
      if (cs.visibility === 'hidden' || cs.display === 'none') return false;
      if (parseFloat(cs.opacity || '1') === 0) return false;
    }
    return __mTopmost(el);
  }
  function __mButtons(modal){
    var sel = 'button, [role="button"], [class*="btn"], [class*="Btn"], ' +
              '[class*="button"], [class*="Button"]';
    var raw = Array.prototype.slice.call(modal.querySelectorAll(sel));
    var out = [], kept = [];
    for (var i = 0; i < raw.length; i++) {
      var el = raw[i];
      // **容器不是按钮。** 底栏常写成 ${"`"}div.pop-footer-wrapper.dialog-btns-wrapper${"`"}，
      // 类名含 btn 就命中上面的选择器；再走「嵌套只留外层」它就成了唯一按钮，
      // 把 5 个真按钮全吞掉（真机实测：图层管理器因此只剩 1 个伪按钮，
      // text="导入 导出 应用 确认 取消"，dismiss_modal('取消') 报 label-not-found，关不掉）。
      // 判据必须是「内部还有真按钮」而不是文本长度：footer 的合并文本只有 12 个字，
      // 用长度判会漏。真按钮（BUTTON / role=button）自身不含后代按钮，不受伤。
      if (el.querySelector('button, [role="button"]')) continue;
      var dup = false;
      for (var k = 0; k < kept.length; k++) {
        if (kept[k] === el || kept[k].contains(el) || el.contains(kept[k])) { dup = true; break; }
      }
      if (dup) continue;                          // 嵌套按钮只留外层，避免同一条文案出现两次
      if (!__mVisible(el)) continue;
      var text = __mText(el);
      if (!text || text.length > 24) continue;    // 长文本多是说明区，不是按钮
      kept.push(el);
      out.push({el: el, text: text, tag: el.tagName, kind: __mKind(text), index: out.length,
                selector: __mPath(el), rect: __mRect(el), clickable: __mClickable(el)});
    }
    return out;
  }
  function __mZ(el){
    var cur = el, best = null;
    while (cur && cur.nodeType === 1) {
      var cs = globalThis.getComputedStyle ? getComputedStyle(cur) : null;
      var z = cs ? parseInt(cs.zIndex, 10) : NaN;
      if (!isNaN(z) && (best === null || z > best)) best = z;
      cur = cur.parentElement;
    }
    return best;                                  // null = 整条祖先链都是 auto
  }
  function __mModals(){
    var els = Array.prototype.slice.call(document.querySelectorAll(
      '[class*="lc_modal"], [class*="modal"], [class*="dialog"]'));
    var cand = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!__mVisible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) continue;   // 容器/遮罩常驻 DOM，按尺寸排掉
      var t = __mText(el);
      if (!t) continue;
      var d = 0, c = el;
      while (c && c.parentElement) { d += 1; c = c.parentElement; }
      // 对话框名在 ${"`"}[class*=header_left]${"`"} 里，**不在 innerText 开头**——innerText 起手就是
      // 内容区（实测取到的是「规则管理 网络规则 网络-网络规则 区域规则 间」，那是页签+内容，
      // 不是名字）。取不到才退回内容区前 24 字：${"`"}title${"`"} 的语义仍是「对话框标题」，只是取法变准。
      // 顺带修好下游：${"`"}dialog-taxonomy.json${"`"} 的 ${"`"}title_pattern: "^设计规则"${"`"} 之前匹配不上
      // 就是因为这里拿的是内容区文字。
      var head = el.querySelector('[class*="header_left"], [class*="header-left"], ' +
                                  '[class*="dialog_title"], [class*="dialog-title"]');
      var name = head ? __mText(head) : '';
      cand.push({el: el, title: (name || t).slice(0, 24), text: t.slice(0, 200),
                 selector: __mPath(el), z_index: __mZ(el), depth: d,
                 rect: __mRect(el), buttons: __mButtons(el)});
    }
    // 同一对话框往往有多层 class 命中（遮罩/外壳/内容区）。取**最内层**：外壳会把整块
    // 遮罩的文字与别的按钮算进来。若内层一个按钮都没有（纯文字容器），退回全部候选。
    var withBtn = cand.filter(function(m){ return m.buttons.length > 0; });
    var pool = withBtn.length ? withBtn : cand;
    var out = pool.filter(function(m){
      for (var k = 0; k < pool.length; k++) {
        if (pool[k] !== m && m.el.contains(pool[k].el)) return false;   // 自己包着更内层的候选
      }
      return true;
    });
    // stack_index：1 = 最上层。按 z_index（null 当 0）稳定升序后倒着编号，同 z 时按 DOM 序。
    var order = out.map(function(m, i){ return {i: i, z: m.z_index === null ? 0 : m.z_index}; });
    order.sort(function(a, b){ return a.z === b.z ? a.i - b.i : a.z - b.z; });
    for (var j = 0; j < order.length; j++) out[order[j].i].stack_index = order.length - j;
    return out;
  }
  function __mPublic(m){
    return {title: m.title, text: m.text, selector: m.selector, z_index: m.z_index,
            depth: m.depth, rect: m.rect, stack_index: m.stack_index,
            buttons: m.buttons.map(function(b){
              return {text: b.text, tag: b.tag, kind: b.kind, index: b.index,
                      selector: b.selector, rect: b.rect, clickable: b.clickable};
            })};
  }
  function __mFire(el){
    // React 合成事件：props.onClick 才是真的处理函数（el.click() 在部分弹窗上不触发）。
    var key = Object.keys(el).find(function(k){ return k.indexOf('__reactProps$') === 0; });
    var props = key ? el[key] : null;
    if (props && typeof props.onClick === 'function') {
      props.onClick({currentTarget: el, target: el,
                     preventDefault: function(){}, stopPropagation: function(){}});
      return 'react';
    }
    if (typeof el.click === 'function') { el.click(); return 'dom'; }
    return 'none';
  }
`;

/** 只读检测：历史预览横幅、历史面板、模态框句柄、工程名、文档类型。返回 JSON 字符串。 */
export const DETECT_JS =
  "(async () => {\n" +
  MODAL_PROBE_JS +
  String.raw`
  const A = globalThis._EXTAPI_ROOT_;
  const out = {history_preview: false, banner_text: null, history_panel: false,
               modals: []};
  // 1) 橙色横幅：容器常驻 DOM，只有可见（高度>2）才是激活
  for (const tip of Array.from(document.querySelectorAll('[class*="topTabTip"]'))) {
    const r = tip.getBoundingClientRect();
    if (r.height > 2 && r.width > 100) {
      out.history_preview = true;
      out.banner_text = (tip.innerText || '').trim().slice(0, 20) || '(无文字)';
    }
  }
  // 2) 历史面板：带时间戳的记录行可见
  const rows = Array.from(document.querySelectorAll('[class*="tree-rowline"]')).filter(e => {
    const r = e.getBoundingClientRect();
    const t = (e.textContent || '').trim();
    return r.width > 80 && r.height > 20 && /\d{1,2}:\d{2}/.test(t) && t.length < 60;
  });
  out.history_panel = rows.length > 0;
  // 3) 模态框：带可点句柄（selector / rect / z_index / stack_index / buttons[*].clickable）
  out.modals = __mModals().map(__mPublic);
  let project = null, docType = null;
  try {
    const p = await A.dmt_Project.getCurrentProjectInfo();
    project = p ? p.friendlyName : null;
    const d = await A.dmt_SelectControl.getCurrentDocumentInfo();
    docType = d ? d.documentType : null;
  } catch (e) {}
  out.project = project;
  out.docType = docType;
  return JSON.stringify(out);
})()
`;

/** 点击检测阶段已选中的那个按钮：只点一次、只点给定的那个，没有任何兜底点击。 */
export const CLICK_MODAL_BUTTON_JS =
  "(async () => {\n" +
  MODAL_PROBE_JS +
  String.raw`
  const modalIndex = __MODAL_INDEX__;
  const modalSel = __MODAL_SEL__;
  const btnIndex = __BTN_INDEX__;
  const list = __mModals();
  let modal = null;
  if (modalSel) {
    for (let i = 0; i < list.length; i++) { if (list[i].selector === modalSel) { modal = list[i]; break; } }
  }
  if (!modal) modal = list[modalIndex] || null;   // 选择器拼不出来时退回序号（顺序与检测时一致）
  if (!modal) return JSON.stringify({clicked: false, reason: 'modal-gone', text: null, via: null});
  const btn = modal.buttons[btnIndex];
  if (!btn) return JSON.stringify({clicked: false, reason: 'button-gone', text: null, via: null});
  if (!__mClickable(btn.el)) {
    return JSON.stringify({clicked: false, reason: 'not-clickable', text: btn.text, via: null});
  }
  const via = __mFire(btn.el);
  return JSON.stringify({clicked: via !== 'none', reason: via === 'none' ? 'no-handler' : 'clicked',
                         text: btn.text, via: via});
})()
`;

/** 输出键序固定成契约形状（state_check 打印它），别让新增字段漂走。 */
export const STATE_KEYS = [
  "history_preview",
  "banner_text",
  "history_panel",
  "modals",
  "writable",
  "blocked",
  "project",
  "docType",
] as const;

/** modals[*] 的字段契约（与 __mPublic 一一对应；测试钉住「加了字段却没写进 JSON」）。 */
export const MODAL_FIELDS = [
  "title",
  "text",
  "selector",
  "z_index",
  "depth",
  "rect",
  "stack_index",
  "buttons",
] as const;

/** modals[*].buttons[*] 的字段契约；tag 必须是大写 tagName 原值，不得小写化。 */
export const MODAL_BUTTON_FIELDS = [
  "text",
  "tag",
  "kind",
  "index",
  "selector",
  "rect",
  "clickable",
] as const;

export const BUTTON_KINDS = ["primary", "cancel", "other"] as const;

export const UNWRITABLE_HINT = "关闭历史预览横幅/对话框后重试";

/** 把 CLICK_MODAL_BUTTON_JS 的三个占位符换成实际序号与选择器。 */
export function clickModalButtonExpression(
  modalIndex: number,
  modalSelector: string | null,
  buttonIndex: number,
): string {
  return CLICK_MODAL_BUTTON_JS.replace("__MODAL_INDEX__", String(modalIndex))
    .replace("__MODAL_SEL__", JSON.stringify(modalSelector))
    .replace("__BTN_INDEX__", String(buttonIndex));
}
