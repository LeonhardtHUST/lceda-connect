---
name: leonskill-easyeda-cdp-connect
description: "连接并操作本机运行的嘉立创EDA（立创EDA专业版 / LCEDA Pro）桌面客户端：用 Chrome DevTools 协议接管窗口，完成端点发现、界面探查（区域树、菜单全表、工程树清单、多状态对比、带标注截图）与设计操作（读图元/网络/DRC/规则、坐标标定与点击、改图元、写设计规则、重建铺铜、差分对定义与布线、网络类与类规则、美学校验）。当用户说「连一下我的立创EDA」「让 AI 看看我立创里开的是什么」「用 CDP 接管 / 操作嘉立创EDA」「立创EDA 能不能开调试端口」「帮我自动化操作立创界面」「给立创EDA做一份界面地图」「扫一下立创的界面结构」「立创的菜单栏里都有什么」「再扫一次跟上次比哪里变了」「看看这块板子的状态 / DRC」「帮我布一对差分对」「建一对差分对 / 网络类」「把这条规则改掉」「查查丝印有没有压焊盘」「点菜单里的自动布局」「读一下位号位置」「把位号挪回去」「美学校验 / 字号 / 位号方向」时使用。写操作前必须说明对象、影响与回滚方式并取得确认；不读 cookie 与凭据、不替用户登录、不上传工程数据、不留常驻端口。只适用于桌面客户端，不覆盖网页版。"
version: 2.22.0
agent_created: true
---

# 立创EDA 专业版：CDP 连接、界面探查与设计操作

## 适用范围

对**本机正在运行的**嘉立创EDA专业版桌面客户端做三类事：

- **连接**：带调试端口启动、发现端点、校验归属、枚举 target 与 iframe。
- **探查**：界面区域树、菜单全表、工程树条目、多状态对比，产出可查可比的界面地图。
- **操作**：读设计数据（图元/网络/DRC/规则）、坐标标定与点击、增删改图元、写规则、重建铺铜、差分对布线。

只覆盖桌面客户端。网页版本身就是浏览器页面，用浏览器自动化工具直接开，不走这套流程。

本 skill 同时是其他 skill 的 CDP 连接层依赖：接口契约、稳定符号集与版本策略见 `@references/api-contract.md`。

## 能力索引

| 想做的事 | 入口 |
|---|---|
| 环境自检（解释器、连接层、客户端、端点、版本指纹） | `scripts/check_environment.py --json` |
| 端点发现 / target / frame / 求值 / 截图 | `scripts/lceda_cdp.py discover\|targets\|frames\|eval\|shot` |
| 界面地图（扫描 / 菜单 / 条目 / 对比 / 出图） | `scripts/uimap.py scan\|menus\|entries\|open\|close\|diff\|render` |
| **切文档（打开/激活/列文档）** | `scripts/open_doc.py --title <片段> list\|active\|open --name PCB1` |
| 板子体检（图元 / 网络 / DRC / 规则） | `scripts/board_check.py --title <窗口标题片段>` |
| 差分对定义 / 核对 / 删除 | `scripts/diffpair_define.py --title <片段> --list\|--pair\|--delete` |
| 差分对布线全链路 | `scripts/diffpair_route.py --title <窗口标题片段> ...` |
| 网络类：建类 / 分配 / 类规则 | `scripts/netclass_manage.py --title <片段> --list\|--create\|--rule` |
| 读/写导线-导线间距规则、连跑 DRC 采样 | `scripts/rule_edit.py --title <片段> --get\|--set-track-mm\|--drc-samples` |
| 泪滴：新增 / 移除（含 DRC 前后对照） | `scripts/teardrop_apply.py --title <片段> --op add\|remove --check-drc` |
| 美学校验（字高 / 旋转 / 对齐 / 过孔等距 / 丝印压铜·压线 / 孤立铜 / 出图） | `scripts/aesthetics_check.py --title <片段> [--sheet out.png]` |
| 任意 JS 求值 / API 方法表 | `scripts/eval_cdp.py`、`scripts/diag_ns.py` |
| 启停脚本与常驻入口 | `scripts/render_launcher.py`、`scripts/persist_cdp.py`（细节见 `@references/launcher.md`） |
| 知识库（坐标 / 选择 / API / PCB / 规则 / 菜单） | `@references/00-index.md` |

## 硬前提

1. 客户端为 4.1.x 系列（4.1.78 于 Windows x64 实测；Electron 41.2.1 / Chromium 146）。
2. 客户端是 Electron 壳，Chromium 命令行开关会透传到 Chromium 本体，宿主不拦截。
3. 调试端口**只能在启动那一刻开启**，已运行的实例无法事后追加。
4. Python 3.10 及以上，脚本只用标准库，不需要 pip 安装任何包。

任一不满足就停下，按「故障排查」处理。不要改安装文件、不要打补丁、不要注入进程。

## 第零步：环境检查

先跑只读检查，不要跳过：

```bash
python scripts/check_environment.py --json
```

按返回的 `status` 路由：

| status | 含义 | 下一步 |
|---|---|---|
| `ready` | 端点可用 | 跳到第二步 |
| `partial` | 客户端在，但没有调试端点 | 进第一步重启 |
| `needs_setup` | 缺解释器 / 连接层不完整 / 没装客户端 | 只展示缺失项步骤，见 `@references/setup-guide.md` |
| `unavailable` | 端口在听但不响应 CDP、端口记录过期，或版本对不上 | 进「故障排查」 |

检查只读：不装东西、不登录、不改配置、不启动进程。`checks[]` 里每一项都有 `reason_code`，字段含义见 `@references/api-contract.md`。

`checks[]` 里的 `version-fingerprint` 给出 Electron / Chromium / pro-api 三元组与一个 12 位指纹。
带 `--expect-fingerprint` 再跑一次就是漂移判定：不一致时该检查项为 `fingerprint_drift`，
整体退出码 3——**这说明客户端换版本了，凡走 React 内部路径的脚本（差分对、网络类、泪滴）
都要先复验再动手**，不要直接当成连接故障。

## 第一步：带调试端口重启客户端

### 先完全退出

全流程最容易翻车的一步。客户端有自研单实例协调：只要还有一个实例活着，新进程会把参数转交给老实例然后自己退出，**参数直接丢失**，端口不会开。

- 托盘图标退出不算退出，要在窗口里走完整退出。
- 退出后确认没有残留进程再继续。
- 有未保存的工程时，先让用户自己保存并关闭，不要替用户关。

### 别在助手会话里常驻客户端

从助手会话后台任务拉起的进程会随任务回收被清掉，用户事后会发现客户端莫名消失。需要长期开着的实例，交给第七步生成的启停脚本，由用户在自己的终端执行。

### 启动命令

Windows（已实测）：

```powershell
& "<安装目录>\lceda-pro.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
```

macOS / Linux（同源机制，未实测）：

```bash
"<安装目录>/lceda-pro" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
```

- `--remote-debugging-address` 必须写 `127.0.0.1`。永远不要用 `0.0.0.0`，也不要做端口转发或内网穿透。
- 端口被占用时换一个，或 `--remote-debugging-port=0` 让 Chromium 自选。
- 不要设 `--user-data-dir`，客户端会用 `app.setPath` 覆盖它，白设。

### 成功的判据

启动后 stderr 出现这一行才算成功：

```text
DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<uuid>
```

没有这一行就是没开成，回「故障排查」。

## 第二步：发现端点与看清结构

```bash
python scripts/lceda_cdp.py discover
```

发现顺序：`DevToolsActivePort` 文件 → 客户端进程的 loopback 监听端口 → 用户指定端口。

判定标准只有一条：`/json/version` 返回体同时含 `Browser` 与 `Protocol-Version`。端口能连不等于 CDP。

**必须看 uuid 归属。** `DevToolsActivePort` 可能是上次运行、甚至另一个 profile 留下的过期文件。文件第二行记着 `/devtools/browser/<uuid>`，与 `/json/version` 返回的 uuid 比对：`uuid=匹配` 才是当前实例。机器上存在多个 profile 时，几份文件可能写着同一端口，光看端口会认错主人，然后对着 A 实例操作 B 实例的界面。

browser 的 uuid 每次启动都会变，不要缓存 WebSocket 地址，每次重新发现。

```bash
python scripts/lceda_cdp.py targets    # 每个 target 的类型、标题、URL（账号字段已脱敏）
python scripts/lceda_cdp.py frames     # iframe 结构
```

| 阶段 | 会看到什么 |
|---|---|
| 首次启动未激活 | 只有 `Regist` 页（`entry=regist`），不是连错了 |
| 正常就绪 | `page` 标题含版本号，URL 形如 `https://client/editor` |
| 始终存在 | 1 个 `service_worker` + 若干 `worker` |

**编辑器不是独立 target。** PCB、原理图是主页面里的 iframe，切编辑器时 target 不变，变的是 iframe 的 URL。不要去找「PCB 的 target」，要连主页面再往下看 frame。判断结构用 `frames` 而不是 `document.querySelectorAll('iframe')`——后者可能返回空数组而 frame 树里其实有东西。

一个客户端可能同时开着多个工程窗口。用 `--match`（URL 或标题片段）或 `--page-match` 指定要看哪一个，不要假设只有一个 page。

## 第三步：只读读取

```bash
python scripts/lceda_cdp.py eval --expr "document.title"
```

默认只接受只读表达式。安全的写法是读 `document.title`、`location.href`、`navigator.userAgent`、`document.readyState`，或遍历 iframe 的 `src`。

脚本会做副作用检测，命中 `click(`、`dispatchEvent`、赋值、`fetch(`、`require(` 这类模式时拒绝执行，除非显式加 `--allow-side-effects`。

```bash
python scripts/lceda_cdp.py shot --out page.png
```

只截当前页面可视区。截图前提醒用户：画面里可能带账号信息、工程名、器件编号，外发前自己确认。

要读**扩展 API**（`pcb_*` / `sch_*`）用 `eval_cdp.py --api`，它会注入 `A = _EXTAPI_ROOT_` 并按
PCB 文档类型选页；要读**裸 UI DOM**（对话框、右键菜单、工具栏）用 `--context ui`，它不注入 `A`、
不按文档类型过滤，所以在首页/原理图/没开工程时也能读。

```bash
python scripts/eval_cdp.py --title <片段> --api "return await A.pcb_Layer.getCurrentLayer()"
python scripts/eval_cdp.py --title <片段> --context ui --expr "document.querySelectorAll('[class*=lc_modal]').length"
```

**两个 context 读的是同一份 document**（2026-11-11 复验，条件写在契约 §3.4：独占窗口 +
无人并发驱动 + 窗口可见）：三项计数与 `href` 完全相同，差异只有「注入 A / 包 IIFE / 按
docType 过滤」。`hasA` 不能用来区分 context。早先「api 读 iframe」的说法**从未有可靠证据**，
不要回收；反过来，任何没写条件的「同一份 document」也不要当成结论——上一轮就是缺了
「独占」这个条件才被作废重测。

### 切文档：走 API，不要点页签或双击工程树

以前切文档靠坐标双击工程树节点（`Input.dispatchMouseEvent` 点 `(60,198)`）或点页签。
这条路有三个硬伤：缩放/分辨率一变就点偏、页签重名时点错、点完只能靠 `docType` 猜成败。
分辨率不是你能控制的——**别赌**。

编辑器 API 有完整的文档生命周期方法（2026-11-11 用客户端自带的
`lceda-pro doc api --class-name DMT_EditorControl` 核实，版本 4.1.78）：

```bash
python scripts/open_doc.py --title <片段> list                 # 列 PCB / 原理图页（含 uuid）
python scripts/open_doc.py --title <片段> active               # 当前活动文档 + 判定来源
python scripts/open_doc.py --title <片段> open --name PCB1     # 打开 + 激活 + 等就绪 + 回读自证
```

| 方法 | 语义（文档原文口径） |
|---|---|
| `dmt_EditorControl.openDocument(uuid, splitScreenId?)` | 打开文档，返回**标签页 ID**；返回 `undefined` 即打开失败 |
| `dmt_EditorControl.activateDocument(tabId)` | 切到该标签页并把输入焦点放进画布（**真正切换**） |
| `dmt_EditorControl.waitForDocumentReady(tabId, timeoutMs?)` | 阻塞到文档可操作，超时返回 `false`（`visibility: alpha`） |
| `dmt_EditorControl.closeDocument(tabId)` | 关标签页——**未保存数据直接丢**，先存再关 |
| `dmt_Pcb.getCurrentPcbInfo()` | 当前**焦点** PCB；原理图焦点下返回 `undefined` |
| `dmt_Schematic.getCurrentSchematicPageInfo()` | 同上，原理图侧 |

**`openDocument` 只建标签页，不换焦点。** 少了 `activateDocument`，`getCurrentPcbInfo()`
读到的还是旧文档，于是「我明明打开了 PCB」和「API 说当前不是 PCB」两个结论会同时成立——
这种自相矛盾比操作失败更难查。`open_doc.py open` 已经把两个调用绑在一起，并在切完后
回读 `active_after`：**uuid 不等于目标就 exit 2**，不会 exit 0 蒙过去。

⚠️ 真机验证状态（2026-11-11，agent-drill-rc50）：切 P1 → `active_after.kind=sch`、
`docType` 3→**1**；切回 PCB1 → `kind=pcb`、`docType` **3**。双向都成立。
`waitForDocumentReady` 在本版**恒返回 false**（alpha 接口），所以它**不是**成败判据 ——
主判据是 `active_after`，输出里会带 `note` 说明，别把 `ready:false` 当失败。

## 第四步：界面地图

在**当前界面状态**下先扫一份基线，同一次探查的所有命令共用同一个 `--out`：

```bash
python scripts/uimap.py scan --out ./ui-map/run1 --label baseline
```

产物：`states/00-baseline.json`、`shots/00-baseline.png`，以及自动生成的 `ui-map.md` / `ui-map.html` / `coverage.md`。

扫描做四件事：跨 frame 递归、按几何与角色分类、折叠包装层与重复兄弟、过滤被遮挡区域。参数：`--depth`（默认 6）、`--min-area`（0.004 视口面积比）、`--repeat`（6）、`--no-occlusion`、`--no-shot`。

菜单全表（**点标题、悬停条目，绝不点击条目**）：

```bash
python scripts/uimap.py menus --out ./ui-map/run1
```

| 动作 | 会不会执行命令 | 处理 |
|---|---|---|
| 点顶栏菜单标题 | 不会，只切换下拉层 | 允许自动执行 |
| 悬停菜单条目 | 不会，只让子菜单浮出 | 允许自动执行 |
| 点击菜单条目 | 会（保存、导出、新建工程、下单…） | 一律不点 |

每个菜单展开后按 `Esc` 收起并复核关闭；关不掉就再点一次标题切回去。

工程树条目（界面布局随设计种类变化，必须单独走一遍）：

```bash
python scripts/uimap.py entries --out ./ui-map/run1                    # 只读枚举序号/名称/坐标
python scripts/uimap.py open --out ./ui-map/run1 --entry 3 --confirm   # 会改界面状态，需确认
python scripts/uimap.py close --out ./ui-map/run1 --confirm            # 只关本轮自己开的
```

按**种类去重**挑代表：原理图、PCB、符号、封装、图页各一，不要把每个设计文件都开一遍。`frames_changed: false` 说明双击只是展开了节点或没反应，如实报告，不要当成成功。找不到可点的关闭控件时**不猜、不右键点菜单**，列清单让用户自己关。

状态对比：

```bash
python scripts/uimap.py diff ui-map/run1/states/00-baseline.json ui-map/run1/states/03-pcb.json --out ui-map/run1
```

输出新增、消失、仅位移、尺寸变化四类。配合「手动切状态 + 重扫」，能在不动界面的前提下逐步覆盖各编辑器。

## 第五步：读设计数据

```bash
python scripts/board_check.py --title <窗口标题片段>              # 图元数量 + 网络长度 + DRC + 规则
python scripts/board_check.py --title <窗口标题片段> --json       # 机器可读
python scripts/board_check.py --title <窗口标题片段> --drc-detail # 每条 DRC 含坐标
```

每次改动后跑一次作回归基线：输出稳定可比，便于人工比对或交给脚本 diff。

摸未知接口时：

```bash
python scripts/eval_cdp.py --title <窗口标题片段> --expr "1+1"
python scripts/eval_cdp.py --title <窗口标题片段> --api "return JSON.stringify(await A.pcb_Net.getAllNets())"
python scripts/diag_ns.py --title <窗口标题片段> --ns pcb_Document,pcb_Net
```

`--api` 模式自动注入 `var A = globalThis._EXTAPI_ROOT_` 并 await 整个函数体。这两个脚本输出**原文不做脱敏**，别把原始 dump 直接贴进公开报告。

差分对布线全链路（自带前置检查、标定、断言、端点校验）：

```bash
python scripts/diffpair_route.py --title <窗口标题片段> --start-pad D_P --start-xy 4917,-6825 --end-xy 4598,-7010
python scripts/diffpair_route.py --title <窗口标题片段> --dry-run   # 只体检不落线
```

退出码：0 成功 / 2 前置检查失败 / 3 标定失败 / 4 探针失败 / 5 布线无产出。

**画布没有 DOM 结构**，但设计数据不是读不到：走 `pcb_*` / `sch_*` 内部 API（`_EXTAPI_ROOT_`）。用 `document.querySelectorAll` 找器件和走线才是白费功夫。

## 第六步：写操作闸口

读操作（`scan`、`entries`、`menus`、`diff`、`render`、`board_check`、`eval_cdp`、`diag_ns`、`discover`、`targets`、`frames`、`shot`）可以直接做。以下动作执行前必须逐条说明**对象、影响、回滚方式**并取得同意：

- `open` / `close`：打开或关闭哪个条目、会多出什么标签页、关不掉时怎么办
- 增删改图元：改哪些图元、坐标与层、会不会牵扯同网络对象
- 写设计规则：改哪个配置的哪一项、影响面是全局还是按网络
- 布线：起点终点、网络、线宽层、预计新增段数
- 重建铺铜：重建哪一块、会不会改动已有铜皮
- `importChanges`：先读差异清单再决定，不直接点「应用修改」
- `diffpair_define.py --pair/--delete`：建/删的是板上的差分对定义，影响后续差分对布线与等长
- `netclass_manage.py --create/--add/--remove/--rename/--delete/--rule`：网络类改动会**搬走**网络、
  类规则会改全局间距与线宽，属于高风险写操作
- `teardrop_apply.py --op add/remove`：会给整板或选中对象加减铜，必须写明范围（全部/仅选中）、形状与百分比参数

只读可以直接做：`--list` / `--verify-ui` / `--only` / `board_check` / `aesthetics_check`（不加 `--sheet`）。
`aesthetics_check.py --sheet` 会临时隐藏铜层再截图还原，属于视图改动，不必逐次确认但要说明。

**写脚本自带兜底守卫**（2.18.0 起，2.21.0 补到 12 个）：12 个写脚本在第一个写动作前调 `_board.ensure_writable`，
命中历史预览态或可见对话框直接 **exit 2**、消息以 `[unwritable]` 开头。它是**兜底，不是替代**：
调用方仍应显式先跑 `scripts/state_check.py`（`--strict` 时不可写返回 4）再动手，别把「脚本没报错」
当成「状态一定干净」。

**弹窗能判也能点了**（2.21.0 起）：`state_check` 的 `modals[]` 带 `selector`（拼不出唯一路径时是
`null`，不是假选择器）、`stack_index`（**1 = 最上层**）、`rect`，每个按钮带 `text / kind /
clickable`。要关弹窗用 `_board.dismiss_modal(board, "取消")`：它按文字找按钮、默认**拒绝**
primary（确定/应用/保存），找不到文字就一个字都不点；判据是「那个框消失了」，不是「点到了」。
真机复验（2026-11-11 10:45，独占窗口）：`设计规则` 对话框 8 个文本按钮——`默认/删除`
`clickable=false`、`取消` 是 `cancel`、`应用/确认` 是 `primary`；弹窗与 8 个按钮的
`selector` 逐个 `querySelectorAll` 命中数都是 1。`dialogs.py --cancel` 点一次即关，残留 0。

`blocked` 消息会把按钮分成「安全关闭」与「提交类（勿点）」两栏——**照着一栏点，别把两栏混着看**。
禁用态不一定有 `disabled` 属性：判据里已含 class 与 `cursor:not-allowed`（真机复验同批），
但**别自己另写一套判定**（两份判定必然漂移，一处说能点一处说不能）。

**同一条渠道同一时刻只能有一个驱动者。** 两个进程同时点菜单/关弹窗会互相打断，观测到的 `modals`
会在 0/1 之间跳，看起来像「检测器坏了」，其实是两个手在抢鼠标。排查时先确认没有别的脚本在驱动。

改动设计规则走 `scripts/rule_edit.py`（`--set-track-mm`，契约 6.21，**尚未上板验证**）；
对话框开着时 `pcb_Drc.check()` 会报「画布内没有相关订阅」，跑 DRC 前必须先关弹窗。

一次确认只对一次动作有效。用户没说「可以」就不执行。

**绝对不做**：点击会创建或破坏数据的菜单条目（新建、删除、移除、清空、重置、上传、下单、关闭工程）、往输入框打字、保存或覆盖工程、读 cookie 与凭据、替用户登录、把工程数据上传到外部服务。

写操作的技术坑（CDP 键盘失效、事件监听需要扩展身份、坐标与命中不稳定、重建铺铜的可用路径）集中在 `@references/02-input-and-canvas.md` 与 `00-index.md` 的「全局纪律」，动手前先读。

## 第七步：启停脚本与常驻入口

手动敲一长串参数启动每次都要重来，放在助手会话里跑又会被回收。收尾时给用户生成启停脚本，让他自己管实例生命周期：

```bash
python scripts/render_launcher.py --out-dir <目录> --dry-run   # 先确认写入位置
python scripts/render_launcher.py --out-dir <目录>             # 正式生成
```

产物 Windows 为 `lceda-cdp.ps1` + `lceda-cdp.cmd`，macOS / Linux 为 `lceda-cdp.sh`，统一五个动作 `start` / `ensure` / `status` / `endpoint` / `stop`。

- `start` 默认**清掉代理环境变量**再拉起客户端（环境变量会盖掉系统代理，是白屏的头号嫌疑人）；要沿用加 `-KeepProxyEnv`。
- `ensure` 是端点丢失后的自愈入口：没进程就起，有进程就等 30 秒再按「带不带调试端口」给处置。它不杀进程。

**让用户自己跑，不要代跑。** 脚本里嵌了本机安装路径，属本地信息，别提交到公开仓库；换机器或换端口就重新生成，不要手改。

要不要让日常双击也带 CDP、`persist_cdp.py` 的安装/卸载与安全边界，见 `@references/launcher.md`。

**客户端会自己重启**（改运行模式、清缓存、导激活文件、升级）。重启后端点、page target id、`windowId`、撤销栈全都换新；哪些入口会重启、启动参数能不能活下来，见 `@references/restart-and-relaunch.md`。

## 已知边界

1. **画布没有结构**。原理图与 PCB 用 canvas 渲染，器件、网络、走线不在 DOM 里；界面地图只能标到「这块是画布」。设计数据要走 `pcb_*` / `sch_*` API，不要试图从 DOM 读。
2. **编辑器可能是 iframe**。切编辑器时 page target 不变，只有 frame 的 URL 变。脚本按 frame 逐个求值。
3. **遮挡过滤是启发式**。被浮层压住的区域会被丢弃并计数；全窗口遮罩（加载中）不触发丢弃，否则会得到一张空图。
4. **标签页关闭没有可靠控件**。4.1.78 实测：标签页元素里找不到可点的关闭按钮，悬停也不出现。脚本报告清单，由用户手关。
5. **快捷键列取自界面文字**，菜单里没显示快捷键的条目就是空的，不要据此推断快捷键不存在。
6. **地图是某一时刻的窗口状态**，不是应用穷举。同一客户端在不同工程、不同编辑器下结构不同，必须分状态扫。
7. **CDP 注入的键盘对部分组合键无效**。Esc、Shift+B、视图缩放按不动（事件能到 iframe DOM，但应用不响应）；单键类快捷键（如 Q 切单位）正常。退工具用右键，重建铺铜用属性面板按钮。
8. **事件监听需要真正的扩展身份**。`pcb_Event.addMouseEventListener` 在主页面调用不报错、`isEventListenerAlreadyExist` 返回 true，但回调永不触发。观测命中用 `pcb_Document.getPrimitiveAtPoint`。
9. **坐标与命中不稳定到可以「点中心」**。光标移出画布后 `getCurrentMousePosition` 会静默冻结；焊盘中心常被自家走线端点占据，部分焊盘坐标落在图形缝隙上。点之前先用命中查询确认。
10. **`eval_cdp.py` / `diag_ns.py` 输出不脱敏**，它们是调试管道，不是报告管道。
11. **扩展 API 的方法在原型链上**，`Object.keys(A.pcb_Drc)` 永远返回 `[]`。探测能力面必须沿 `getPrototypeOf` 遍历，否则会得出「没有 API」的错结论（4.1.78：97 命名空间 / 769 方法）。
12. **泪滴没有 API**，入口只在选中对象的右键菜单（`添加 → 添加泪滴...`），顶栏三个菜单里都没有。
13. **扇出只支持 BGA 封装**。非 BGA 器件点「应用」不报错也不产出。
14. **`dmt_EditorControl.getCurrentRenderedAreaImage` 在 4.1.78 上返回 `undefined`**，出图改用 CDP 的 `Page.captureScreenshot`。
15. **`netRules` 是独立存储，`check()` 不消费它**：类规则 / net 级规则写成 5mm，在铺满走线的板上 DRC 也一条不报（实测 GND、VCC）。别把「规则写进去了」当成「DRC 已经按它检查」。走另一条路（默认规则配置 → `overwriteCurrentRuleConfiguration`）未测，动它等于改工程规则。
16. **一块网络只能属于一个网络类 / 一个差分对**。重复加入不会报错，是静默搬走或留下空网络。
17. **自动布局在「布局」菜单，不在设计/布线**：`自动元件布局` / `草图自动元件布局` / `自动位号布局...`。
    API 侧 `pcb_Document.autoLayout()` 有 RPC，但 `startAutoLayout()` / `getAutoJobStatus()` 是空壳。
    只在设计/布线里找会误判成「产品没有这个功能」。

## 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| 带参数启动但端口没开 | 还有实例在跑，参数被转交丢弃 | 彻底退出后重启 |
| 改完设置客户端自己退出又起来，端点没了 | 设置变更触发了自重启；「清理缓存」那条通道只保留第一个参数 | 跑 `ensure`；端口参数必须排第一，见 `@references/restart-and-relaunch.md` |
| 窗口半分钟不出来，出来还是白屏、提示网络异常 | 继承来的 `HTTP_PROXY` 等变量盖掉了系统代理，客户端在连一个不存在的代理 | 用启动脚本 `start`（默认清代理变量），或加 `-ProxyServer` 显式指定 |
| 端点没了但客户端进程明明在 | 可能是不带 `--remote-debugging-port` 起来的实例（图标启动 / 升级后自重启） | `status` 会读命令行确认；只能保存后彻底退出再 `start` |
| `discover` 列出多条端口文件、端口号还一样 | 机器上存在多个 profile，旧文件残留 | 看 `uuid=匹配` 那条才是当前实例 |
| 设了 `devTools` 却连不上 CDP | `devTools` 只开本地 DevTools 窗口，不是调试端口 | 想要端口还是得启动带 `--remote-debugging-port` |
| 连上了但界面像「全新安装」 | 端点是另一个 profile 的实例 | 用 `discover` 核对 profile 与 uuid，清掉多余 profile |
| 登录态或设置对不上 | 同上，连错了 profile | 同上；数据按 profile 分开存，不是 CDP 造成的 |
| 端口能连，`/json/version` 报错 | 端口被别的程序占用 | 换端口，或 `--remote-debugging-port=0` |
| `DevToolsActivePort` 有内容但连不上 | 上次运行的残留文件 | 重新发现，别信旧文件 |
| 第二个实例起不来，stderr 报 `bind()` 错误 | 同端口冲突 | 用第一实例的端点，或换端口重启 |
| `/json/list` 为空 | 页面还没建出来 | 等 4—6 秒再查，依次等 `/json/version` 与 page target |
| 只看到 `Regist` 页 | 客户端未激活 | 不是故障，让用户先完成激活 |
| 端口开了但客户端起不来 | 客户端本体或显卡驱动问题 | 不带参数启动确认客户端本身正常 |
| `connect-module` 检查失败 | skill 目录不完整或版本不匹配 | 重新安装本 skill，按 `api-contract.md` 核对接口 |
| 扫描结果只有 1—2 个节点 | 页面还在加载，或整窗遮罩 | 等界面稳定后重扫；必要时加 `--no-occlusion` 对比 |
| 区域树里全是 `[box]`，没有 `[topbar]`/`[sidebar]` | 窗口尺寸异常或缩放不是 100% | 恢复窗口大小后重扫 |
| 菜单展开后条目为空 | 该标题不是菜单（账号、状态区） | 正常现象，换下一个触发点 |
| `open` 后 `frames_changed: false` | 双击落在分组节点上，或该条目不是设计文件 | 先展开分组，再对叶子条目双击 |
| 对比结果全是新增/消失 | 两次状态差异太大，或区域名变了 | 先比同种类状态；命名差异要在报告里说明 |
| 中文在终端里乱码 | 终端编码不是 UTF-8 | 加 `--json` 取机器可读结果，或重定向到文件再看 |
| 版本升级后失效 | 宿主可能新增了开关过滤 | 先确认 `/json/version` 的 Electron/Chromium 版本、命令行里的开关、stderr 有无 `DevTools listening` |

## 安全红线

1. 只绑 `127.0.0.1`，不开公网、不做端口转发。
2. 不读 cookie、localStorage 里的凭据、激活文件、账号信息。target 的标题与 URL 输出前一律过 `redact`（URL 账号参数 + 邮箱 + 手机号）。
3. 渲染进程实际以 `--no-sandbox` 运行，部分窗口开了 Node 集成。能执行 JS 就等于能在本机跑代码，按这个标准约束自己。
4. 不修改、不删除、不上传用户工程；写设计数据必须先取得逐次确认。
5. 用完提示用户关掉调试端口：正常启动一次即可恢复默认。

## 停止条件

出现以下任一情况，停止并如实说明，不要绕：

- 客户端版本不是 4.1.x，且带参数启动确实打不开端口
- 用户拒绝退出客户端
- 需要登录或授权才能继续
- 需要改动安装文件、注入进程或打补丁才能拿到端口
- 用户拒绝为 `open` / `close` / 任何设计数据写入授权

## 脚本速查

上面各节的命令即全部入口；所有脚本都接受 `--port`（默认自动发现）、`--json`（机器可读）、
`--match` / `--page-match`（按标题或 URL 选窗口）、`--out`（输出目录）。退出码与 JSON
字段的完整契约见 `@references/api-contract.md`。

## 质量自查

- [ ] 跑过环境检查，状态与后续动作对得上
- [ ] 确认过客户端是彻底退出后重启的
- [ ] 端点是 `/json/version` 验证过的，且 uuid 归属核对过
- [ ] 报告里没有出现账号、邮箱、手机号、客户编号、license
- [ ] 没有点击任何菜单条目，没有往输入框打字
- [ ] `open` / `close` / 设计数据写入都有对应的用户确认记录
- [ ] 未覆盖的状态在报告里标成未验证，没有写成结论
- [ ] 画布区域明确标注为「画布内容不可读，设计数据走 API」
- [ ] 每次扫描都记录了版本指纹，便于日后判断结构漂移
- [ ] 需要长期运行实例时，交付了启停脚本而不是留在会话里
- [ ] 动过会触发自重启的设置（运行模式 / 清缓存 / 激活 / 升级）后，重新发现过端点，没有复用旧的 page id

---

## 附：操作测绘卷

`references/01`–`08` 是对客户端内部 API 与界面操作的**系统实验记录（含写操作）**，与上文只读扫描流程相互独立：做界面地图时不必读，做自动化、故障排查或评估「某个动作能不能自动完成」时按需查阅。「按任务找文件」的对照表在 `@references/00-index.md`，先读那一页。

版本指纹：客户端 `V4.1.78`，扩展 API `pro-api/0.3.53.61b2011d`。
换算要点：原理图坐标单位 10 mil，PCB 单位 1 mil（5 cm = 1968.5 mil），设计规则单位 mm。
