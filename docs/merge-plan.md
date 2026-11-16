# 合并方案：9 个 EasyEDA / LCEDA 仓库并入 lceda-connect

> 依据 2026-11-17 五路只读勘察（目标仓库 1 路 + 源仓库 4 组）。本文件是执行清单，也是之后回溯"某段代码从哪来"的索引。

## 总体原则

- 代码主体是 Node + TypeScript（ESM，vite-plus 的 `vp pack / vp test / vp check`）。现有 `cdp`、`bridge` 两个 CLI 的行为和 49 个测试保持不变。
- 新增一个 MCP stdio 服务（`lceda-mcp`，也可用 `lceda-connect mcp` 启动），工具按领域分文件注册，CLI 与 MCP 共用同一套 core 模块。
- 源仓库按形态分三种处置：
  - **TS 移植**：运行时核心逻辑，重写为 TS 并配 vitest 测试。
  - **assets 数据**：SKILL.md、references、schemas、API 参考、模板等知识，原样放进 `assets/`，随 npm 包发布，运行时用 `new URL(..., import.meta.url)` 读取。
  - **sidecar 封装**：体量大、依赖 numpy/scipy 或本身是成熟 JS 工具链、本轮来不及逐行移植的部分，原样收进 `assets/sidecar/<来源>/`，由 TS 层用子进程调用（`node` 或 `python`），对外仍是 TS 实现的 CLI/MCP 接口。sidecar 是过渡形态，后续可逐步替换为 TS。
- 不进仓库：二进制大样例、过程日志、文档站全量镜像（几百 MB）、测试床。

## 逐仓库处置

| #   | 源仓库                             | 形态                                               | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                             | 落点                                                                    |
| --- | ---------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 1   | leonskill-easyeda-connect          | Python 编排层（64 脚本，~40k 行）+ 300 MB 文档存档 | **TS 移植**：bridge 客户端、双通道环境自检、高频动词（读板、DRC、文档列表/打开、自动布线、eval）及其 JS 载荷；**assets**：SKILL.md、capability-map.json、规则包、路由/安装文档；**不合并**：官方文档站镜像（293 MB，LFS 图片）、research/、离线布局布线求解器与内部 QA 脚本（留在原仓库）                                                                                                                                                        | `src/eda/`、`assets/skills/easyeda-connect/`                            |
| 2   | leonskill-easyeda-project-analysis | 纯标准库 Python（~2k 行）                          | **全量 TS 移植**：`.epro2` ZIP 解包（GBK 成员名）、`.epru` 记录归约、库表、原理图连通性（空间网格 + 并查集）、PCB 权威网表与几何、两版语义 diff、六段报告；36 个用例移植为 vitest；references 5 篇 → assets                                                                                                                                                                                                                                      | `src/epro2/`、`assets/skills/project-analysis/`                         |
| 3   | leonskill-easyeda-cdp-connect      | Python 连接层（40 脚本）                           | **TS 移植**：`lceda_cdp.py` 全部（零依赖 RFC6455 WebSocket、DevToolsActivePort + uuid 归属发现、CDP Session、选页守卫、顶层 UI 判据、脱敏、副作用拦截、targets/frames/eval/shot）、`_board` 弹窗探针与 `open_doc`；并补齐现有 `parseDevToolsActivePort` 第 2 行 uuid；**assets**：SKILL.md 与 17 篇 references（含 api-contract.md）；notes/ 实测日志不搬                                                                                        | `src/cdp/`、`assets/skills/cdp-connect/`                                |
| 4   | leonskill-easyeda-ngspice-sim      | Python 仿真（52 脚本 ~12.8k 行）+ 33 篇文档        | **TS 移植**（纯标准库部分）：IR、SPICE 命名、地策略、deck 生成、ngspice raw 解析（ASCII/二进制）、指标、manifest、基础网表生成（R/C/L/V/D/Q/M + 子电路）、叠层/走线/过孔估算、Touchstone 解析、ngspice 探测与执行；**sidecar**：依赖 numpy/scipy/scikit-rf 的 RF/拟合/去嵌入脚本，以及 override/行为级/IBIS 等规则密集脚本；**assets**：模型库 JSON、知识类文档；硬编码的 `C:\Users\Leon\...` 路径一律改为配置 → 环境变量 → 探测；`.sh` 入口淘汰 | `src/sim/`、`assets/sidecar/ngspice-sim/`、`assets/skills/ngspice-sim/` |
| 5   | easyeda-eprj3-skill                | 零依赖 CommonJS（72 脚本 ~20k 行）                 | **TS 移植**：记录层（`{头}                                                                                                                                                                                                                                                                                                                                                                                                                       |                                                                         | {体} | `解析/格式化）、新增按 ticket 归约（原仓库缺失）、工程检视、格式门（修正对真实工程误报的`LINE→WIRE`检查，墓碑感知）、网表导出；**sidecar**：声明式建工程`build.js`与原子编辑脚本、门禁（ERC/lint/DRC/intent）、模板、库条目、recipe（只收`scripts/ templates/ recipe/`，不收 10 MB 示例与 eval 历史）；**docs**：format-reference / build / checks 等 | `src/eprj3/`、`assets/sidecar/eprj3/`、`docs/eprj3/` |
| 6   | cubeone-mcp                        | STM32CubeMX 的 MCP 服务（纯 JS）                   | **与 EDA 无关，不搬业务代码**。借鉴其 MCP 工程模式并用 TS 重写：结构化输出 64 KiB 截断 + `_meta`、错误 → `isError` 映射、写操作默认只读需显式放行、stdio 握手冒烟测试                                                                                                                                                                                                                                                                            | `src/mcp/`                                                              |
| 7   | easyeda-api-skill                  | ws 桥服务 + 3 MB 生成式 API 参考                   | **TS 移植**：`bridge-server.mjs`（49620–49629、`/health` `/eda-windows` `/execute`、`/eda` WebSocket，字段逐一保持），作为内置 bridge 服务，现有 `bridge` 管理命令在找不到外部脚本时改用内置版本；bridge HTTP 客户端；**assets**：`references/`（422 篇）、`format/`、SKILL.md、guide，并在构建期生成检索索引供 `api_search` / `api_get`                                                                                                         | `src/bridge/`、`assets/api-docs/`                                       |
| 8   | easyeda-format-skill               | 297 个 JSON Schema + 292 篇图元文档 + ajv 校验器   | **assets**：schemas、primitives、documents、examples、types-index、FORMATLOG；**TS 移植**：用无依赖的小型校验器替代 ajv（schemas 只用到 type/properties/required/enum/min/max/items/pattern/anyOf），类型名解析表、知识检索                                                                                                                                                                                                                      | `src/format/`、`assets/format/`                                         |
| 9   | easyeda-client-cli                 | 4 篇 Markdown（官方客户端 CLI 说明）               | **文档并入**：作为官方 CLI 的设计参考；其中"运行时发现命令、检查 `ok` 外壳、用完关会话"等规则写进 MCP 工具描述                                                                                                                                                                                                                                                                                                                                   | `docs/vendor/easyeda-client-cli/`                                       |

## MCP 工具（第一批）

| 领域       | 工具                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 连接       | `lceda_status`、`cdp_discover`、`cdp_targets`、`cdp_eval`、`cdp_screenshot`、`bridge_status`、`bridge_windows`、`bridge_execute`                                                                                   |
| 编辑器动词 | `eda_read_board`、`eda_run_drc`、`eda_doc_list`、`eda_doc_open`                                                                                                                                                    |
| API 文档   | `api_search`、`api_get`                                                                                                                                                                                            |
| 格式       | `format_list_types`、`format_get_primitive`、`format_validate_record`                                                                                                                                              |
| 工程文件   | `epro2_inspect`、`epro2_schematic_nets`、`epro2_pcb_netlist`、`epro2_pcb_geometry`、`epro2_crosscheck`、`epro2_report`、`epro2_diff`、`eprj3_inspect`、`eprj3_validate`、`eprj3_netlist`、`eprj3_build`（sidecar） |
| 仿真       | `sim_probe`、`sim_netlist`、`sim_run`、`sim_metrics`、`sim_stackup`                                                                                                                                                |
| 知识       | `skill_docs`（列出/读取 assets 中的技能文档）；另以 MCP resources 暴露 `lceda://` 文档                                                                                                                             |

写操作类工具默认不执行，需要 `confirm: true`。

## 构建与工程化

- 新依赖：`@modelcontextprotocol/sdk`、`zod`、`ws`（运行时，放 `dependencies`，tsdown 自动外部化）；`@commitlint/cli`、`@commitlint/config-conventional`（dev）。
- `vite.config.ts`：新增 pack 入口 `src/cli-mcp.ts`、`src/bridge-server.ts`；`fmt/lint.ignorePatterns` 排除 `assets/**`；`files` 加入 `assets`。
- commitlint：`commitlint.config.mjs` 照搬参考模板（config-conventional + 中文简述规则）；`.vite-hooks/commit-msg` 调用 commitlint，`prepare: vp config` 自动安装钩子，`.gitattributes` 强制钩子脚本 LF。

## 提交顺序（逻辑单元）

1. commitlint 与 commit-msg 钩子（先接好，后续每个提交都过校验）
2. 合并方案文档
3. MCP 服务骨架、assets 打包配置
4. CDP 内核（cdp-connect）
5. 内置 bridge 服务与 API 文档检索（api-skill）
6. 格式知识库与校验器（format-skill）
7. `.epro2` 工程解析（project-analysis）
8. `.eprj3` 记录层与 sidecar（eprj3-skill）
9. ngspice 仿真（ngspice-sim）
10. 编辑器动词层（easyeda-connect）
11. 文档并入（client-cli）、README、第三方声明

## 已知问题与待决

- 许可证：本仓库 `LICENSE` 是 GPL-3.0 全文，`package.json` 与 README 写 MIT；源仓库多为 MIT，easyeda-api-skill 与 easyeda-client-cli 仓库内无 LICENSE 文件。本次不改 LICENSE，在 `THIRD_PARTY_NOTICES.md` 记录来源与许可，由仓库所有者决定最终许可。
- 官方客户端已自带 `lceda-pro --mcp`。本项目的差异点是：接入正在编辑的 GUI 实例（bridge + CDP）、离线工程文件解析与仿真、离线 API/格式检索。
- 写入与提交由主 Agent 统一执行；实现 Worker 只在分配的目录内写文件，不做任何 git 操作。
