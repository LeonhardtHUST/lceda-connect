# 来源与移植对照（cdp-connect）

本目录随 npm 包发布，供 MCP resources 与 `skill_docs` 读取。内容来自下面这个仓库：

- 来源仓库：`D:\Projects\GitHub\leonskill-easyeda-cdp-connect`
- 提交：`9720f0802793d4e79aebd5374565419b8f1057e1`
- 许可证：MIT（源仓库 `LICENSE`，Copyright (c) 2026 LeonhardtHUST）

## 原样收进 assets 的文件

根目录 `SKILL.md` 与 `references/` 下全部 17 个文件（16 篇 Markdown 加 `menu-catalog.json`）从源仓库原样复制，没有改内容。源仓库的 `notes/`、`docs/`、`tests/`、`tools/`、`scripts/`、`out/` 不在本目录内。

`references/api-contract.md` 的 §3.4（求值上下文）、§3.5（文档切换）、§6.9（编辑器状态与模态框句柄）是 `src/cdp/eval.ts`、`src/cdp/docs.ts`、`src/cdp/board.ts` 的语义依据，文档保留原文以便回溯。

## 已移植的脚本

| 源文件 | 目标模块 | 内容 |
|---|---|---|
| `scripts/lceda_cdp.py` | `src/cdp/wsClient.ts` | 零依赖 RFC6455 客户端：HTTP 升级握手、掩码帧、126/127 扩展长度、ping 回 pong、close、分片拼接 |
| `scripts/lceda_cdp.py` | `src/cdp/discover.ts` | profile 目录扫描、`DevToolsActivePort` 两行解析（端口与 browser uuid）、`/json/version` 探测、`looksLikeCdp`、`discover`（uuid 匹配优先）、回环地址校验 |
| `scripts/lceda_cdp.py` | `src/cdp/session.ts` | CDP 会话：按 id 匹配响应、error 抛错、`EASYEDA_CDP_TIMEOUT` 超时（默认 20 秒）、close |
| `scripts/lceda_cdp.py` | `src/cdp/pickPage.ts` | 选页守卫：只取 page 类型、match 子串过滤、文档类型前置过滤、命中数不等于 1 抛 `PageSelectionError`、显式 index 越界报错 |
| `scripts/lceda_cdp.py` | `src/cdp/uiShell.ts` | 顶层 UI 判据（4 个挂载点命中至少 2 个）、只读探测、失败抛 `UiShellError` |
| `scripts/lceda_cdp.py` | `src/cdp/redact.ts` | 敏感参数、邮箱、手机号脱敏 |
| `scripts/lceda_cdp.py` | `src/cdp/sideEffects.ts` | 副作用正则黑名单，原样搬运 |
| `scripts/lceda_cdp.py` | `src/cdp/targets.ts` | `/json/list`、`Page.getFrameTree`、frame 树压平与输出 |
| `scripts/lceda_cdp.py` | `src/cdp/screenshot.ts` | `Page.captureScreenshot`、fit 缩放到板框、临时隐藏层并复原 |
| `scripts/lceda_cdp.py` | `src/cdp/cli.ts`、`src/cdp/mcpTools.ts` | discover/targets/frames/eval/shot/docs 的 CLI 与 MCP 工具包装 |
| `scripts/_board.py` | `src/cdp/board.ts` | `Board.api()`（`(async()=>{var A=globalThis._EXTAPI_ROOT_;<body>})()`）、`apiJson`、`ensurePcb`、`nets`、可写性守卫（`detectState`/`judgeState`/`normalizeState`/`ensureWritable`）、模态框句柄整理 |
| `scripts/_board.py` | `src/cdp/modalProbe.ts` | `_MODAL_PROBE_JS`、`DETECT_JS`、`CLICK_MODAL_BUTTON_JS` 与字段契约常量，作为唯一真源 |
| `scripts/open_doc.py` | `src/cdp/docs.ts` | 文档 list/active/open，open 后 activate、等就绪、回读 `active_after` 并按 uuid 校验 |
| `scripts/eval_cdp.py` | `src/cdp/eval.ts` | `api` 与 `ui` 两种求值上下文（A 注入与文档类型过滤的差异），ui 前先做顶层 UI 判据 |
| `scripts/check_environment.py` | `src/cdp/discover.ts` | profile 目录与端点探测部分。Python 解释器检查、版本指纹（Electron/Chromium/pro-api 三元组）与 `render_launcher` 依赖没有移植 |
| `tests/test_pick_page_guard.py` | `tests/cdp-client.test.ts` | 选页守卫的阳性/阴性用例。源测试对 10 个 CLI 入口做 spy 断言，TS 侧只有 `pickPage` 一层调用，改为直接覆盖守卫分支 |

`lceda_cdp.py` 的 `frames`/`eval`/`shot` 会话管理、`mcpTools.ts` 的 8 个工具是新增的 TS 包装，源仓库没有 MCP 形态。

## 未移植的脚本

| 源文件 | 原因 |
|---|---|
| `ctxmenu.py`、`uimap.py`、`ui_probe.js`、`menu_click.py`、`menu_tree.py` | 界面探查与坐标点击依赖真机 DOM 结构和 React 内部属性，属于设计操作层，不在本轮连接层范围 |
| `rule_edit.py`、`netclass_manage.py`、`diffpair_define.py`、`diffpair_route.py`、`aesthetics_check.py`、`board_check.py`、`check_assertions.py`、`teardrop_apply.py`、`pour_rebuild.py`、`rip_nets.py`、`net_skew.py`、`pair_anchors.py`、`designator_attr.py` | 设计读写动词，需要 PCB API 契约与真机回归；多数还依赖 `dismiss_modal`、Esc 兜底或坐标标定 |
| `export_dsn.py`、`import_ses.py`、`dsn_pairs.py`、`freerouting_run.py`、`fastroute_run.py`、`export_autolayout.py`、`import_autolayout.py` | 与外部布线器（Freerouting 等）交互的批处理，涉及文件格式与子进程，留给后续 sidecar 或单独任务 |
| `persist_cdp.py`、`render_launcher.py` | 启停脚本生成器，本仓库的 `lceda-connect cdp start/stop` 已覆盖 |
| `state_check.py` | 判定口径已并入 `cdp_ui_state` 与 `ensureWritable`，没有单独的 CLI |
| `undo.py`、`diag_ns.py`、`report_status.py`、`evidence_check.py`、`rpc_trace.py`、`_bootstrap.py` | 诊断、证据采集或 Python 导入引导，依赖具体排查场景，不构成运行时能力 |

`_board.py` 的 `dismiss_modal` 与 `press_escape` 也没有移植：它们的用途是写操作前的挡路弹窗处理，本轮没有写动词，等接入 `rule_edit` 一类的脚本时再补。

## 迁移时保留的行为口径

- 端点发现优先 `uuidMatch === true` 的候选，没有匹配项时才退回活着但未记录 uuid 的端口。
- 选页命中数不等于 1 时抛错停手，不静默取第一个 page。
- `eval` 默认拦截有副作用的表达式，放行需要显式确认。
- 只连 `127.*`、`localhost`、`::1`，拒绝其他主机。
- 对外输出的 URL 与标题先脱敏。
- `openDocument` 之后必须 `activateDocument`，并回读 `active_after.uuid`；不一致就是失败。
- `waitForDocumentReady` 在 V4.1.78 恒为 false，不作为成败判据，结果里带 `note` 说明。
