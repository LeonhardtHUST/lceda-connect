# API 文档来源

本目录的 Markdown 来自 easyeda-api-skill，正文原样收录，没有改写。

- 源仓库路径：D:\Projects\GitHub\easyeda-api-skill
- 上游：easyeda/easyeda-api-skill
- 源仓库 HEAD：002a39d6dc55ad138e784c788b5c220b5c191c70（同时写在 .source-sha，供索引生成脚本读取）
- 许可：源仓库里没有 LICENSE 文件；SKILL.md 的 front matter 声明 `license: MIT`

## 收录范围

- `references/`：源仓库同目录全部 422 篇（classes 131、interfaces 176、enums 78、types 35，另有 `_index.md`、`_quick-reference.md`）
- `format/`：源仓库同目录全部 33 篇
- `guide/`：11 篇；`guide/ancillary-projects/` 下的两篇是小于 200 字节、只含 `<!--@include` 的空壳，未收录
- `SKILL.md`：放到 `assets/skills/easyeda-api/SKILL.md`

## 检索索引

`index.json` 由 `node scripts/build-api-index.ts` 从 `references/` 生成，内容包含类名、kind、成员名、签名、摘要与 `eda.xxx` 访问路径。重新生成后与源码一起提交；条目数或格式变了，先更新 `tests/apidocs.test.ts` 里的断言。
