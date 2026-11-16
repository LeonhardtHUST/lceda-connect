# 来源说明

- 来源仓库：`D:\Projects\GitHub\easyeda-client-cli`
- 提交：`5452c638fca802ea29e27277479a56d869feb10a`（2026-11-02）
- 许可：仓库 README 声称 Apache-2.0，但仓库内没有 LICENSE 文件；原文由嘉立创EDA 官方发布，这里只作参考资料保留，内容未改动。

## 这几篇文档是什么

它们描述的是嘉立创EDA 专业版客户端**自带**的命令行工具（国内版 `lceda-pro`、国际版 `easyeda-pro`，要求桌面版 4.1.70 及以上），包括会话、`invoke` 执行代码、`doc` 文档查询和 `--mcp stdio|http` 模式。它不是 lceda-connect 要实现的规格。

| 文件 | 内容 |
|---|---|
| `README.md` | 双语索引与能力概览 |
| `easyeda-cli.md` | bridge 服务、会话、调用和统一 JSON 响应外壳等概念；强调在运行时用 `--help` / `--search` 发现命令 |
| `cli-for-ai.md` | 给 Agent 的使用规则：不凭记忆写命令、检查每个响应的 `ok`、落盘后验证产物、用完关闭会话 |
| `easyeda-format.md` | 工程文件格式摘要：`epro2`（zip）、`eprj2`（SQLite）、`eprj3`（文件夹）、`||` 记录与 ticket |

## 对 lceda-connect 的影响

- `cli-for-ai.md` 的几条规则已写进相关 MCP 工具描述（执行代码前先查 API、检查返回值、写操作要确认）。
- 官方 CLI 已经提供 MCP 模式，lceda-connect 的定位是补它没有的部分：接入正在编辑的 GUI 实例（AI Bridge + CDP）、离线解析工程文件、离线检索 API 与格式文档、ngspice 仿真。
- `easyeda-format.md` 的格式摘要与 `assets/format/`（easyeda-format-skill）重复，以后者为准。
