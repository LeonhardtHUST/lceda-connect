# 更新日志

本项目较重要的变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [语义化版本](https://semver.org/lang/zh-CN/) 走。

## [Unreleased]

### 破坏性变化

- bridge 的 agent 端（`/execute`、`/eda-windows`、`/eda-windows/select` 和 `/eda` 以外的 WebSocket）现在需要 token。本工具的 CLI 和 MCP 客户端自动读取；旧的外部脚本（如直接调 `/execute` 的 Python）要带请求头 `X-Lceda-Bridge-Token`，或在启动 bridge 的环境里设 `LCEDA_BRIDGE_AUTH=off`。已装的编辑器扩展不受影响。

### 新增

- README 新增 Codex、DeepSeek Harness、Claude Code 的 stdio Quick Start；打包检查覆盖本地 tarball 安装与两个 npx 入口。
- 新增 npm 发布工作流和 Trusted Publisher 配置手册；自动发布默认关闭。
- bridge 启动时生成 token，写入 `LCEDA_BRIDGE_RUNTIME` 下的 `token-<端口>.txt`，也可用 `LCEDA_BRIDGE_TOKEN` 指定；`/health` 免 token。
- `LCEDA_BRIDGE_ALLOWED_ORIGINS` 用来放行带 Origin 的 agent 端来源。
- 客户端 token 无效时报 `BRIDGE_UNAUTHORIZED`。
- MCP 对象结果同时返回 `structuredContent`。
- 超过 64 KiB 的 MCP 结果完整落盘到 `~/.lceda-connect/results/`（受 `LCEDA_CONNECT_HOME` 影响，保留最近 50 个），返回 JSON 摘要和 `resource_link`，用 `lceda://results/{id}` 读回。
- `lceda-connect mcp --toolsets` 与 `LCEDA_TOOLSETS` 可按 `core` / `offline` / `live` 或具体领域裁剪工具，`core` 总是保留。
- MCP 支持请求取消（报 `CANCELLED`）；`sim_run`、`eprj3_gates` 等长任务发送进度通知。
- MCP 写路径策略：只允许客户端 roots、`LCEDA_ALLOWED_ROOTS` 和默认根（当前目录、系统临时目录、connect home），越界报 `PATH_NOT_ALLOWED`；`LCEDA_ALLOWED_ROOTS=*` 关闭限制，读路径不受限。
- GitHub Actions：Windows / Linux × Node 22、24 跑 check、test、pack 和包体积门禁；Node 20.11 job 用 Node 24 构建后运行同一份 dist 产物（CLI、MCP 工具清单、MCP stdio 握手、库入口）；单独一个 job 跑真实 ngspice。Node 20.11 上不跑 vite-plus，因为 `vite-plus@1.6` 的 engines 是 `^22.18.0 || ^24.11.0 || >=26.0.0`。

### 变更

- pnpm 版本改由 `package.json` 的 `packageManager`（`pnpm@12.21.0`）声明，`pnpm-lock.yaml` 同步写入包管理器解析结果；CI 不再单独传 pnpm 版本，直接从 `packageManager` 读取。
- `exports["."]` 改为条件导出 `{ "types": "./dist/index.d.mts", "default": "./dist/index.mjs" }`。
- skills 资源改为模板 `lceda://skills/{+path}`。
- 超限的 MCP 结果不再截断，改为落盘加摘要（此前是截断并在 `_meta` 注明大小）。
- `cdp_eval` 改为保守的只读判定：只有形如 `getX` / `isX` / `hasX` / `listX` / `findX` / `queryX` / `searchX` 的命名空间调用和普通 DOM 读取直接执行，其余都要 `confirm: true`；`allowSideEffects` 保留为弃用别名。
- 子进程超时或取消时清理整棵进程树，每路输出上限 8 MiB。
- Python 自动探测跳过 `.bat` / `.cmd` 壳；显式指定批处理解释器时，含 shell 元字符的参数会被拒绝。
- 默认 npm 包的分发范围：不包含 `assets/api-docs/`（含检索索引）和 `assets/skills/easyeda-api/` 原文，这两处只保留在源码仓库与私有历史中；官方 CLI 文档副本（`docs/vendor/`）本来就不随包发布。只装包时离线 API 文档检索需要 `LCEDA_CONNECT_ASSETS` 指向自备资产，格式校验不受影响。
- 更新第三方致谢与许可说明：easyeda-api-skill 快照 `002a39d` 没有独立 LICENSE，只有 `SKILL.md` 的 front matter 声明 MIT，不推广到全仓素材与脚本；内置 Bridge 服务的移植实现许可范围仍待核对。
- 候选包尚未发布到 npm；版本号与发布 workflow 就绪不代表已经发布，实际状态以 registry 记录为准。

### 安全

- bridge 只接受回环 Host（其他返回 421），去掉通配 CORS。
- agent 端带 Origin 的请求默认返回 403；`/eda` 拒绝 null Origin，防止沙箱 iframe/data 页面冒充编辑器连接。旧连接关闭时不会删除已重连的新窗口映射。
- 请求体 4 MiB、`code` 1 MiB、WebSocket 载荷 16 MiB、待决请求 64 个的上限，超出分别返回 413 / 503。
- `bridge stop` 只结束经确认属于本工具的进程。

- 构建关闭自动重写 exports，`vp pack` 保留项目声明的 types/default 条件导出。
- 超限结果按完整原文归档，POSIX 新目录/文件以 0700/0600 创建；文档明确说明未自动脱敏，写路径策略不隔离不可信的脚本与仿真输入。

## [0.1.0] - 2026-11-17

首个合并版本。9 个 EasyEDA / LCEDA 源仓库按 [合并方案](docs/merge-plan.md) 的处置表并进本仓库，处置方式是 TS 移植、assets 数据、sidecar 封装三类混用。

### 新增

- MCP stdio 服务（`lceda-mcp`，也可以用 `lceda-connect mcp` 启动），共 51 个工具，分连接、编辑器动词、API 文档、格式、工程文件、仿真、知识文档几组注册。
- CLI 命令组共 9 个：原有的 `cdp`、`bridge`，新增的 `api`、`format`、`epro2`、`eprj3`、`sim`、`eda`，以及 `mcp`。`cdp`、`bridge` 原有的动作和选项没动。
- 内置 AI Bridge 服务：`lceda-bridge` 找不到外部 `bridge-server.mjs` 时改用内置版本，端口和字段与源仓库保持一致。
- `assets/` 随 npm 包发布，包括格式 schema 与图元文档、各技能的 SKILL.md、仿真模型库和 sidecar 脚本；API 参考与 easyeda-api 技能原文只留在源码仓库和私有历史，不随包发布。运行时通过 `new URL(..., import.meta.url)` 定位。
- `.epro2` 工程解析：ZIP 解包（GBK 成员名）、记录归约、库表、原理图连通性、PCB 网表与几何、两版 diff、六段报告。
- `.eprj3` 记录层：解析与格式化、按 ticket 归约、工程检视、格式门、网表导出。
- ngspice 仿真：网表与 deck 生成、raw 解析、指标计算、叠层估算。没装 ngspice 时相关用例走跳过分支。
- 格式校验与文档检索：297 个 JSON Schema 配一个无依赖校验器，API 文档在构建期生成检索索引。

### 已知问题

- ngspice-sim 的 override、行为级模型、IBIS 三层暂未移植，走 sidecar 过渡；网表生成遇到没有模型的 IC 会排除掉，strict 模式报 `UNMAPPED_IC`。
- eprj3 的 `eval.js`、`make-board.js` 依赖源仓库的 `test/capture`，没有随 sidecar 收进来，已从白名单排除。
- easyeda-connect 的离线布局布线求解器、丝印系列、规则门禁未移植，原因和后续路线见 `assets/skills/easyeda-connect/SOURCE.md`。
