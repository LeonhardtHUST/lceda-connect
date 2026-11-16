# assets

随 npm 包发布的数据文件，运行时通过 `src/core/assets.ts` 读取（不经过打包器）。

| 目录 | 内容 | 来源仓库 |
|---|---|---|
| `skills/<名称>/` | 各源仓库的 SKILL.md、references 等知识文档，也作为 MCP resources（`lceda://skills/...`）暴露 | 见各目录内的 SOURCE.md |
| `api-docs/` | EasyEDA Pro 扩展 API 参考与检索索引 | easyeda-api-skill |
| `format/` | 格式 JSON Schema、图元文档与示例 | easyeda-format-skill |
| `sidecar/<名称>/` | 尚未移植为 TS、由子进程调用的原始脚本 | 见各目录内的 SOURCE.md |

这里的文件不参与 `vp check` 的格式化与 lint（见 `vite.config.ts` 的 ignorePatterns），请保持与上游一致，便于回溯比对。
