# 来源

本目录收录 `leonskill-easyeda-project-analysis` 的知识文档，文件内容原样保留，未做翻译或改写：

- 源仓库：<https://github.com/LeonhardtHUST/leonskill-easyeda-project-analysis>
- 提交：`aaeba4bca20b8574418eed93fb3e93ecebe678de`（`git -C <源仓库> rev-parse HEAD`）
- 许可证：MIT（见源仓库 `LICENSE`，Copyright (c) 2026 LeonhardtHUST）
- 收录文件：`SKILL.md`、`references/container-and-records.md`、`references/netlist-rebuild.md`、`references/output-contract.md`、`references/pcb-geometry.md`、`references/review-playbook.md`

源仓库的运行时脚本已移植为 TypeScript，放在 `src/epro2/`。源仓库的测试夹具与用例分别移植到 `tests/fixtures/epro2/makeFixture.ts` 和 `tests/epro2.test.ts`。另有 `tests/epro2-integration.test.ts` 覆盖 MCP 工具注册、CLI 子命令与加密 ZIP 报错。

## Python → TypeScript 映射

| 源文件 | 移植落点 | 说明 |
|---|---|---|
| `scripts/epro2.py` | `src/epro2/container.ts`、`zip.ts`、`gbk.ts` | 容器解包、ZIP 中央目录、GBK 成员名 |
| `scripts/epru.py` | `src/epro2/records.ts` | 逐行记录流、ticket 归约、DOCHEAD 分段 |
| `scripts/library.py` | `src/epro2/library.ts` | 符号/器件/封装表、摆放变换 |
| `scripts/schematic.py` | `src/epro2/schematic.ts` | 原理图 IR、空间网格、并查集、网络命名 |
| `scripts/pcbnet.py` | `src/epro2/pcb.ts` | PCB 权威网表与几何、CSV |
| `scripts/epru_diff.py` | `src/epro2/diff.ts` | 元素级与网表级差异、噪声过滤 |
| `scripts/analyze.py` | `src/epro2/analyze.ts`、`report.ts`、`cli.ts` | 统一入口、六段报告、CLI |
| `references/output-contract.md` | `src/epro2/contract.ts` | 产物字段的 TypeScript 类型 |
| `tests/make_fixture.py` | `tests/fixtures/epro2/makeFixture.ts` | 合成工程与最小 stored-ZIP 写入器 |
| `tests/test_pipeline.py` | `tests/epro2.test.ts` | 36 个用例逐项移植 |

## 与原实现的差异

- Node 没有内置 ZIP 读取器，`zip.ts` 自行解析中央目录与本地头，支持 stored 和 deflate；ZIP64、加密包与不支持的压缩方式直接报错。
- 成员名按原始字节解码：设置 UTF-8 标志位时用 UTF-8，否则先试 GBK，再回退 UTF-8。`gbk.ts` 保留 cp437 文本转换函数，便于兼容源实现的测试。
- 新增 `src/epro2/mcpTools.ts` 的 7 个 MCP 工具和 `src/epro2/cli.ts` 的 `analyze` / `diff` / `inspect` 子命令；解析逻辑仍集中在原有模块，CLI 与 MCP 共用。
- 未引入第三方依赖。JSON 产物沿用 `indent=1`，CSV 沿用 UTF-8 BOM，报告结构与源实现逐段对齐。
