# 接口契约（供其他 skill 依赖）

本文件是本 skill 作为**连接层供给方**对外的承诺。依赖方只依赖这里列出的内容；
未列出的模块、函数、参数一律视为内部实现，随时可能变化。

当前契约版本：**2.x**（对应 `SKILL.md` 的 `version`）。

---

## 一、接入方式

依赖方在 `scripts/` 下的脚本里按下面片段定位本 skill，**不要**再硬编码
`~/.workbuddy/skills/easyeda-cdp-connect`（那是 1.x 时代的旧路径，已失效）：

```python
import os
import sys
from pathlib import Path

cand = os.environ.get("EASYEDA_CONNECT_SCRIPTS")
base = (Path(cand).expanduser() if cand
        else Path.home() / ".workbuddy" / "skills" / "leonskill-easyeda-cdp-connect" / "scripts")
if not (base / "lceda_cdp.py").is_file():
    raise SystemExit("leonskill-easyeda-cdp-connect 未安装，或 EASYEDA_CONNECT_SCRIPTS 指向错误")
sys.path.insert(0, str(base))

import lceda_cdp
```

- `EASYEDA_CONNECT_SCRIPTS` 是**唯一**的路径覆盖入口，值为本 skill 的 `scripts/` 目录。
- 本 skill 内部的 `_bootstrap.py` / `_board.py` 只服务自身，**不属于契约**，依赖方不要 import。
- 安装位置默认是 `~/.workbuddy/skills/leonskill-easyeda-cdp-connect/`。仓库根即技能根，`git clone` 进 `~/.workbuddy/skills/` 后目录名就是技能名；在别处开发时用 junction / 软链把仓库根挂到这个路径。
- `scripts/` 直接位于该目录下，所以 `EASYEDA_CONNECT_SCRIPTS` 的默认值就是 `<技能目录>/scripts`。

## 二、稳定符号集（`lceda_cdp` 模块）

| 符号 | 签名 | 返回 | 说明 |
|---|---|---|---|
| `DEFAULT_HOST` | `str` | `"127.0.0.1"` | 只允许回环地址 |
| `DEFAULT_PORT` | `int` | `9222` | 兜底端口，不作为发现依据 |
| `resolve` | `(host, port=None) -> dict \| None` | 端点条目或 `None` | 发现并验证端点；`port` 只作为一个候选追加，不会跳过自动发现 |
| `discover` | `(host, port=None, scan=None) -> (list, list)` | `(usable, results)` | `usable` 是可用于连接的条目；`results` 含全部候选及失败原因 |
| `list_targets` | `(host, port) -> list` | `/json/list` 原样列表 | 不做过滤，空列表表示没有 target |
| `pick_page` | `(targets, index=None, match=None) -> dict \| None` | 选中的 page target | `match` 同时匹配 **URL 与窗口标题**；未指定时优先非注册页 |
| `Session` | `Session(ws_url)` | 会话对象 | 见下方方法表；支持 `with` |
| `redact` | `(text) -> str` | 脱敏后的字符串 | URL 账号参数 + 邮箱 + 手机号 |
| `has_side_effects` | `(expr) -> bool` | 是否疑似有副作用 | 启发式，不保证完备 |

端点条目（`resolve` / `discover` 的 `usable` 元素）字段：

```json
{
  "port": 9222,
  "source": "DevToolsActivePort | cli | scan",
  "profile": "/path/to/cache.x64.3/DevToolsActivePort",
  "cdp": true,
  "uuid_match": true,
  "version": { "Browser": "Chrome/146.0.7680.188", "Protocol-Version": "1.3", "webSocketDebuggerUrl": "ws://..." }
}
```

`uuid_match` 语义：`true` = 端口文件记录与在线实例一致；`false` = 过期文件；
`null` = 该候选没有端口文件可比对（`cli` / `scan` 来源）。

`Session` 方法：

| 方法 | 说明 |
|---|---|
| `call(method, params=None) -> dict` | 发一条 CDP 命令，返回 `result`；协议错误抛 `RuntimeError` |
| `close()` | 关闭 WebSocket；可重复调用 |
| `__enter__ / __exit__` | 退出时自动 `close()` |

## 三、CLI 契约

### 3.1 `lceda_cdp.py`

| 子命令 | JSON 输出 | 退出码 |
|---|---|---|
| `discover --json` | `{"found": bool, "results": [...]}` | 0 有可用端点 / 2 无 |
| `targets --json` | `{"port": int, "targets": [...]}` | 0 / 2 无端点 |
| `frames` | **无 JSON**，纯文本 frame 树 | 0 / 2 无端点或无匹配 page |
| `eval --json` | `Runtime.evaluate` 原始结果对象 | 0 / 2 无端点 / 3 拒绝副作用 / 4 协议错误 |
| `shot` | **无 JSON**，纯文本 | 0 / 2 无端点 / 4 截图失败 |

公共参数：`--host`（仅回环）、`--port`（缺省自动发现）、`--json`。

### 3.2 `check_environment.py`（**安装自检接口**）

依赖方可以直接调用它判断「本机能不能用」，不需要自己实现探测：

```bash
python ~/.workbuddy/skills/leonskill-easyeda-cdp-connect/scripts/check_environment.py --json
```

输出：

```json
{
  "status": "ready | partial | needs_setup | unavailable",
  "checks": [
    {"id": "python-version", "status": "ready | missing | unavailable", "reason_code": "ok", "detail": "...", "hint": "..."}
  ],
  "dependencies": [{"id": "python-runtime", "status": "ready", "checks": ["python-version"]}],
  "functional_degradations": [],
  "next_action": "中文下一步说明"
}
```

`dependencies[].id` 取值：`python-runtime`、`lceda-pro-client`、`cdp-endpoint`、`client-version`。

`checks[].id` 固定为以下六个，顺序固定：

| id | 含义 | 失败时 `reason_code` |
|---|---|---|
| `python-version` | 解释器 ≥ 3.10 | `version_incompatible` |
| `connect-module` | `scripts/lceda_cdp.py` 存在且 9 个稳定符号齐全 | `file_missing` / `interface_mismatch` |
| `client-profile` | 客户端 profile 目录存在 | `file_missing` |
| `client-executable` | 能定位主程序（可选，不影响连接） | `file_missing` / `probe_failed` |
| `endpoint-probe` | 有可用 CDP 端点 | `service_unavailable` / `stale_record` / `probe_failed` |
| `version-fingerprint` | 能取到 Electron / Chromium / pro-api 三元组 | `service_unavailable` / `probe_failed` / `fingerprint_drift` |

退出码：`0 ready` / `1 partial` / `2 needs_setup` / `3 unavailable`。

依赖方的判断建议：**退出码 0 或 1 视为可用**（`partial` 表示客户端在、只差重启带端口）。

### 3.2.1 `version-fingerprint`（漂移判定）

客户端升级会让 React 内部路径、DOM 类名、`_EXTAPI_ROOT_` 方法面一起漂移，
依赖这些路径的脚本（差分对、网络类、泪滴）必须能在动手前发现「版本换了」。

`version-fingerprint` 这一项额外带两个字段（加法字段，老依赖方可忽略）：

```json
{
  "id": "version-fingerprint",
  "status": "ready",
  "reason_code": "ok",
  "detail": "Electron 41.2.1 / Chromium 146.0.7680.188 / Pro 4.1.78 (34f5b8d9)，指纹 d4c95175a381",
  "fingerprint": "d4c95175a381",
  "components": {
    "electron": "41.2.1",
    "electron_pack": "jlc-sa-win-x64.6",
    "chromium": "146.0.7680.188",
    "pro_api": "4.1.78",
    "pro_build": "34f5b8d9",
    "v8": "14.6.202.33"
  }
}
```

- `fingerprint` 是 `electron|chromium|pro_api|pro_build` 四段的 sha256 前 12 位，
  用来做「和上次一样吗」的粗判；要看**哪儿**变了就读 `components`。
- 各段来源：`electron` / `chromium` / `pro_build` 来自端点 `/json/version` 的
  `User-Agent` 与 `Browser`；`pro_api` 优先读编辑器页面的 `window.PRO_EDITOR_VERSION`，
  页面读不到时退化为 UA 里的 `JLCEDAPro/<版本>`。
- 这一项只在端点可用时才有意义。**端点不可用时它是 `missing`，不参与整体判定**，
  不会把「没开客户端」误报成「版本漂移」。
- 想主动做漂移判定时传 `--expect-fingerprint`，取值可以是 `fingerprint` 原文、
  pro-api 版本（`4.1.78`）、Chromium/Electron 版本，或 `electron=41.2.1` 这种
  `字段=值` 形式。不一致时该项转 `unavailable` + `fingerprint_drift`，
  **整体 `status` 为 `unavailable`、退出码 3**（连接是通的，但依赖 React 内部路径的
  脚本不保证还能跑——这正是依赖方该停下来复验的信号）。

### 3.3 其他脚本（只承诺 CLI，不承诺模块导入）

| 脚本 | 退出码 |
|---|---|
| `uimap.py` | 0 成功 / 2 环境或端点问题 / 3 拒绝 / 4 协议错误 |
| `board_check.py` | 0 成功 / 1 找不到端点或窗口（消息在 stderr） |
| `diffpair_route.py` | 0 成功 / 2 前置检查失败 / 3 标定失败 / 4 探针失败 / 5 布线无产出 |
| `diffpair_define.py` | 0 成功 / 2 前置检查失败 / 4 断言失败（回读不符）/ 5 无产出（应用不接受） |
| `netclass_manage.py` | 0 成功 / 2 前置检查失败 / 4 断言失败（回读不符）/ 5 无产出（类不存在） |
| `teardrop_apply.py` | 0 成功 / 2 前置检查失败（菜单打不开）/ 4 断言失败（面板未生效或 DRC 不符预期）/ 5 无产出（对话框没出现） |
| `ctxmenu.py` | 0 成功 / 2 前置失败（端点、选页不唯一、文档类型不对、菜单打不开、锁被占用）/ 4 断言失败（点完状态不符、关闭失败）/ 5 无产出（菜单里没有这个路径） |
| `rule_edit.py` | 0 成功 / **2 前置失败、不可写状态、或 CDP 传输异常** / 4 断言失败（回读不符） |
| `aesthetics_check.py` | 0 无 fail（warn 允许）/ 2 前置检查失败 / 4 有断言失败 |
| `eval_cdp.py` | 0 成功 / 1 JS 异常 / 2 没有匹配窗口、参数互斥、顶层 UI 判据未满足（见 3.4） |
| `open_doc.py` | 0 成功 / 1 没找到文档或同名多义（消息在 stderr）/ 2 前置失败（`openDocument` 返回 `undefined`、或切完焦点不在目标上，见 3.5）/ 3 用法错误（`--name` 与 `--uuid` 同时给或都不给） |
| `diag_ns.py` | 0 成功；失败以 `SystemExit` 消息退出 |

**`board_check.py --json` 的 DRC 两套口径（2.18.0 起）**：`drc` 键按**子类 `sub`** 聚合
（历史契约，不变；所以 `Differential Pair Error` 类会打成 `Track to Track`），新增
**`drc_cat`** 按**类别 `cat`** 聚合。**两者不可互推**（一个 cat 下可有多个 sub）——
要判断"这条 DRC 属于哪一类"，必须看 `drc_cat`；只读 `drc` 会把子类名当成类别名（实测因此
误判过一次计划文档）。`--drc-detail` 给逐条明细，同时含 `cat` 与 `sub` 两个字段。

四个新脚本都支持 `--json`，输出统一含 `ok`、`title`、`_lines`（人读摘要）。
`aesthetics_check.py` 的 `--json` 额外给出 `checks[]`，每项带 `id` / `class`（A/B/C）/
`section`（guideline 章节）/ `status`（pass|warn|fail|skip）/ `failures` / `warnings`。

`teardrop_apply.py` 走的是**上下文菜单 + 对话框**（泪滴没有 API），同样会改板面铜形，按写操作对待。

`netclass_manage.py --check-drc` 会在改动前后各跑一次 DRC 并给出条数变化（`drc_before` /
`drc_after` / `drc_delta`）。**它是观测，不是判定**：`drc_delta` 为空既可能是板面无违规几何，
也可能是规则未进判定路径，脚本不会据此报错，调用方不要把它当通过信号。
（实测结论：`netRules` 覆盖层**不会**影响 `pcb_Drc.check()`，见 `notes/49` §5。）

`diffpair_define.py` / `netclass_manage.py` 写的是**板子状态**（差分对、网络类、类规则），
调它们等于替用户改设计数据：编排层在调用前必须已经取得用户同意，
并且只用 `--list` / `--verify-ui` 这类只读动作做巡检。

**不可写状态守卫（2.18.0）**

12 个写脚本在动手之前调用 `_board.ensure_writable()`：`teardrop_apply` / `netclass_manage` /
`diffpair_define` / `diffpair_route` / `pour_rebuild` / `import_ses` / `import_autolayout` /
`rip_nets` / `undo` / `designator_attr`（仅 `--patch`）/ `rule_edit`（仅 `--set-track-mm`）/
`ctxmenu`（仅 `click --allow-write`，且首个分段不在只读白名单）。
命中**历史预览态**或**可见模态框**时统一 **退出码 2**，错误消息体以 `[unwritable]` 开头
（stderr 行形如 `错误：[unwritable] …` / `失败：[unwritable] …`，随后是原因与
「关闭历史预览横幅/对话框后重试」；模态那条还带「标题 + 可点按钮文字」，见 6.9）。

- **只读子命令不触发**：`--list`（含 `netclass_manage --list --check-drc`）、`--get`、
  `--dry-run`、`diffpair_define --verify-ui`、`designator_attr` 不给 `--patch` 的读取路径、
  `ctxmenu click` 不带 `--allow-write`（或首个分段在只读白名单里，即使带了 `--allow-write`）。
  注意 `netclass_manage --rule` 是**写**类规则，会触发守卫；`rule_edit --drc-samples` 只读，不触发。
- **退出码不对称是有意的**：写脚本用 **2**（各脚本的 2 = 前置失败）；`state_check.py --strict`
  用 **4**（它是检查器，4 = 检出会阻断写操作的状态，便于 `if state_check --strict; then …`）。
  同一种状态两种码——「写脚本失败」与「检查器检出异常」在编排层含义不同。
- **`rule_edit.py` 的 2 = 前置失败 + 不可写状态 + CDP 传输异常**（三个来源共用一个码）。
  入口 `_cli()` 的 `except (RuntimeError, OSError, ValueError)` 把 `Input.insertText` 被拒、连接中途断、
  传输层 `OSError`、`--backup` 坏的 JSON 全部收成 `错误：CDP 调用失败：…` → exit 2。**依赖方别把
  2 一律读成「参数/环境检查没过」**——否则传输中断时会原地重试同一条命令，永远看不到真正原因；
  按 stderr 是否带 `CDP 调用失败：` 区分「重连/换文件」与「原样重试」。2.18.2 起其余写脚本的 2
  同样包含 CDP 传输异常（见下），但 `rule_edit.py` 的 `_cli()` 仍是独立实现（额外接 `ValueError`）。
- **已修（2.18.2）**：**全部 11 个写脚本的传输层异常均收成 exit 2**，不再冒成
  **exit 1 + traceback**。实现路径有三种（清单见下）。
- **路径一 `_board.run`**：在 `except BoardError` / `except SystemExit` 之后新增
  `except (RuntimeError, OSError)`，把裸 `RuntimeError` / `OSError` 统一收成
  `错误：CDP 调用失败：…` → **exit 2**。原本经 `run()` 的 3 个写脚本
  （`diffpair_define` / `netclass_manage` / `teardrop_apply`）直接受益；另 6 个
  （`pour_rebuild` / `import_ses` / `import_autolayout` / `rip_nets` / `undo` /
  `designator_attr`）本轮把入口从 `raise SystemExit(main())` 改为
  `raise SystemExit(_board.run(main))`——它们 `main()` 内已有 `except _board.BoardError`
  把业务码转成 `return`（读文件脚本另有内层 `except OSError` 先接自己的 OSError），
  `run` 只兜住冒出来的裸传输异常。
- **路径二 `diffpair_route._cli()`**：不走 `_board.run`，在入口做同类兜底（含 `BoardError`
  分流：`except _board.BoardError` 先于 `except (RuntimeError, OSError)`，返回 `exc.code`）。
- **路径三 `rule_edit._cli()`**：独立 `_cli()`（额外接 `ValueError`），保留、不并入 `_board.run`。
- **语义不变**：`BoardError` 是 `RuntimeError` 子类，故 `except BoardError` 仍在前，
  `BoardError.code`（2/4/5 等）语义不变；`SystemExit`（argparse `--help` / 参数错）仍原样上抛。
  本条首版曾高估覆盖面，静态审查逐个核入口后补齐 6 个漏网脚本，清单改为上述真实机制。
- **守卫是兜底，不是替代**：编排层仍应先跑 `state_check.py` 并显式判断再调写脚本。
  之所以必须兜底：预览态下写 API **会返回成功**（`clearRouting` / `delete` → true 但不生效、
  `autoRouting` 全部 failedNets、菜单整体变灰），漏检一次就会产出「空壳」结果。

`eval_cdp.py` / `diag_ns.py` 的输出**不做脱敏**——它们是调试管道，依赖方若要写报告，自己过 `lceda_cdp.redact`。

### 3.4 `eval_cdp.py` 求值上下文：`--context {api,ui}`

`eval_cdp.py` 新增 `--context`，默认 `api`（现有行为，不变）：

| context | 注入 | 页面过滤 | 用途 |
|---|---|---|---|
| `api` | `var A = globalThis._EXTAPI_ROOT_`，整段包 `(async()=>{…})()` | `pick_page(want_doc_type="pcb")` | 读编辑器 API（网络 / 图元 / 选区…） |
| `ui` | **不注入** `A`、**不包** async IIFE（表达式逐字节原样求值） | `want_doc_type=None`（首页 / 原理图 / 非 PCB 文档也能读） | 读顶层 UI DOM（`.lc_modal_*`、`.ctxmenu-ulist`、工具栏…） |

两条 context 的选页都必须**唯一**：命中数 ≠ 1 一律 `PageSelectionError` → 退出码 2，
不退回「首个 page」、不静默取 `targets[0]`。

`ui` 与 `--api` / `--file` 互斥（语义冲突：前者自带 A 注入，后者是整段脚本）：同时给出时
退出码 **2**，stderr 以 `--context ui 与 --api/--file 互斥` 开头；`ui` 缺 `--expr` 同样
退出码 2（`--context ui 需要 --expr`）。

依赖方封装 `cdp_tools.eval_api(..., context="api")`：非法 `context` 直接抛 `ValueError`
（文案列出 `'api'` / `'ui'`），**不启动子进程**；默认值保持 `api`，现有调用方无需改动。

#### 顶层 UI 判据（`--context ui` 的硬前置）

连接层 `lceda_cdp.probe_ui_shell(session)` 在求值前发一条只读探测；命中以下**外壳挂载点**
才算顶层 UI：

```
UI_SHELL_MARKERS = ("#main", "#top-wrap", "#canvas-work-space", "#toolbar-bottom")
UI_SHELL_MIN_MARKERS = 2      # 命中 ≥2 即判顶层
```

- **不要用 `#app` / `data-v-*` 判**：V4.1.78 真机顶层页没有 `#app`，`data-v-*` 属性计数为 0
  （2026-11-11 只读实测）。照 `#app` 写会把正常顶层误判成 iframe。
- **不要用 `.lc_modal_*` 判**：对话框没打开时恒为 0（同次实测顶层 `modal_like=0`），拿它当
  判据会把「没有对话框的顶层 UI」误判成 iframe。读它请用 `[class*="lc_modal"]`（CSS 类前缀
  选择器不能写成 `.lc_modal_*`）。
- 判据不满足 → `UiShellError` → 退出码 2；文案给出 `命中 N/4`、缺失挂载点清单与
  **脱敏后的** `href`（账号 / token 不进错误串）。探测超时或断连同样包成 `UiShellError`，
  不让 socket traceback 冒到调用方。

#### 已复验（2026-11-11 10:46，独占窗口）：两个 context 读的是同一份 document

复验条件写清楚，因为上一轮栽在这上面：**用户确认停手 + 本机持有 `EASYEDA_CTXMENU_LOCK`
+ 窗口可见（`document.visibilityState = "visible"`）+ 设计规则对话框开着**。四项观测：

| 观测 | `--context api` | `--context ui` |
|---|---|---|
| `location.href` | `…editor?cll=warn#id=eb9f…` | **完全相同** |
| `iframe` 数 | 2 | 2 |
| `[class*=lc_modal]` 数 | 7 | 7 |
| `typeof _EXTAPI_ROOT_` | `object` | `object` |

**结论：同一份 document，`--context ui` 不是另一个 frame。** 差异只有「注入 A / 包 IIFE /
按 docType 过滤」三件事。`hasA` **不能**用来区分 context。

> **历史留痕**：同一结论在 09:2x 也得出过一次，但那次是**多方同时驱动客户端**时采集的，
> 已作废（见 `CHANGELOG` 2.21.0 的横幅）。复验采用的条件正是当时缺的那一环：
> 独占锁 + 用户确认无人操作 + 可见窗口。
>
> 反向的说法「`--api` 读的是 iframe 的 document」仍然**没有**任何可靠证据，不要回收。

#### 原记录（当时场景，保留以对照）：
场景：工程 `agent-drill-rc50` 已打开、活动文档是 PCB（`docType=3`）、
`设计 → 设计规则` 对话框**开着**。对同一句
`JSON.stringify({href:location.href, iframes:document.querySelectorAll('iframe').length,
lc_modal:document.querySelectorAll('[class*=lc_modal]').length,
hasA:typeof globalThis._EXTAPI_ROOT_})`
分别用 `--context api` 与 `--context ui` 执行，五项观测：

| 观测 | `--context api` | `--context ui` |
|---|---|---|
| `location.href` | `https://pro.lceda.cn/editor?cll=warn#id=eb9f…` | **完全相同** |
| `document.querySelectorAll('iframe').length` | 2 | 2 |
| `document.querySelectorAll('[class*=lc_modal]').length` | 6 | 6 |
| `typeof globalThis._EXTAPI_ROOT_` | `object` | `object` |
| 选页 `want_doc_type` | `pcb` | 不卡（`None`） |

**当时的结论（那一轮作废，已被上面的独占复验取代）：同一份 document。**

> **两句话都要保留，别只留一句：**
> 1. 「`--api` 读的是 iframe 的 document」——**从未被可靠证据支持**，不要回收；
> 2. 「两个 context 读同一份 document」——已在独占窗口下复验（本小节开头），成立。
>
> 复验的价值在于**条件**：同一句 JS、可见窗口、无人并发驱动。缺任何一条，测出来的东西都作废。

### 3.5 `open_doc.py` 文档切换：走 API，不走坐标

**背景**：切文档长期靠坐标双击工程树节点（`Input.dispatchMouseEvent` 点 `(60,198)`）或点页签。
三条硬伤：缩放/分辨率一变就点偏、页签重名点错、点完只能靠 `docType` 猜成败。

**方法来源**：客户端自带的 API 参考，2026-11-11 用
`lceda-pro doc api --class-name DMT_EditorControl` 核实（客户端 4.1.78.34f5b8d9）。
这是**同一份二进制自带的自描述接口**，比任何二手文档可信。

| 方法 | 签名 | 语义（文档原文口径） |
|---|---|---|
| `openDocument` | `(documentUuid, splitScreenId?) -> string \| undefined` | 打开文档，返回**标签页 ID**；`undefined` = 打开失败 |
| `activateDocument` | `(tabId) -> boolean` | 切到该标签页并把输入焦点放进画布（**真正切换**） |
| `waitForDocumentReady` | `(documentUuidOrTabId, timeoutMs?) -> boolean` | 阻塞到文档可操作，超时 `false`（`visibility: alpha`） |
| `closeDocument` | `(tabId) -> boolean` | 关标签页；**未保存数据直接丢** |
| `getTabsBySplitScreenId` | `(splitScreenId) -> Array<IDMT_EditorTabItem>` | 该分屏的标签页（`tabId` / `title` / `documentType`） |
| `getSplitScreenTree` | `() -> IDMT_EditorSplitScreenItem` | 分屏树（`tabs` 与 `children` 不同时存在） |

**焦点判据**（不用 `docType` 数字）：
`dmt_Pcb.getCurrentPcbInfo()` 的 remarks 明写「当前打开且拥有**最后输入焦点**的 PCB」，
原理图焦点下返回 `undefined`；原理图侧对应 `dmt_Schematic.getCurrentSchematicPageInfo()`。
`open_doc.py active` 就是这两条接口的串联，`via` 字段记录是哪一条给出的答案。

**CLI 契约**

```bash
python scripts/open_doc.py --title <片段> list
python scripts/open_doc.py --title <片段> active
python scripts/open_doc.py --title <片段> open --name PCB1 [--kind pcb|sch|auto]
python scripts/open_doc.py --title <片段> open --uuid <uuid> [--no-activate] [--no-wait] [--timeout 30]
```

| 输出 | 形状 |
|---|---|
| `list` | `{"documents":[{"kind":"pcb\|sch","name","uuid","project"}], "errors":[…]}` |
| `active` | `{"kind":"pcb\|sch\|none","name","uuid","via"}` |
| `open` | `{"opened","tab_id","kind","name","uuid","activated","ready","active_after"}` |

退出码：**0** 成功；**1** 没找到 / 同名多义（消息在 stderr，列出候选与 uuid 前缀）；
**2** 前置失败（`openDocument` 返回 `undefined`，或切完 `active_after.uuid` 不等于目标）；
**3** 用法错误（`--name` 与 `--uuid` 同时给或都不给）。

**三条不许改的语义**

1. **`openDocument` 不换焦点**，必须配 `activateDocument`。少了它，
   `getCurrentPcbInfo()` 读到的是旧文档 —— 「我打开了 PCB」和「API 说不在 PCB」会同时成立。
2. **`openDocument` 返回 `undefined` 就是失败**，不许当成功往下走。
3. **切完必须回读自证**：`active_after.uuid != 目标 uuid` ⇒ **exit 2**。
   `activateDocument` 返回 `true` 只代表「调用没报错」，不代表焦点真的换了。
   `--no-activate` 时不做回读也不等就绪——否则读到的是上一个文档，制造假结论。

⚠️ **真机验证状态（2026-11-11，agent-drill-rc50，V4.1.78）**：双向都成立 ——
切 P1 后 `active_after.kind=sch` 且 `state_check` 的 `docType` **3→1**；切回 PCB1 后
`kind=pcb` 且 `docType` **1→3**。
`waitForDocumentReady` 两次都返回 `false`（该接口 `visibility: alpha`，本版**恒 false**），
所以它**不是**成败判据；主判据是 `active_after.uuid`，输出里的 `ready.note` 会说明这一点。

## 四、在依赖方的 `skill-dependencies.json` 中声明

```json
{
  "id": "leonskill-easyeda-cdp-connect",
  "type": "local-tool",
  "required": true,
  "auth_type": "none",
  "capabilities": ["endpoint-discovery", "ui-read"],
  "checks": [
    {"id": "connect-module", "type": "python", "required": true, "name": "connect-module"}
  ],
  "setup": {
    "official_home_url": "https://github.com/LeonhardtHUST/leonskill-easyeda-cdp-connect",
    "steps": [
      "在 ~/.workbuddy/skills/ 下 git clone https://github.com/LeonhardtHUST/leonskill-easyeda-cdp-connect.git（仓库根即技能根）",
      "确认 scripts/lceda_cdp.py 存在",
      "客户端需带 --remote-debugging-port 启动，见本 skill references/setup-guide.md"
    ],
    "verify": "python <本 skill>/scripts/check_environment.py --json，退出码 0 或 1",
    "security": "只走回环地址；不读 cookie 与凭据；工程数据不上传",
    "applies_to_version": "leonskill-easyeda-cdp-connect 2.x"
  }
}
```

依赖方的 `capabilities` 应按实际用到的能力填写，取值见本 skill `skill-dependencies.json` 的并集清单。

## 五、版本策略

- 语义化版本。**2.x 内**：稳定符号的签名、JSON 字段名、退出码语义、`checks[].id` 集合冻结。
- 允许的向后兼容改动：新增符号、新增 JSON 字段、新增 checks、新增脚本 CLI、改进错误消息文案。
- 破坏性改动（删改符号、改字段名、改退出码含义、改 `checks[].id`）必须升 major。
- 每次变更的时间与影响写进 `CHANGELOG.md`；依赖方升级前先读它。
- 1.x → 2.x 是破坏性变更：skill 名称、安装路径、`--connect-scripts` 参数均已变化，详见 `CHANGELOG.md`。
- 2.0.x → 2.1.0 是加法演进：新增 `version-fingerprint` 检查项（+ `dependencies[].id: client-version`）、
  新增三个脚本 CLI（差分对 / 网络类 / 美学校验）。老依赖方不需要改任何代码。

## 六、新增脚本 CLI（2.2.0）

四个脚本都遵循本契约的通用约定：单 JSON 到 stdout、退出码 `0/2/4/5`、
`--title` 用窗口标题片段选窗口、只走回环地址。

### 6.1 `scripts/menu_click.py`

```text
menu_click.py --title <片段> list  --menu 布局
menu_click.py --title <片段> click --menu 布局 --item 自动元件布局
```

- 面板定位：按「离被点按钮最近的 `.eda-menu_*` 容器」认定，不依赖节点差集
  （菜单容器常驻 DOM，反复打开时差集为空）。
- `list` 返回 `{"menu","items":[...]}`，条目为面板内全部可见项，**不做截断**。
- `click` 返回 `{"menu","item","via":"react|dom","clicked":true}`；
  **`clicked` 只代表事件已派发，不保证应用执行**，调用方必须回读业务结果。
- **二级菜单**：`list --item <一级条目>` 展开并枚举子菜单；`click --item <一级> --sub <子项>`
  先展开再点子项。展开方式是**直接调用一级条目的 React `onMouseEnter`**——
  合成 `mouseover`/真实 `Input.dispatchMouseEvent` 都不稳定（实测时灵时不灵）。
- 退出码：2 = 无该菜单/无窗口；4 = 面板里没有匹配条目（含子菜单未展开）。

### 6.2 `scripts/designator_attr.py`

```text
designator_attr.py --title <片段> read [--ref U1]
designator_attr.py --title <片段> apply --patch patch.json
```

- 位号是**属性图元**：`pcb_PrimitiveAttribute` 且 `key == 'Designator'`，
  单位 **mil**，随元件平移但**不自动转向**。
- read 输出 / apply 输入的 JSON 同构：
  `[{"ref","id","parent","x","y","rot","size","line","layer","visible","align","mirror"}]`
- apply 只写 `x / y / rotation / fontSize / lineWidth`，写完回读比对，
  不一致返回 4。

### 6.3 `scripts/export_autolayout.py`

```text
export_autolayout.py --title <片段> --out board.json
```

- 原样导出 `getAutoLayoutJsonFile()`（`boardOutline / components / footprints /
  clearance / prohibitedRegions / fillRegions`），**不做解析与坐标变换**。
- 输出 `{"path","bytes","components","footprints"}`；内容不是 JSON 返回 4。

### 6.4 `lceda_cdp.py shot` 新增参数

```text
lceda_cdp.py shot --out view.png --match usb_hub --fit [--hide 1,2]
```

- `--fit`：截图前 `pcb_Document.zoomToBoardOutline()`，避免带着上一次缩放。
- `--hide`：临时隐藏层，截完自动恢复；输出行追加 `fit=... hidden=... restored=...`。

### 6.5 `scripts/import_autolayout.py`（2.3.0）

```text
import_autolayout.py --title <片段> --file layout.json
```

- `pcb_Document.importAutoLayoutJsonFile(t)` 的 `t` 必须是带 `.text()` 的对象，
  即 `new File([text], 'layout.json', {type: 'application/json'})`；传字符串会报
  `TypeError: e.text is not a function`。
- 实测（`agent-drill-rc50`，6 元件 / 19 段走线）：按 `components[ref].location` 精确落位；
  **位号随元件平移**；**既有走线保留**；反向导入同一份基线 JSON 即完整还原（DRC 回 0）。
- 用途：一次原子应用整板布局，天然可回滚（回滚 = 重导基线）。
- 退出码：2 = 文件不可读/非 JSON；4 = 接口返回 false。

### 6.6 `scripts/undo.py`（2.4.0）

```text
undo.py --title <片段> --times 3 [--interval 0.8]
```

- 编辑器**没有 undo API**，但键盘 Ctrl+Z 有效，且能撤销 API 层动作。
- 实测：一次闭环（导入布局 → 清走线 → 逐网络布线）用 8 次 Ctrl+Z 完整回退，
  线数与 DRC 均回到起点。
- 仅作应急退路：撤销栈深度有限、会被后续编辑截断；正式回滚仍用基线 JSON。
- 输出 `{"times","lines","drc"}`；退出码 0/2。

### 6.7 `scripts/menu_tree.py`（2.6.0）

```text
menu_tree.py --title <片段> --menus 布线,布局 --depth 1 --out menu-tree.json
```

- 一次爬取多个顶级菜单，逐条标注 `kind`：`button`（有 `onClick`）或 `submenu`（有箭头子元素）。
  **判据是结构**：条目里存在 `[class*="menu-item-arrow"]` 才是二级菜单；
  `扇出布线...`、`草图自动布线...` 带省略号却是按钮，`布线模式`、`布线拐角` 无省略号却是二级菜单。
- 子菜单是**懒渲染**的：未悬停时 DOM 与 React `props.children` 里都没有子项。工具会尝试
  调用 React `onMouseEnter` 展开，拿不到就标 `submenu-unexpanded`（不挂起、不重试死循环）。
- 每次求值只做一件事（开菜单/列条目/展开），长求值会挂死（实测 120s 超时）。

### 6.8 `scripts/rpc_trace.py`（2.6.0）

```text
rpc_trace.py --title <片段> start|dump|stop
```

- 钩住 `window._MSG_BUS2_EXTAPI_.rpcCall`，记录 `method` 与 `params`，只读不改行为。
- 用途：界面难自动化的操作，让人点一次把真实调用录下来，之后按同样参数直调。

### 6.9 `scripts/state_check.py`（2.7.0）

```text
state_check.py --title <片段> [--strict]
```

- 检测「历史预览态」（橙色横幅，DOM 签名 `[class*="topTabTip"]` **可见**，即
  `getBoundingClientRect().height > 2`；关闭后容器残留但高度为 0，不能只看存在性）。
- 同时检测：历史面板是否开着（带时间戳的 `tree-rowline` 行）、可见模态对话框。
- 输出 `{"history_preview","banner_text","history_panel","modals","writable","blocked"}`；
  `--strict` 时不可写返回退出码 4。
- **`modals` 每项带可点句柄**（2.19.0 纯增量：旧键、`STATE_KEYS` 顺序、`--strict` 退出码
  都不变；字段清单与 `clickable` 判据见 **6.9.1**）。要按文字关窗用 **6.9.2** 的
  `_board.dismiss_modal(...)`（只关窗，不提交）。
- `blocked` 里模态那条**分两栏**（安全关闭 / 提交类勿点），例如：

  ```text
  存在模态对话框：输入会被对话框截获
  「退出确认」
    安全关闭：取消 / 否
    提交类（勿点）：确定
  ```

  分流规则：`kind=primary` → 提交类；`kind` 为 `cancel`/`other` 且 `clickable=true` → 安全关闭；
  `clickable=false` **两栏都不进**。分栏不是文案洁癖：混在一个「可点」列表里会诱导
  「反正列在可点里」直接点掉提交按钮——那正是 `dismiss_modal` 默认拒绝 primary 要防的事。
- 状态矩阵：预览态/模态框存在 ⇒ 一切写操作禁用（菜单灰、RPC 写入静默失败）。
  依赖方写操作前应先跑本检查。
- 2.18.0 起检测 JS 与写脚本守卫共用 `_board.py` 的单一实现（`DETECT_JS` / `judge_state`），
  输出键与 `--strict` 退出码未变；写脚本命中同一状态走 **exit 2**，本检查器仍是 4。

#### 6.9.1 `modals` 可点句柄（2.19.0，纯增量）

旧键与 `STATE_KEYS` 顺序**不变**（`history_preview / banner_text / history_panel /
modals / writable / blocked / project / docType`），新字段是增量；`modals` 的元素从
「一行文字」升级为对象（读旧值的地方仍可只做真值判断）。

- modal：`title`（旧值语义，`innerText` 截 24 字）/ `text`（全文截 200 字）/
  `selector`（逐层拼 CSS 路径，每加一层用 `querySelectorAll` 复核唯一性；
  **拼不出唯一路径时为 `null`**，不会给一个会选中别人的假选择器）/ `z_index`
  （int 或 `null`=整条祖先链 `auto`）/ `depth` / `rect{x,y,w,h}` /
  `stack_index`（**1 = 最上层**，按 z-index + DOM 序计算；数字越大越靠下）/
  `buttons[]`
  - button：`tag`（**不变量：大写 `tagName` 原值，如 `"BUTTON"`，不得小写化/归一化**——
    主仓 `dialogs.py` 的 `_button_labels()` 用 `b.get("tag") == "BUTTON"` 精确比较、
    `ui_state.py` 的 tag 过滤用 `str(tag).upper() == "BUTTON"` 大小写无关比较；
    小写化后前者会**静默**拿到空 labels，把真有「确认/取消」的框判成「只有关闭图标的
    回执框」并放行，属 fail-open。这里**不写主仓行号**：散文行号没有断言兜着，会静默漂）、
    `text`、`kind`（`primary`｜`cancel`｜`other`）、
    `index`（框内 DOM 序，**0 起**）、`selector`、`rect`、`clickable`
- `clickable=false` 的判据（任一成立即 false）：`disabled` 属性、`aria-disabled="true"`、
  **`class` 里含 `disabled`**、`pointer-events:none`、**`cursor:not-allowed`**、
  `visibility:hidden`、`display:none`、`opacity:0`、`rect` 宽或高为 0、
  `elementFromPoint(中心点)` 命中的不是它或它的后代（被遮挡）。
  **不要把 `clickable=false` 当可点**。
  真机复验（2026-11-11 10:45，独占窗口 + 用户确认无人操作 + 窗口可见）：`设计 → 设计规则`
  的 8 个文本按钮里，`默认` / `删除` 是 `clickable=false`（禁用态），`取消` 是 `cancel`、
  `应用` / `确认` 是 `primary`，其余 `other`；9 个 `selector`（弹窗 + 8 个按钮）逐个
  `querySelectorAll` 命中数都是 **1**。EDA 的禁用**不只用 `disabled` 属性**表达——
  `默认` 带 `_disabled_` 类与 `cursor:not-allowed`，但 `disabled === false`、`pointer-events`
  仍是 `auto`；只查属性 + 命中测试会误报成可点。故判据补了 class/cursor 两条
  （保守方向：宁可假阴性，也别让人去点一个点不动的按钮）。
- 嵌套对话框（遮罩/外壳/内容区都命中 `[class*="modal"]`）只保留**最内层带按钮**的
  那一个，避免同一个框出现多条。
- `blocked` 里模态那条**分两栏**（见 6.9 的示例）：`kind=primary` 进「提交类（勿点）」，
  `cancel`/`other` 且 `clickable=true` 进「安全关闭」，`clickable=false` 两栏都不进。

#### 6.9.2 `_board.dismiss_modal(board, label, contains=False, allow_primary=False)`

按按钮文字关掉**最上层**模态框（连接层内部 API，不对外暴露 CLI）。

- 返回 `{dismissed, label, modal_title, reason, buttons, selector, via, button_text}`；
  `buttons` 是实际**可点**的按钮文字列表（排障时「该点哪个」看这里）。
- `reason` 取值：`dismissed` / `still-open` / `no-modal` / `label-not-found` /
  `primary-refused` / `not-clickable`（后三条是**拒绝**，此时 `dismissed=false`）。
  - `label-not-found`：找不到该文字就什么都不点（第一个按钮很可能是「确定」），
    只回列可点文字；
  - `primary-refused`：`kind=primary`（确定/确认/应用/保存/是）默认不点，
    要显式 `allow_primary=True`；
  - `not-clickable`：检测阶段 `clickable=false` 的按钮不点。
- 判定看**框是否消失**，不看「是否点到」：点击后轮询 `DETECT_JS`，直到该
  `selector` 不再出现才 `dismissed=true`；`selector` 为 `null` 时退回「还剩不剩框」，
  宁可报 `still-open` 也不谎报成功。
- 用途边界：只用于「把挡路的弹窗关掉」，**不是**执行对话框里的动作。

#### 6.9.3 探针的两处真机修正 + Esc 兜底（2.22.0）

**① 容器不是按钮（`__mButtons`）。** 底栏常写成
`div.pop-footer-wrapper.dialog-btns-wrapper`，类名含 `btn` 就命中 `[class*=btn]`；再走
「嵌套只留外层」它成了唯一按钮，text 是「导入 导出 应用 确认 取消」，于是
`dismiss_modal(board,'取消')` 报 **`label-not-found`，框关不掉**（真机实测：图层管理器）。
判据必须是 `el.querySelector('button, [role="button"]')` 非空就跳过自己。
**不能用文本长度判** —— footer 的合并文本只有 12 个字，远小于 24 的阈值。

**② `title` 取 `[class*=header_left]`，不取内容区。** 原来取 innerText 前 24 字，实测拿到的是
「规则管理 网络规则 网络-网络规则 区域规则 间」（页签+内容），真名「设计规则」只在 header 里。
取不到才退回内容区（老弹窗没有 header_left）。这条同时决定 `dialog-taxonomy.json` 的
`title_pattern` 能不能匹配上——匹配不上往往不是正则写错，是 title 取错了地方。

**③ `press_escape(board, times=1)`。** 发 CDP **真键事件**（`Input.dispatchKeyEvent`，
`key`/`code` = `Escape`，VK 27），返回 `{"sent","times","via"}`。
- 不用 JS 合成 `KeyboardEvent`：React 侧 `isTrusted=false`，部分弹窗直接忽略。
- 用途：按钮全被容器吞掉、或一个可点按钮都没有时的**兜底**。Esc 不表达任何意图，
  不会触发保存/应用 —— 这比「点第一个按钮」安全得多。
- `times<=0` 钳到 1（不许「一个键都不发还报成功」）；无按键通道抛 `BoardError(code=2)`。

**④ 一条存疑记录：`modals` 漏报假设未排除，但不改代码。** 曾读到「双框叠加时只报 1 个」并
怀疑 `pool = withBtn.length ? withBtn : cand` 会丢掉无按钮的框。真机复验证明那次是**时间差**
（70 次 25ms 采样里框数与 DOM 组数恒等；我记的 753/38 与实测 725/66 高度差 28px，不是同一轮）。
`withBtn` 的语义确实是隐患，但没有证据表明它被触发过；改它只会扩大误报面（把常驻容器当模态）。
**「没证实 ≠ 已实现」，「没排除 ≠ 已成立」** —— 证伪方法：造一个「无按钮 + 尺寸过门 + 独立」的
模态框，看它是否被 `withBtn` 排除。

### 6.10 `scripts/export_dsn.py` / `scripts/import_ses.py`（2.9.0）

```text
export_dsn.py --title <片段> --out board.dsn
import_ses.py --title <片段> --file board.ses
```

- 导出：`pcb_ManufactureData.getDsnFile()`（File → base64 搬运）。内容以 `(PCB "..."` 开头
  （EasyEDA Pro 宿主），**不是** `(dsn`——校验时两者都要认。
- 导入：`pcb_Document.importAutoRouteSesFile(t)` 与布局 JSON 一样，`t` 必须是
  `new File([text], ...)`，传字符串报 `e.text is not a function`；SES 以 `(ses` 开头。
- 导入前应先 `clearRouting()`，否则与既有走线叠加。
- **过孔幂等（2.16.3 起默认走 `protect` 记号语义）**：导入是**追加**语义。走线叠加会被编辑器
  合并/去重，**过孔不会**——每轮重新导出的 DSN 都带着板上已有的过孔，布线器原样写回 SES，
  再导入一遍就多一层。增量布线不调 `clearRouting`（会清掉手工等长），于是实测第一轮 6 孔、
  第二轮 23 孔，其中 19 对坐标完全重合，`Hole to Hole` 直接 19 条。
  - **`mode="protect"`（默认）**：SES 里带 `(type protect)` 的记录是布线器**原样回传的既有
    布线**，按定义板上已有。导入前把这些记录从文本里删掉，只导入不带标记的新记录。
    **不做坐标匹配、不做量纲判定**——跳不跳只看标记。实测 D4（agent-drill-rc50）：
    via 39/39 全带 protect；wire 74 条里 11 条无 protect，且正好落在本轮被 `rip_nets`
    撕掉的 N1(6)/N2(7→3)/N3(2) 上。→ `deleted_via=39 / imported_via=0`，39 孔不再翻倍。
  - **`mode="coord"`（`--coord-dedupe`）**：回退路径，坐标 + `VIA_MATCH_TOL_MIL=0.06` 容差 +
    量纲锚点自证（仅 via）。用于第三方 DSN 本来不产 protect 的链路。
  - **`mode="none"`（`--no-dedupe`）**：纯追加，会把「已关掉去重」写进 `warnings`。
- 输出字段（`mode` 决定哪几组存在）：
  `mode / vias_in_ses / vias_created / vias_skipped / protect_via_count / protect_wire_count /
  deleted_via / deleted_wire / imported_via / imported_wire / existing_vias /
  via_count_before / via_count_after / settle_iters / outcome_ok / dedupe_hit_rate / warnings`；
  `divisor_used / boundary_ratio` **只在 `mode="coord"` 出现**（protect 路径为 null，两种模式不串味）。
  `--dry-run` 给 `would_delete_via / would_delete_wire / would_import_via / would_import_wire /
  would_delete_wire_nets`（网络名→段数，人据此判断删 wire 会不会断网）。
- **判据口径（重要，别拿错式子）**：
  - 主判据是 outcome：`via_count_before + imported_via == via_count_after`。`via_count_after`
    必须**轮询到收敛**（`importAutoRouteSesFile` 异步落盘，读一次会拿到旧计数 → 假绿）。
  - 普适不变式是 `deleted_via == protect_via_count`；`existing_vias` 只是**上界**
    （`rip_nets` / `--ignore-classes` 会让部分既有孔不出现在本份 SES 里），
    `skipped == existing_vias` **不是**不变式。
  - **不要**用 `import_bytes < bytes` 推断「确实写入过」：`read_text()` 把 CRLF 折成 LF，
    CRLF 的 SES 天生满足该不等式。它只是诊断字段。
- **本轮范围**：只做 via 的 protect 幂等。SES 的 protect 走线与 DSN **不是 1:1 回传**
  （实测 DSN 53 条 → SES 63 条，多出的是分段与重复），wire 幂等推迟到 2.17.0，默认不删 wire，
  仅在 `protect_wire_count>0` 时告警「预期多出冗余段」；`--drop-protect-wires` 可开，
  但先校验「protect 走线所属网络在板上已有走线」，否则拒绝（删 wire 会断网）。
- **坐标基准**（仅 `coord` 回退路径相关）：`pcb_PrimitiveVia.getAll()` 的 `x/y` 是**画布坐标**，
  与 DSN/SES 差一个常量平移（usb_hub 实测 6/6 个孔都是 `+4299.921 / -7683.020` mil）。
  所以坐标匹配必须用 DSN 的 `(via ...)` 记录；**只取条数**时用 `getAll()` 是安全的（不涉换算）。
- DSN 取不到 → **fail-closed**（exit 2），不再静默跳过；要叠加须显式 `--no-dedupe`。
- 退出码：0 成功；2 前置失败（不可读/非 SES、`[dedupe-inconsistent]` 数据自相矛盾且**未导入**、
  DSN 取不到）；4 导入接口返回 false、或 outcome 与预期不符（板子已被写过，需人工确认/回滚）。
  **不使用 3**——`_board.py` 把 2 定为写脚本的前置失败空位，3 只属于只读检查器的「检出」。
- **失败路径的机器可读原因（2.16.3 起）**：`[dedupe-inconsistent]` 这一类拒绝，除人类可读的
  stderr 外，还会往 **stdout** 打一行最小 JSON：`{"ok": false, "reason": "...", ...}`。
  `reason` 是稳定 token，当前全集：

  | token | 含义 / 触发条件 | 验证状态 |
  |---|---|---|
  | `wire-policy-conflict` | `--drop-protect-wires` 与 `--keep-protect-wires` 同时给（互斥），含 `flags` | 仅离线（替身） |
  | `wire-reimport-blocked` | 默认路径遇到 protect 走线，未显式选择处置，含 `protect_wire_count` | **真机**（`notes/d4-evidence/live5-wire-blocked.json`，2026-11-04，HEAD `0a3d449`） |
  | `dedupe-zero-match` | 既有孔与 SES 孔均非空却零命中 / protect 子集零命中 | 仅离线（替身） |
  | `anchor-indeterminate` | **有 DSN 板幅、但候选缩放假设为 0 或 2 个**（不是"缺锚点"） | 仅离线（替身） |
  | `anchor-ambiguous` | 量纲比落在 20–100 死区（板内不可能出现的 20–100 倍量级） | 仅离线（替身） |
  | `dsn-scale-conflict` | DSN 看起来被放大过，与显式 `divisor=1.0` 冲突 | 仅离线（替身） |
  | `dsn-unavailable` | 取不到当前板子的 DSN，无法判定既有孔 | 仅离线（替身） |
  | `wire-net-missing` | `--drop-protect-wires` 时，被删 protect 走线的网络在板上无走线（防断网），含 `missing_nets` | 仅离线（替身） |

  **「验证状态」列是给依赖方判断该不该依赖的，不是免责声明**：
  D4 真机复验（2026-11-04，agent-drill-rc50）走的是**成功路径**（`--drop-protect-wires`），
  8 个拒绝 token **一个都没被真机触发**——它们的字段形状与文案目前只有离线替身证据。
  要提升到"真机"，必须有意识地构造对应输入并留证；`coord` 回退路径的 3 个 token 更弱：
  真实 SES 不带 boundary，**现有板上永远触不到**（只保护 coord 的跨文件几何，不是通用能力）。

  **升级到「真机」的四档判据**（2026-11-04 补，因为本轮差点误升）：
  | 档 | 情形 | 标注 |
  |---|---|---|
  | ① | 真机触发过 + 留了证 + **触发当时该字段/ token 已存在** | 真机 |
  | ② | 真机触发过 + 没留证 | 仅离线（记"曾触发、无存档"） |
  | ③ | 从未触发 | 仅离线（替身） |
  | ④ | 真机触发过 + 留了证，但**当时字段/token 还没被发明** | **仍仅离线** |

  **④ 的存在理由**：证据与契约之间要有**时间关系**，不只是存在关系——**证据必须晚于它所证明的契约**。
  本轮的反例：`out/d4/live-protect.json` 的 `wire_policy` 是 `null`（该字段在 `3eb1de4` 才加），
  所以那次运行**不能**用来证明任何与 `wire_policy` 相关的 token，哪怕它当场被拦过。

  **「字段缺失」有三种语义，代码形状相同、处置相反**（2026-11-04 补，本轮三次踩坑的总结）：

  | 场景 | 语义 | 判定依据 | 处置 |
  |---|---|---|---|
  | `stale_nets` 缺席 | **漏传（bug）** | 该字段任何情况下都有确定值 | 必须始终输出（空则 `[]`） |
  | `divisor_anchor` 无锚点 | **值域外** | 有"没有锚点"这个合法状态 | 记 `null`，不缺席 |
  | `wire_policy` 冲突时 | **未定（不该有）** | **这里没有一个确定的值可填** | 刻意不传，并断言"不含该字段" |

  **判据是一句话**：**"这个字段在这里有没有一个确定的值可以填？"**
  有 → 必须填（缺席即 bug）；**没有 → 不该有**（填任何值都是把"未定"错标成某个状态）。
  所以"字段必须始终输出"不能一刀切；看到字段不一致时**先判属于哪一行**，否则会把"刻意不传"当成 bug 去修。

  **证据强度取决于环境是否独占（2026-11-04 补）**：`before == after` 只能证明**净变化为零**；
  若 EDA 窗口可能被并发操作，两次快照相同**不能**推广为"这个脚本不写盘"。
  要证明"不写盘"，必须同时满足：①跑前后快照同（最好字节级相同，`cmp` 无差异）；
  ②环境独占（跑前记录 `selected` 等痕迹、跑中无他人操作）；③异常中断时重跑并记录异常，不采信该次快照。

  **缺口已修（2026-11-04，随 `wire_policy` 补入拒绝出口）**：真机实测发现 `wire-reimport-blocked` 的
  拒绝 payload 只有 `{"ok": false, "reason": ..., "protect_wire_count": 63}`，**不含 `wire_policy`**，
  而 `--dry-run` 的 blocked 分支有该字段——同一策略在两条出口上字段不一致，依赖方按 `wire_policy`
  判断会漏。现已统一：**凡是策略已定的 wire 出口都带 `wire_policy`**
  （`wire-reimport-blocked` → `"blocked"`、`wire-net-missing` → `"dropped"`）；
  `wire-policy-conflict` **刻意不带**——冲突时策略未定，塞任一值都会与"默认被拦"或"已选择"混淆。
  判据沉淀：**一个策略有几个值，就要问它在几个出口输出**；本次漏的正是 `blocked` 的第二条出口
  （dry-run 有、实跑没有）。
  证据：`notes/d4-evidence/live5-wire-blocked.json`（真实 payload）+ `.err`（人话说明）+ 前后 `board_check` 快照。

  **命名纪律**：token 名必须描述**真实触发条件**。`anchor-indeterminate` 就是由 `anchor-missing`
  改名而来——后者字面是"没有锚点"，实际是"有板幅但判不出"，按字面造测试会一直造错
  （**名字暗示 A、行为是 B，比没名字更危险，因为测试和文档都会照着名字写**）。
  `2=不可读/非 SES`、`4=接口返回 false` **保持空 stdout**，不重定义全部失败路径。
- **用例书写规范**：每条失败路径用例在 docstring 标注「断在第 N 段」，N 取
  `1 参数语义 / 2 环境可用 / 3 状态匹配 / 4 判据可用 / 5 幂等门禁 / 6 写入结果`。
  红了立刻知道该看哪一段，不必从"板面不对"反推（反推时 6 段里任一段都可能，成本高一个数量级）。
- 配套（真无头）：FreeRouting **v2.5.0 + `--gui.enabled=false`**，需 Java 25
  （`java -jar freerouting-2.5.0.jar -de b.dsn -do b.ses -mp 30 --gui.enabled=false -da`）。
  v1.9.0 在 Java 23 可跑但 `-de/-do` 仍会弹 GUI（AWT headless 报 HeadlessException），
  仅作降级备选。

### 6.11 `scripts/freerouting_run.py`（2.10.0）

```text
freerouting_run.py --dsn board.dsn --ses board.ses [--passes 30] [--timeout 900]
```

- 外部布线器 FreeRouting 的无头执行器，与 6.10 的 DSN/SES 构成完整外部布线通道。
- 固定使用 **v2.5.0 + `--gui.enabled=false`**（真无头）；便携 JRE 25 位于
  `~/.workbuddy/binaries/java25/`，不依赖系统 Java。
- 依赖方只做决策（遍数、何时用外部布线），执行细节（java/jar/参数/超时）归本脚本。
- 退出码：0 成功；2 jar/JRE25/DSN 缺失；4 布线失败；5 超时。

### 6.12 `scripts/pour_rebuild.py`（2.11.0）

```text
pour_rebuild.py --title <片段> [--ids a,b] [--wait 8]
```

- 铺铜「灌注」**没有 RPC**（`pcb_PrimitivePour` 只有 create/get/modify/delete），唯一路径是界面动作：
  选中铺铜框（RPC）→ 点工具栏 **「重建铺铜区」** → 等 `PrimitivePoured` 出现。
- 按钮只在选中铺铜时存在，且大板渲染有 ~0.6s 延迟——脚本轮询最多 5s 并二次选中兜底。
- 布局挪动元件后必须执行，否则旧铜皮与新焊盘冲突（DRC 来源）。
- 退出码：0 成功；2 无铺铜/面板未出现；4 重建后仍无灌注。

### 6.13 `scripts/freerouting_run.py` 参数（2.11.0 补充）

新增 `--threads`（-mt）、`--ignore-classes`（-inc）、`--optimizer-threshold`
（--router.optimizer.improvement_threshold）。注意 `-inc` 匹配**网络类**：EasyEDA 导出的 DSN
每个网络自成一类，实测 `-inc GND` 在 usb_hub 上**未**阻止 GND 布线，勿依赖。

### 6.14 `scripts/dsn_pairs.py`（2.12.0）

```text
dsn_pairs.py --dsn in.dsn [--out out.dsn] [--auto | --pairs D3_P:D3_N,...]
```

- 按 Specctra 规范注入 `(pair (nets A_P A_N))`（freerouting issue #358 的真实 DSN 语法）。
- **FreeRouting 2.5 解析后完全忽略**：同板带/不带 pair，score 553.82、未布通 14、violations 228
  逐项一致（实测）。价值仅为格式合规与换布线器（Electra/TopoR）。
- 差分对的现实解是「不清差分对走线」——但实测更差（见 connect 计划文档），
  最优配置仍是「清空 + 全量重布 + 铺铜重建」。

### 6.15 `scripts/fastroute_run.py`（2.13.0）

```text
fastroute_run.py --dsn b.dsn --ses b.ses [--pairs pairs.txt] [--tune t.txt]
                 [--passes 30] [--timeout 900] [--report r.json]
```

- fastroute（Rust，GPL-3.0，免费商用）是 Freerouting 的重写：同 DSN/SES 接口、无 Java、
  **同板 0.85–1.4 秒**（FreeRouting 24 秒），导入后 DRC 与 FreeRouting 最好成绩持平（5）。
- **`--pairs` 必须用等号形式 `--pairs=FILE`**（`main.rs` 只匹配 `strip_prefix("--pairs=")`；
  空格形式 `--pairs FILE` 会被静默丢弃，表现为「pair 阶段完全不出现」——这是踩过的坑）。
  同理 `--tune=FILE`、`--report=FILE`。
- 触发后日志给出每对的耦合长度与 skew：
  `diff pair D3_P/D3_N (pre-routed): coupled 0.00 -> 0.00 mm of 1.73 mm (no room beside the pair)`。
  密集小板常见 `no room beside the pair`——那是几何限制，不是功能失败。
- 输出字段 `pair_stage_seen`（是否进入 pair 阶段）与 `pair_log`（每对耦合情况）如实上报。
- 二进制：`~/.workbuddy/binaries/fastroute/fastroute-0.1.14-windows-x64/fastroute.exe`。

### 6.16 `scripts/net_skew.py`（2.14.0）

```text
net_skew.py --title <片段> (--auto | --nets D3_P:D3_N,...) [--tol-um 100]
```

- `pcb_Net.getNetLength(net)` 返回**微米**（实测 D3_P=1734.4 µm ≈ 1.73 mm）。
- 按 `_P/_N` 自动配对，输出每对的 `p_um/n_um/skew_um/ok`；超差退出码 3。
- usb_hub 实测：D3 98.0、D2 -50.1、D4 99.5、D1 -56.5 µm（均 ≤100），
  **D 对 319.6 µm（超差 3 倍）**。
- 等长组的创建接口存在（`pcb_Drc.createEqualLengthNetGroup(name, nets, color)`），
  但建组只是标记，不补蛇形；补线靠布线器 `--tune=` 或人工。

### 6.17 `scripts/pair_anchors.py`（2.15.0）

```text
pair_anchors.py --title <片段> (--auto | --nets D3_P:D3_N,...) [--out out.json]
```

- 用途：给走廊布局求解器提供「这对差分线接哪两个元件」——即领域层仓库
  `leonskill-easyeda-connect` 的 `placement.py --pair-corridors`（两者同名易混，此处指明）。
- **焊盘归属不需要 `pcb_PrimitivePad`**：`pcb_PrimitiveComponent.getAll()` 返回的每个元件里
  已经带 `pads:[{primitiveId, net, padNumber}]`，按 net 过滤即可直接聚合到元件。
  （`pcb_PrimitivePad.getAll()` 只有 `x/y/net`，没有所属元件，反查只能靠坐标近似。）
- 算法：取 P/N 两条网络触达的全部焊盘 → 按元件聚合焊盘数 → 取**焊盘数最多的两个**元件作为
  anchors（并列时按位号字典序，保证结果稳定）→ 输出元件**中心**坐标（mil × 0.0254 = mm）
  与中心距 `distance_mm`。
- 输出：

```json
{"pairs": [{"pair": "D3", "p": "D3_P", "n": "D3_N", "pads": {"U1": 2, "USB3": 2},
            "anchors": [{"ref": "U1", "x_mm": 127.763, "y_mm": -176.543, "pads": 2},
                        {"ref": "USB3", "x_mm": 171.578, "y_mm": -183.655, "pads": 2}],
            "distance_mm": 44.388}],
 "missing": [], "components": 18}
```

- 某对找不到两个锚点（网络未布线 / 只连一个元件）→ 放进 `missing:[{"pair","p","n","reason"}]`
  并继续，不抛异常，退出码 3。
- usb_hub 实测（2026-11-03，只读）：5 对全部命中 U1（SL2.1A）+ 对应 USB 口——
  D3→USB3（44.39 mm）、D2→USB4（19.24）、D4→USB2（19.58）、D1→USB5（44.22）、
  D→USB1（13.36，USB1 有 4 个焊盘，双口并联）。`missing` 为空。

### 6.18 `scripts/export_dsn.py` 规则校正（2.16.0）

```text
export_dsn.py --title <片段> --out board.dsn [--min-clearance-mm 0.203]
```

- 背景（本条的由来）：`getDsnFile()` 导出的间距规则是 `(rule(clear 6.05))` ×3 +
  `(clearance 4)` ×17（单位 mil = 0.154 mm / 0.102 mm），**低于 EDA 实际 DRC 要求 0.2 mm**。
  全量布线时这点误差被铺铜重建掩盖；**增量布线**（保留其它走线）时新走线贴保留走线布，
  直接爆十几个 clearance。手工把两条规则提到 8 mil（0.203 mm）后，同一走廊场景下
  D 对 skew 从 268.4 µm 改善到 153.2 µm。
- `--min-clearance-mm MM`（默认 `0` = 关闭）：导出后对 DSN 文本做规则提升，三类目标——
  `(rule(clear X))`、`(rule(clear X (type ...)))`、`(clearance Y)`——凡是**小于**目标的都
  提到目标值换算的 mil（`MM / 0.0254`，**向上**取到 0.01 mil；`0.203 mm → 8`）。
- **只提升不降低**（`max` 语义）⇒ 幂等：对已提升过的文本再跑一次，`rules_lifted` 为 0、
  文本逐字节不变。四舍五入是错的（0.203 mm 会舍成 7.99 mil < 0.203 mm），必须向上取整。
- 不给 `--min-clearance-mm` 时**完全不动文本**：导出字节与 2.15.0 逐字节一致（向后兼容）。
- 输出：`{"path": "...", "bytes": 34677, "rules_lifted": 20}`；`rules_lifted` 是本次实际改动
  条数（未启用时为 0）。
- usb_hub 实测（2026-11-03）：`--min-clearance-mm 0.203` → `rules_lifted=20`，DSN 里
  `(rule(clear 8)` ×3、`(clearance 8)` ×17 各就位；再跑一次 `rules_lifted=0`。
- 注意：本脚本只改**导出的 DSN**，不写 EDA 设计规则；板面规则另走 `netclass_manage.py`。

### 6.19 `scripts/rip_nets.py`（2.16.0；2.17.0 增加 `--ids`）

```text
rip_nets.py --title <片段> (--nets GND,VCC33 | --ids a1b2,c3d4) [--dry-run]
```

- 用途：增量布线的第一步——**只腾空要重布的网络**。`clearRouting()` 会连手工调好的等长/
  蛇形一起清掉，这里按网络名（`--nets`）或线段 id（`--ids`）精确匹配删 `pcb_PrimitiveLine`。
- 两个选择器**互斥、必给其一**：
  | 选择器 | 删什么 | 用在哪 |
  |---|---|---|
  | `--nets GND,VCC33` | 这些网络的**全部**走线 | 整网撕（`--rip-mode whole`、历史调用方） |
  | `--ids a1b2,c3d4` | 这些 `primitiveId` 的走线，同网络其它段原样保留 | **外科式撕网**（2.17.0） |
  `--ids` 的判据由上层算（「端点落在被挪焊盘 1.5 mm 内的被挪件网走线 ∪ 目标对」）：
  实测整网撕 74 段 → skew 83.5 µm / DRC 11，外科撕 41 段 → skew 7.1 µm，撕得越少越好。
- **只删走线，不删过孔**：过孔属网络拓扑，删走线后孤立的过孔交给布线器 / 铺铜处理；
  要连孔一起删是另一件事，本脚本不做（未来如需另加 `--vias`）。
- `--dry-run` 只统计不删（统计口径与真删完全一致），建议先在干跑里看清数字再动手。
- 输出（单 JSON）：

```json
{"deleted": 46, "per_net": {"GND": 43, "VCC33": 3}, "remaining": 134, "dry_run": false,
 "mode": "nets", "matched": ["GND", "VCC33"], "missing": []}
```

  `deleted` 匹配到的走线段数；`per_net` 按网络分组——**请求了但板上没有走线的网络补 0 写入
  `per_net`**，同时在 stderr 打一条提示（提示文本本身不进 JSON）；`remaining` 是**操作后**全板剩余
  走线段数（增量布线的「保留 M 段」）。
  `mode` 是本次用的选择器；`matched` 是命中的选择器键；`missing` 是请求了但板上没有的键
  ——外科撕网**必须看 `missing`**：算出来的 id 已被上一轮删掉/被编辑器合并时 `deleted` 会变小，
  要靠它区分「集合过期」与「板上本来就没有走线」。
- `--ids` 走命令行参数，不走文件：180 段线的 id 拼接约 4 KB，远低于 Windows 32K 上限。
- 退出码：0 成功（含「一条也没匹配到」）；2 前置失败（窗口/参数/接口）；不留常驻副作用。
- usb_hub 实测（2026-11-03，`--dry-run`）：`{"deleted": 46, "per_net": {"GND": 43, "VCC33": 3},
  "remaining": 180}`——板面基线 180 段，撕掉这两网后应剩 134 段。**删除动作未在本轮验证中
  执行**（只验 dry-run）；要回退用 `undo.py`。

### 6.20 `scripts/fastroute_run.py` 差分对等长目标（2.16.1）

```text
fastroute_run.py --dsn b.dsn --ses b.ses [--pairs pairs.txt] [--passes 30] [--pair-skew 0.05]
```

- `--pair-skew MM` 透传给 `fastroute --pair-skew=`：**配对两网允许的长度差**（默认 0.1 mm，
  `0` = 关闭蛇形补偿）。依据是 0.1.14 `--help`：「pairs file: ... after routing ... meanders
  until the lengths differ by at most `--pair-skew` (default 0.1 mm; 0 = off)」；pairs 文件里
  每对还可用 `skew=` 单独覆盖（`pair /D_P /D_N gap=0.2 skew=0.05`）。
- 输出新增 `pair_skew`（回显本次传的值，未传为 null），其余字段不变。
- 用途：增量布线的轮次变体——同一个 DSN 上 `--pair-skew=0.05` 会比默认 0.1 mm 更用力地补
  蛇形，用来判断「skew 收敛不了是几何限制还是目标太松」。布线器确定性 ⇒ 重跑相同输入无意义，
  换参数才有信息量。

### 6.21 `scripts/rule_edit.py`（2.18.0，**未上板验证**）

> **本节脚本的 DOM 定位与坐标标定尚未在 4.1.78 实机验证。** 编写时 EDA 实例被另一会话占用；
> `--set-track-mm` 是照 `notes/52` / `notes/53` 的实测记录复刻的，不是本轮跑通的。
> `--get` 走的 API 读路径有历史实测（`notes/52` §3.1、`notes/53` §五，**非本轮、非本脚本**），
> 但 `rule_edit.py` 自身端到端仍是**未上板验证**。

```text
rule_edit.py --title <片段> --get
rule_edit.py --title <片段> --set-track-mm <MM> [--backup <PATH>]
rule_edit.py --title <片段> --drc-samples <N>
```

三个动作互斥、必给其一（`--backup` 只配 `--set-track-mm`）：

| 动作 | 读写 | 做什么 |
|---|---|---|
| `--get` | 只读 | 打印当前「导线-导线」间距、配置名、命中的键路径 |
| `--set-track-mm MM` | **写** | 开 `设计 → 设计规则...` 对话框，在「规则管理」首格写值后点「确认」，再回读校验 |
| `--drc-samples N` | 只读 | 先关掉一切可见弹窗，再连跑 N 次 `pcb_Drc.check()`，打印每次条数与分组 |

- 退出码：**0** 成功 / **2** 前置失败（无窗口、非 PCB、不可写状态、对话框打不开或关不掉、
  首格读数与 API 读数不符而主动放弃、**CDP 调用/传输失败**）/ **4** 断言失败（输入框没接受新值、
  确认后回读与目标不符）。**本脚本退出码集合只有 0/2/4 三个值**：入口 `_cli()` 在 `_board.run` 之外
  再捕 `RuntimeError` / `OSError` / `ValueError`（CDP 报错抛的是裸 `RuntimeError`，`Session.call`
  被拒、连接中途断都走这条），打印 `错误：CDP 调用失败：…` 后 exit 2——不会出现 exit 1 + traceback。
  **别把这个 2 一律读成「参数/环境检查没过」**：否则传输中断时会原样重试同一条命令，
  永远看不到真正原因。按 stderr 是否带 `CDP 调用失败：` 区分「要重连/重开窗口、或换掉坏备份」
  与「原样重试即可」。
  **2.18.2 起，「传输异常不冒 exit 1 + traceback」已不是本脚本独有**：其余写脚本经
  `_board.run`（入口改为 `_board.run(main)`）与 `diffpair_route.py` 入口 `_cli()`
  做同类兜底（含 `BoardError` 分流，见 §3.3）。但各脚本的退出码集合并不因此统一为 0/2/4
  （`diffpair_route` 仍有 3 / 4 / 5），本脚本的 `_cli()`（含 `ValueError` 兜底）仍是独立实现。
- 读值键路径：`config["Spacing"]["Safe Spacing"][<厚度分组>]["tables"]["1"]["content"][0][0]`。
  厚度分组**两种形状都存在**，必须按存在键取（写死任一种都会在另一种状态下读不到）：
  `copperThickness1oz`（对话框写入口的形状、有命名或已应用过规则）/ `Default`（未命名自定义配置），
  两者都在时优先 `copperThickness1oz`；都取不到再兜一次「带 `tables` 的 dict」。`--get` 输出的
  `path` 回显实际命中的分组与表号，排错照它看，别猜 `Default`。
- 为什么必须走 UI：`overwriteCurrentRuleConfiguration(cfg)` 与 `saveRuleConfiguration(...)`
  两条 API 写入路径**返回成功/失败但配置不变**（`notes/52` §3.2）；唯一真正写进规则的通道是
  对话框的「规则管理」表格（`notes/53`：写 1.0 / 5.0 / 0.1016 三次回读全准）。
- **已知副作用**：点「确认」后配置名会从 `""` 变成「自定义配置」。这是「应用规则」的伴生改名，
  不是本脚本引入的；`--set-track-mm` 在输出里照实提示（`config_before` / `config_after`）。
- **已知坑**：对话框开着时 `pcb_Drc.check()` 会抛「指定的主题消息在对应的画布内没有相关订阅」。
  所以 `--drc-samples` 跑之前必须先关对话框，`--set-track-mm` 结束（含异常路径）也必须回到无弹窗
  状态，否则后续 DRC 链路全部失败。关不掉算前置失败（exit 2）而不是告警：非设计规则的弹窗
  （工程设置、更新 PCB）可能承载用户未提交的改动，脚本不替用户点它们的「取消」。
- **点「确认」的搜索范围收窄**：点确认是破坏性动作（点错一次规则就被应用），所以先在
  `__ruleDialog()` 圈定的设计规则对话框内找 `button[title=确认]`，取不到才退回全局可见弹窗搜索。
  为什么必须先限定在对话框内：全局搜索是**精确等值**匹配 `title`（`__rectOfButton` 里
  `getAttribute('title')` 与目标不严格相等就 `continue`），所以**不会**误点 `应用` / `取消` / `恢复默认`
  （它们 title 不同）；真正的风险是**别的弹窗里也有 `title="确认"` 的按钮**（工程设置、更新 PCB
  这类），全局搜索会跨弹窗命中它——等于替用户确认了另一个对话框的未提交改动，本对话框反而没被
  确认，只能靠回读不符 exit 4 事后暴露（副作用已经发生）。
  走兜底时 stderr 会打一条 `提示：「确认」按钮没有在设计规则对话框内找到，退回全局弹窗搜索并命中
  （坐标可能来自其他弹窗，回读校验会兜住结果）`——看到它就说明这一击不是对话框内命中，
  正确性只剩回读校验兜底（回读不符即 exit 4）。**这条提示指向未验证清单第 1 条**（对话框没被
  `__ruleDialog()` 认出来：innerText 不含「规则管理」/「设计规则」，或尺寸不到 600×400），
  不是第 3 条——若真是 `title` 文案写错，全局搜索同样找不到，直接 exit 2 而不会打这条提示。
- 改动前自动备份整份规则配置（`--backup PATH` 落盘；不给就打 stderr 并回报字节数）。
- 写入前有两道防线，任一不符都 **exit 2/4 且不写入**：① 对话框首格显示值要与 API 读数一致
  （容差 1e-2 mm，显示值被四舍五入过）——对不上说明定位到的不是「导线-导线」格，继续写就是改错
  规则；② 写入后回读要与目标一致（容差 1e-3 mm）。
- **首次上板 SOP**（顺序不能颠倒）：
  1. `--get` 核对读数（配置名、间距、`path` 与界面上看到的一致）；
  2. `--drc-samples 3` 取基线计数，确认「关掉弹窗后 DRC 能跑」（3 次一致才算基线）；
  3. 再 `--set-track-mm <值>`，判据是回读一致（容差 1e-3 mm）；成功后当场 `--get` 复核一次。
- 未验证清单（首次上板逐条核对，不符按报错改常量）：对话框识别条件（宽≥600 高≥400 且 innerText
  含「规则管理」/「设计规则」）、input 序位假设（首格即可编辑数值框）、「确认」按钮的 `title`
  属性与它在对话框内的位次、顶部菜单「设计」里的条目名、「确认」的生效时机（假设 2 秒内弹窗自关；
  若实机是异步生效，「取消」可能抢在写盘之前，按 stderr 的「关闭时机存疑」与回读结果排查）。
  前四处不符会 exit 2 且**不写入**；第五处只影响时序，表现为 exit 4 回读不符或上述 stderr 警告。
- **stderr 里可能有不影响退出码的警告**（编排层若要断言「stderr 干净」，先排除这几条）：
  ① 点完「确认」后 2 秒弹窗仍在 → `警告：「确认」后 2 秒弹窗仍在（可能还没生效），再等一轮`；
  再等 2 秒仍在 → `警告：关闭时机存疑…`（此时请手工复核界面，回读若一致说明没被「取消」抢掉）；
  ② 异常路径收尾（关对话框）失败 → `警告：异常路径关闭对话框时出错（不影响本次退出码）：…`，
  只留痕，退出码仍由主流程决定。
- 回滚：`--backup` 的 JSON 是改前快照；本次只改单个标量，最省事的回滚是用同一个值再写一遍
  （对话框路径幂等，回读确认即可）。

### 6.22 `scripts/ctxmenu.py`（2.19.0）

**右键菜单的通用驱动**：枚举 / 按路径点击 / 关闭 / 板面指纹。落点是「把右键菜单当能力清单用」，
所以它必须能**在不执行动作的前提下**把一个菜单枚举完整——下面三条是踩出来的，不是设计出来的。

**CLI**

```bash
python ctxmenu.py --title <片段> list   [--context <id>] [--deep] [--json] [--out DIR]
python ctxmenu.py --title <片段> click  --path "添加/添加泪滴..." [--allow-write] [--keep-open]
python ctxmenu.py --title <片段> close
python ctxmenu.py --title <片段> snapshot [--drc] [--out FILE]
python ctxmenu.py --title <片段> states
```

`--target` 决定右击位置：`canvas`（默认，`iframe.editframe` 中心）/ `xy:X,Y` / `selector:CSS` / `text:文本`。
`--doc-type pcb|sch|footprint|panel` 决定连哪类文档（`_board.Board` 因此新增 `doc_type` 形参，默认仍 `pcb`）。

**三条实测事实（改代码前先看）**

1. **菜单项 = 带 `data-test` 的叶子**；快捷键是**另一行** `<div class="content-tips_*">`。
   第一版按「所有叶子」枚举，把 `Ctrl+F` 当成菜单项，13 项被数成 18 项。
2. **「二级菜单」不是新面板，是同一面板内原地展开**：点「过滤」13→23 项、「移动」13→16、
   「网格尺寸」13→27，`.ctxmenu-ulist` 的 rect 不变。判据只能是「同面板项数增长」，
   不能找「新出现的浮层」。
3. **静态分不出 expander 与 action**：`[class*="arrow"]` 0 命中；hover 1.2 s 也不展开；
   而点击会**执行**动作。唯一安全探法是**键盘**：`ArrowRight` 只展开、不执行，`ArrowLeft` 能收回
   （实测 13→23→13）。`--deep` 就是这么做的：`ArrowDown` 逐项移焦点 + `ArrowRight` 试探 + 比项数。
   注意子项是**插在该项后面**的，不是追加到末尾（按尾部切会拿到别的项）。

**独占锁**：客户端只有一份，两个进程同时右键/切文档会把对方上下文搞掉。脚本内置
`client_lock()`（`O_EXCL` 建 `%TEMP%/lceda-ctxmenu.lock`，`ts` 超 90 s 视为死锁可抢占），
`--agent` 写进锁文件、`--wait-lock N` 可等待、`--no-lock` 只在确定无人用时才用。
**拿不到锁就 exit 2，不许"试一下"。**

**写入门禁**：`click` 默认只允许只读前缀（`查找/过滤/常用/仅/显示/隐藏/取消/刷新/缩放/查看/复制/粘贴/选择/清除高亮`），
其余必须 `--allow-write`；`--path` 用 `/` 分层，逐级悬停展开、末级点击（真鼠标点击，React 回调只作退路）。

**两套菜单后端（2.19.1，必须都认）**

| 后端 | 出现在 | 容器选择器 | 项选择器 | 二级标记 | 展开方式 |
|---|---|---|---|---|---|
| `ctx` | PCB 画布、通用右键 | `.ctxmenu-ulist` | `[data-test]` 叶子 | **无** | 键盘 `ArrowRight` 试探 + 比项数 |
| `eda` | **原理图**（与顶栏菜单同源） | `[class*="eda-menu_"]` | `[class*="eda-menu-item"]` | **`eda-menu-left-arrow_*`** | **hover**（0.5 s 内出独立浮层） |

`sources[i].backend` 会带回来是哪一套；`dump` 的输出结构一致，调用方不用分支。

**三个坑（都实测踩过）**

1. **类名带 hash 后缀**：原理图容器是 `eda-menu_Evt3D`、项是 `eda-menu-item_g86Ag`。
   用精确 `.eda-menu` / `.eda-menu-item` **一条都查不到** —— 这一条让「原理图右键唤不出菜单」
   被误判了整轮。必须用属性包含选择器。
2. **项是两层嵌套**：`eda-menu-item_*` 里面还有 `eda-menu-item-text_*`，两者都匹配
   `[class*=eda-menu-item]`。只收「自己含 text 子元素」的那层，否则 9 项被数成 18。
3. **文本与快捷键是两个兄弟 span**，`textContent` 会把它们粘成「交叉选择...Shift+X」。
   正确取法：标签 `span[data-test]` 的 textContent（中文）+ `.hotkey-text_*`（快捷键）。
   `span[data-test]` 的**属性值是英文原名**（`Cross Probe...` / `Fit All in Window` / `Filter`），
   比中文更适合映射 API。

**两条行为结论（决定状态矩阵规模）**

- **PCB：菜单强依赖选中类型** —— 未选中 13 项、选中器件 **32 个顶层项 +「高亮」7 子项**、
  选中导线 **28 个顶层项 +「板子形状」2 子项**、选中铺铜 28 项 / 15 expander。
  多选同类型与单选同类型**逐项相同**（2 焊盘 = 1 焊盘）。
  （2.19.2 更正：原先写的「46 项 = 39+7」「32 项 = 30+2」是**重复计数**，见下节。）
- **原理图：菜单恒定 9 项，与选中态无关** —— 选中 R1 后右侧「选中数量 1」、画布红框、
  属性面板显示 R1 的 13k/R0603（选中是真的），但菜单与未选中时**逐项相同**。
  所以按图元给原理图分 7 档是假分档，`CONTEXTS` 已合并为一条 `sch.canvas`。

**失焦退路**：整个原理图页在「没有焦点」时右键**完全不响应**（不是菜单被藏起来，是事件没被吃）。
`open_menu` 先直右键，失败才补一次左键点击再试 —— 有选中的场景（右键本就成功）不会走这条，
因此不会把选中点掉。

**双面板折叠（2.19.2，修重复计数）**

`component` / `track` 右键时右侧会**同时**出现第二个 `.ctxmenu-ulist`，且它是主面板 DOM 的
后代。旧 `DUMP_MENU` 用主面板 `querySelectorAll('[data-test]')` 把子项也收了进来：
component 记 39+7、track 记 30+2，其实是**同一批项被数了两遍**（真实结构 32 顶层 + 7 子项 /
28 顶层 + 2 子项），子项还被平铺成顶层项、没挂到任何父项下。

修法两处：① `DUMP_MENU` 与 `COUNT_MENU` 的 ctx 分支都按
`le.closest('.ctxmenu-ulist')!==panel` 判归属，只收属于自己的项（两者必须同口径，否则
`count_items()` 比 `dump()` 多出子面板项，键盘探测立刻误判展开）；② `attach_subpanels(data)`
纯函数把第 2..N 个面板按「子面板首项 cy 差最小」挂到父项上（设 `expander` / `children` /
`sub_panel_rect` / `sub_panel_index`），折叠后只留主面板。ctx 分支同时补 `label`（`data-test` 值）。
离线回归见 `tests/test_ctxmenu_subpanels.py`（不连客户端）。

**已知限制**：`deep_expand` 折叠成功后直接返回，**不再跑原地展开的键盘探测** ⇒
component/track 里其它二级菜单（例如 track 的「查找」）不会被标成 expander；
`--deep` 之外的 `list` 保留两个面板的原始结构、不折叠。这两条都待真机复核，
本轮（2026-11-09）未连客户端，不宣称已验证。

**`snapshot` 的字段与「读不到」的诚实标注（2.19.5）**

| 字段 | 内容 | 可读性 |
|---|---|---|
| `counts` | lines / vias / comps / pours / pads 计数 | ✓ |
| `nets` | 网络名数组 | ✓ |
| `geo` | `[type, x, y, layer, net]` 图元**参考点** | ✓（跨区域长线段会被低估） |
| `details` | 器件 `designator / layer / locked / footprint` | ✓ |
| `selection` | `{count, ids}`，来自 `pcb_SelectControl.getAllSelectedPrimitives()` | ✓ |
| `filter` | 当前过滤配置（33 个布尔键），来自 `pcb_Document.getCurrentFilterConfiguration()` | ✓ |
| `active_doc` | 活动**文档**页签标题（`getSplitScreenTree().tabs` 白名单过滤 DOM） | ✓ |
| `pcb_context` | 当前是否 PCB 文档；`false` 时板面维度不可比 | ✓ |
| `layers` | `{locked: [层名…], total: 260, source_field: 'locked'}` | ✓ |
| `prim_locks` | `{line, via, pad, pour, comp}` → 各类型**已锁定条数** | ✓（某类型读不到就不写该 key） |
| `drc` | `errorType|ruleName` 排序数组 | 仅 `--drc` |
| 视口 / 高亮集 | — | **没有 getter**：`dmt_EditorControl` 只有 zoom 系列设置器，`pcb_Net` 只有 `highlightNet` / `unhighlightNet` |

**`prim_locks`：画布「锁定」唯一可见的维度（2.19.6）**

`details` 只 map 器件，所以线段 / 过孔 / 铺铜 / 焊盘被锁时它一条都不变。
只比 details，会把「锁了一条线」判成「什么都没发生」。所以另记各类型的**锁定条数**：

- 只记计数、不记逐条：判据问的是「锁定动作有没有改变图元的锁定状态」，数量足够回答；
  逐条记会把 66 线 + 39 孔全塞进快照，而且这些图元没有稳定 id。
- **某类型的 `getAll()` 读不到时，不写这个 key**（不是写 0）。写 0 会让上层把
  「非 PCB 文档 / 读取失败」当成「这个类型一条都没锁」。
- `menu_equiv.diff_prim_locks` 只比**两边共有**的 key。

**`layers` 的三个坑（2.19.5）**

1. **只认 `locked`（退一步认 `lock`），不要用 `layerStatus` 兜底**。`layerStatus` 是
   「层是否启用」——`add_custom_layer` 的 `removeLayer` 之后层仍留在表里、只有
   `layerStatus` 1→0。拿它当锁定，会把所有启用层读成「已锁定」，是假读数。
2. **`source_field` 必须回写**（命中哪个字段 / `null`）。字段名读错时 `locked` 恒为空数组，
   看起来像「没有层被锁」—— 这是最坏的一种错：静默通过。`null` 时 `menu_equiv` 判
   `inconclusive` 并留 warning。
3. **`total` 不参与判定**。它随文档/工程变，拿它判等价等于把「换了文档」算成动作效果。

**故意不写 `viewport` / `highlight` 键**：缺字段本身就是判据。`menu_equiv.py` 会因「两侧都没有
这些字段」把「适应全部 / 高亮 / 属性」这类动作判 `inconclusive`，而不是拿三份全同的板面快照
谎称等价 —— 假通过比测不出更坏。真要测这三类，得先找到能读视口/高亮态的接口，不是改判据。

**已知边界**：`kind=unknown` 表示「静态判不出、也没做深探」——不要把它当 button 用；
`snapshot` 的 `geo` 只取图元**参考点**（X/Y），跨区域长线段会被低估，等价判定要配合 `counts` 与 `details` 一起看。
