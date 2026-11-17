# 更新日志

本项目较重要的变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [语义化版本](https://semver.org/lang/zh-CN/) 走。

## [Unreleased]

- 安全加固：待补。
- MCP 协议升级：待补。
- CI：待补。

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
