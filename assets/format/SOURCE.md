# 来源与移植对照（easyeda-format-skill）

本目录随 npm 包发布，是嘉立创EDA / EasyEDA Pro 文件格式的知识库。内容来自：

- 源仓库路径：`D:\Projects\GitHub\easyeda-format-skill`
- 上游：`easyeda/easyeda-format-skill`
- 源仓库 HEAD：`4fcab1747d47b2ae01d7f93a485859970c5cf933`（同时写在 `.source-sha`，构建脚本读取）
- 许可：MIT（源仓库 `LICENSE`，Copyright (c) 2026 EasyEDA）

## 原样复制的文件

根目录的 `types-index.md`、`FORMATLOG.md`、`CHANGELOG.md`、`README.md` 与下面 4 个目录从源仓库复制，正文没有改动：

- `schemas/` 297 个 JSON Schema。源仓库 `validate.js` 只注册了 198 个；另外 99 个是编辑器内部接口定义，一并保留，校验器不映射。
- `primitives/` 292 篇图元文档，按 15 个文档域分目录。
- `documents/` 15 篇文档域概述。
- `examples/` 303 篇示例，其中 231 行是带 `||` 的真实格式记录。

`SKILL.md` 放到 `assets/skills/easyeda-format/SKILL.md`。

## 校验器的替代方案

源仓库用 `validate.js` 加 ajv（`ajv-formats` 可选）校验。本仓库不引入 ajv：

- `scripts/build-format-registry.ts` 从 `validate.js` 抽出 `OUTER_SCHEMA`、`TYPE_TO_SCHEMA`、`DOC_TYPES`、`DOC_TYPE_MAP`、`TYPE_MAP`，在 `node:vm` 沙箱里求值后写成 `registry.json`：198 个 schema、15 个文档类型、262 条 docType 映射、658 条类型映射。
- `src/format/schemaValidator.ts` 实现 schema 实际用到的关键字：`type`、`properties`、`required`、`enum`、`minimum`、`maximum`、`items`、`pattern`、`anyOf`。`default` 只当标注，不参与校验。
- `src/format/relaxations.ts` 记录 schema 与真机写盘的矛盾。命中规则的问题降级为 `WARNING`，`valid` 仍为 true：
  - `t-pcb-via` 的 `required` 含 `zIndex`，但 3.0 写盘不产出该键（写盘 switch 没有 zIndex 分支）。
  - `groupId` 在 schema 里是 `string`，未分组时真实数据写数字 `0`。
- `resolveSchemaKey` 的口径与 `validate.js` 一致：有 docType 先查 `<docType>_<类型名>`，否则查裸名 / 前缀名 / 别名表，最后退回小写类型名（可以直接传 schema key）。

重新生成 registry：

```
node scripts/build-format-registry.ts
node scripts/build-format-registry.ts --source D:\Projects\GitHub\easyeda-format-skill
```

默认读本仓库同级的 `easyeda-format-skill`，也可以用环境变量 `EASYEDA_FORMAT_SKILL` 指定。生成物与 `.source-sha` 一起提交。

## 与源仓库的差别

- ajv 依赖换成 `src/format/schemaValidator.ts`，错误文案与字段路径写法（点号路径，如 `defaultPad.padType`）跟 ajv 不同，判定口径相同。
- 输出在 `valid / type / schema / errors` 之外多了 `warnings`，用来放放宽表降级的问题。
- `DELETE_DOC` 不在 198 个 schema 里，`src/format/record.ts` 按 `isDelete` 结构单独校验。
- 源仓库 CLI 的两种调用方式（`<type> <json>` 与整行 `{外层}||{内层}|`）保留在 `lceda-connect format validate`。
