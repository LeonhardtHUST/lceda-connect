# easyeda-connect 编排层来源

本目录收录 `leonskill-easyeda-connect` 的知识文档与台账，文件内容原样保留：

- 源仓库：<https://github.com/LeonhardtHUST/leonskill-easyeda-connect>
- 提交：`9b2593061adef44c60c869b94666c19c59b52bd5`（`git -C <源仓库> rev-parse HEAD`）
- 许可证：MIT（源仓库 `LICENSE`，Copyright (c) 2026 LeonhardtHUST）
- 复制时源仓库工作区还有未提交改动，集中在 `scripts/bridge_client.py`、`scripts/command_fixture_admission.py`、`scripts/winpool.py`；这三个文件不在本次复制范围内，下面列出的文档与台账没有改动。

## 收录文件

| 文件 | 说明 |
|---|---|
| `SKILL.md` | 双通道编排技能的入口说明 |
| `references/capability-map.json` | 124 个动词的路由台账（`routes[].priority` / `channel` / `fail` / `degrade`） |
| `references/routing.md`、`references/setup-guide.md` | 选路规则与客户端配置步骤 |
| `references/eda-followup-plan.md`、`references/lceda-api-index.md` | 后续计划与文档索引说明 |
| `references/context-menu.json` | 客户端右键菜单台账 |
| `references/rules/pcb-layout.rules.json` | PCB Layout 规则包 |

未收录：`docs/`（293 MB 文档站镜像）、`research/`、`tests/`、`scripts/`、`references/doc-manifest.json`、`references/doc-sections.json`（两个超过 500 KB 的文档站索引）、`references/lceda-api-index.json`（API 检索已由 `src/apidocs` 提供）。其余 `references/*.json`（harness-contract、state_predicates、ui-command-evidence 等）是源仓库内部的 QA 台账，与运行时无关，本轮不搬。

## Python 到 TypeScript 的映射

| 源文件 | 落点 | 说明 |
|---|---|---|
| `scripts/bridge_client.py` | `src/bridge/client.ts` | 合并连接层时已完成，本层复用 |
| `scripts/check_environment.py` | `src/eda/channels.ts` | 双通道自检四态、checks、reason_code、next_action |
| `scripts/eda_verbs.py` 的 `DOC_TYPES`、`DOC_PROBE`、`JS_COUNT`、`JS_DOC` | `src/eda/payloads.ts`、`verbs.ts` | 文档探测、计数辅助、当前文档 |
| `scripts/eda_verbs.py` 的 `bridge_read_board`、`bridge_run_drc`、`bridge_route_net` | `src/eda/payloads.ts`、`verbs.ts` | 读板、DRC、自动布线载荷 |
| `scripts/eda_verbs.py` 的 `run_routed`、`write_evidence` | `src/eda/exec.ts`、`src/eda/evidence.ts` | 按台账路由、证据包 |
| `scripts/board_reader_v2.py` 的 `BOARD_READ_JS_V2`、`canonical_json`、`cluster_points`、`dedupe_drc_leaves`、`aggregate_drc`、`details_hash`、`designator_set_hash`、`silk_hash`、`snapshot_key`、`normalize_board_state` | `src/eda/boardState.ts` | 读板载荷、DRC 去重、四个指纹与快照归一化 |
| `scripts/board_reader_v2.py` 的 `judge_snapshot` | `src/eda/boardState.ts` 的 `compareBoardDigest` | 只取「跨版本或探针未覆盖则 unjudgeable」的判定，没有逐行移植 |
| `scripts/cdp_tools.py` 的 CDP 能力 | 已由 `src/cdp/` 承担 | 本层通过 `src/cdp/discover`、`session`、`targets` 求值 |
| `references/capability-map.json` | `src/eda/capabilities.ts` | 台账检索与路由读取 |

## 与原实现的差异

- 换路判据：Python 用退出码 2/4/5 判断通道级故障。TS 的通道错误统一带 `code` 与 `exitCode`，`exec.ts` 只对通道级错误换路；前置检查错误（例如当前文档不是 PCB）直接抛出，不再尝试下一条通道。路由严格按台账：`route_net` 只有 bridge 一条路由，所以不会换到 CDP，这一点与源实现一致。
- 窗口选择：保留了 `resolve_window` 的思路，PCB 动词在 bridge 通道先按文档类型挑窗口。窗口池的持久绑定没有移植。
- 读板归一化：保留计数、网络表三态、DRC 去重与双探针、四个指纹、`snapshot_key`、`comparable` 与 `reasons`。`targets` 坐标比对、severity 聚合、12/12 稳定窗采样没有移植。`board_digest` 比较两份读数的 `snapshot_key`，跨 reader 或探针不全时判 `unjudgeable`。
- 证据包：源仓库默认写入 `out/` 并附带 `check_environment` 的版本指纹。TS 只在给出 `--out` 时落盘，指纹记录本次调用实际走到的通道，不再额外探测端口。
- 文档列表：源仓库把列表能力放在连接层。TS 复用 `src/cdp/docs.ts` 的 JS 形状，把 `A` 前缀改成 `eda`，一份载荷同时供 bridge 与 CDP 使用。
- 运行时检查：`check_environment.py` 的 Python 版本与连接层安装检查，换成 Node 版本检查和内置 CDP 模块的状态，`cdp-module` 恒为 ready。
- 频道四态、`checks[]` 字段名、`next_action` 文案沿用源实现；`version_fingerprint` 的 `cdp` 项结构保持一致。

## 未移植清单

| 项目 | 原因 | 后续 |
|---|---|---|
| `placement.py`、`layout_verbs.py`、`incremental_route.py`、`offline_route.py`（约 330 KB Python） | 几何求解器与实测参数很多，需要真板反复验证，本轮时间不够 | 单独立项，按模块移植到 `src/eda/layout`，先搬离线可测的几何内核 |
| 丝印系列 `silk.py`、`silk_calibrate.py`、`silk_layout.py`、`silk_lint.py`、`silk_metrics.py` | 与字体度量、避让几何和写前预检耦合，写丝印动词依赖这些判定 | 先保留读板里的 `silk_hash` / `silk_count`，写丝印随后续布局层一起做 |
| `guideline_rules.py`、`guideline_gate.py` | 规则引擎体量大，需要与规则包和实测基线一起验证 | 规则包已进 `references/rules/`，引擎等布局层稳定后再搬 |
| `winpool.py`、`window_binding.py` | 依赖窗口句柄与进程级绑定，跨平台行为未验证 | 本层用「按文档类型探测窗口」的轻量版本；需要多窗口持久绑定时再补 |
| `command_fixture_*`、`validate_output.py`、`audit_residue.py`、`assert_l4_isolation.py` 等 QA 脚本 | 属于源仓库内部验收与回归，不进运行时 | 不搬；需要时按用例改写成 vitest |
| `project_verbs`、`layer_verbs`、`manufacture_export`、`compare_designs`、`aesthetic_lint` 等动词 | 本轮只做高频读板与布线动词 | 台账里仍可查到（`lookup`），执行时明确返回未实现 |
| `doc-manifest.json`、`doc-sections.json`、`lceda-api-index.json` | 文档站镜像与 API 索引超过 500 KB，且与已有 `assets/api-docs`、`src/apidocs` 重复 | 不搬 |

## 测试与哈希口径

`tests/eda-boardstate.test.ts` 锁住四个指纹与快照主键。期望值来自源仓库 `tests/test_board_reader_v2_designators.py` 的冻结常数，并在 Python 3.13 上按同一份 fixture 复核：

- `details_hash = 18b999a495e91a01`
- `drc_leaf_hash = a7fb6a8d5495f060`
- `snapshot_key = b4ba92f1564aecad`
- `designator_set_hash`（位号 `R1`、`U9`）= `34496e9abf810c7c`

算法统一为 `sha256(salt + canonical_json(...))[:16]`，`canonical_json` 与 Python 的 `json.dumps(sort_keys=True, separators=(",", ":"))` 同形，浮点数保留 `.0` 形式。任何一处口径变化都会让上述常数对不上。

移植完成后用 Node 的类型剥离直接导入 `src/eda/payloads.ts`，再与 Python 导入源模块的结果逐字节比对：`BOARD_READ_JS_V2`（7279 字节）、`DOC_PROBE_JS`（123 字节）、`DOC_PROBE_EXPR`（169 字节）三者一致。`DRC_JS` 在源 `bridge_run_drc` 的类别统计之外补了展平叶子，`autoRouteJs` 只替换网络名，两者与源代码的差异在文件注释里写明。
