# 更新日志

本项目较重要的变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [语义化版本](https://semver.org/lang/zh-CN/) 走。

## [Unreleased]

### 破坏性变化

- bridge 的 agent 端（`/execute`、`/eda-windows`、`/eda-windows/select` 和 `/eda` 以外的 WebSocket）现在需要 token。本工具的 CLI 和 MCP 客户端自动读取；旧的外部脚本（如直接调 `/execute` 的 Python）要带请求头 `X-Lceda-Bridge-Token`，或在启动 bridge 的环境里设 `LCEDA_BRIDGE_AUTH=off`。已装的编辑器扩展不受影响。

### 新增

- bridge 启动时生成 token，写入 `LCEDA_BRIDGE_RUNTIME` 下的 `token-<端口>.txt`，也可用 `LCEDA_BRIDGE_TOKEN` 指定；`/health` 免 token。
- `LCEDA_BRIDGE_ALLOWED_ORIGINS` 用来放行带 Origin 的 agent 端来源。
- 客户端 token 无效时报 `BRIDGE_UNAUTHORIZED`。
- MCP 对象结果同时返回 `structuredContent`。
- 超过 64 KiB 的 MCP 结果完整落盘到 `~/.lceda-connect/results/`（受 `LCEDA_CONNECT_HOME` 影响，保留最近 50 个），返回 JSON 摘要和 `resource_link`，用 `lceda://results/{id}` 读回。
- `lceda-connect mcp --toolsets` 与 `LCEDA_TOOLSETS` 可按 `core` / `offline` / `live` 或具体领域裁剪工具，`core` 总是保留。
- MCP 支持请求取消（报 `CANCELLED`）；`sim_run`、`eprj3_gates` 等长任务发送进度通知。
- MCP 写路径策略：只允许客户端 roots、`LCEDA_ALLOWED_ROOTS` 和默认根（当前目录、系统临时目录、connect home），越界报 `PATH_NOT_ALLOWED`；`LCEDA_ALLOWED_ROOTS=*` 关闭限制，读路径不受限。
- GitHub Actions：Windows / Linux × Node 22、24 跑 check、test、pack 和包体积门禁；Node 20.11 上运行构建产物；单独一个 job 跑真实 ngspice。

### 变更

- skills 资源改为模板 `lceda://skills/{+path}`。
- 超限的 MCP 结果不再截断，改为落盘加摘要（此前是截断并在 `_meta` 注明大小）。
- `cdp_eval` 改为保守的只读判定：只有形如 `getX` / `isX` / `hasX` / `listX` / `findX` / `queryX` / `searchX` 的命名空间调用和普通 DOM 读取直接执行，其余都要 `confirm: true`；`allowSideEffects` 保留为弃用别名。
- 子进程超时或取消时清理整棵进程树，每路输出上限 8 MiB。
- Python 自动探测跳过 `.bat` / `.cmd` 壳；显式指定批处理解释器时，含 shell 元字符的参数会被拒绝。

### 安全

- bridge 只接受回环 Host（其他返回 421），去掉通配 CORS。
- agent 端带 Origin 的请求默认返回 403；`/eda` 扩展端沿用原来的宽松 Origin 策略。
- 请求体 4 MiB、`code` 1 MiB、WebSocket 载荷 16 MiB、待决请求 64 个的上限，超出分别返回 413 / 503。
- `bridge stop` 只结束经确认属于本工具的进程。

## [0.1.0] - 2026-11-17

首个合并版本。9 个 EasyEDA / LCEDA 源仓库按 [合并方案](docs/merge-plan.md) 的处置表并进本仓库，处置方式是 TS 移植、assets 数据、sidecar 封装三类混用。

### 新增

- MCP stdio 服务（`lceda-mcp`，也可以用 `lceda-connect mcp` 启动），共 51 个工具，分连接、编辑器动词、API 文档、格式、工程文件、仿真、知识文档几组注册。
- CLI 命令组共 9 个：原有的 `cdp`、`bridge`，新增的 `api`、`format`、`epro2`、`eprj3`、`sim`、`eda`，以及 `mcp`。`cdp`、`bridge` 原有的动作和选项没动。
- 内置 AI Bridge 服务：`lceda-bridge` 找不到外部 `bridge-server.mjs` 时改用内置版本，端口和字段与源仓库保持一致。
- `assets/` 随 npm 包发布，包括 API 参考、格式 schema 与图元文档、各技能的 SKILL.md、仿真模型库和 sidecar 脚本，运行时通过 `new URL(..., import.meta.url)` 定位。
- `.epro2` 工程解析：ZIP 解包（GBK 成员名）、记录归约、库表、原理图连通性、PCB 网表与几何、两版 diff、六段报告。
- `.eprj3` 记录层：解析与格式化、按 ticket 归约、工程检视、格式门、网表导出。
- ngspice 仿真：网表与 deck 生成、raw 解析、指标计算、叠层估算。没装 ngspice 时相关用例走跳过分支。
- 格式校验与文档检索：297 个 JSON Schema 配一个无依赖校验器，API 文档在构建期生成检索索引。

### 已知问题

- ngspice-sim 的 override、行为级模型、IBIS 三层暂未移植，走 sidecar 过渡；网表生成遇到没有模型的 IC 会排除掉，strict 模式报 `UNMAPPED_IC`。
- eprj3 的 `eval.js`、`make-board.js` 依赖源仓库的 `test/capture`，没有随 sidecar 收进来，已从白名单排除。
- easyeda-connect 的离线布局布线求解器、丝印系列、规则门禁未移植，原因和后续路线见 `assets/skills/easyeda-connect/SOURCE.md`。
