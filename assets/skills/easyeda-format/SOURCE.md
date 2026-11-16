# 来源（easyeda-format）

`assets/skills/easyeda-format/SKILL.md` 原样复制自 `easyeda-format-skill` 仓库根目录的 `SKILL.md`。

- 源仓库路径：`D:\Projects\GitHub\easyeda-format-skill`
- 上游：`easyeda/easyeda-format-skill`
- 源仓库 HEAD：`4fcab1747d47b2ae01d7f93a485859970c5cf933`
- 许可：MIT（源仓库 `LICENSE`，Copyright (c) 2026 EasyEDA）

## SKILL.md 里依赖源仓库环境的部分

SKILL.md 的流程要求用 `node validate.js` 校验生成物，产物写到 `format/{type}_{timestamp}.txt`。本仓库没有 `validate.js`，对应能力如下：

| SKILL.md 里的做法 | 本仓库 |
| --- | --- |
| `node validate.js PCB_LINE '{"netName":"+5V"}'` | `lceda-connect format validate PCB_LINE '{"netName":"+5V"}'` |
| `node validate.js LINE '{...}' --doc PCB` | `lceda-connect format validate --doc PCB LINE '{...}'` |
| `node validate.js '<外层JSON>\|\|<内层JSON>\|'` | `lceda-connect format validate '<外层JSON>\|\|<内层JSON>\|'` |
| 查 `types-index.md` / `primitives/` / `examples/` | `lceda-connect format types / show / example`，MCP 工具 `format_list_types` / `format_get_primitive` / `format_example` |
| 读 `FORMATLOG.md` | MCP 工具 `format_changelog` |

输出目录与文件名由调用方决定，本仓库不强制写 `format/` 目录。

## 数据与校验

`assets/format/` 收录了 SKILL.md 引用的 schemas、primitives、documents、examples、types-index、FORMATLOG，路径结构与源仓库一致，SKILL.md 里的相对链接仍然有效。

schema 与真机写盘的已知矛盾见 `assets/format/SOURCE.md` 与 `src/format/relaxations.ts`。校验时这些矛盾以 `WARNING` 返回，`valid` 仍为 true。
