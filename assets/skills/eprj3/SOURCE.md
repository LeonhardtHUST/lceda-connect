# eprj3（easyeda-eprj3-skill）来源与处置

## 来源

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/easyeda/easyeda-eprj3-skill |
| 版本 | 2.2.7（`package.json`） |
| 提交 | `8ff62c549c81e1d373f4cb274871ad1ff42b61e4`（2026-11-09，`fix: 2.2.7 auto board size actually lands on 1.25x the bbox area`） |
| 许可 | MIT，见 `assets/sidecar/eprj3/LICENSE` |
| 本地只读副本 | `D:\Projects\GitHub\easyeda-eprj3-skill` |

## 收进来的内容

- `assets/skills/eprj3/SKILL.md`：源仓库 `SKILL.md` 原样复制。
- `docs/eprj3/`：源仓库 `docs/` 下的 `format-reference.md`、`build.md`、`checks.md`、`cli.md`、`intake.md`、`footprint-evidence.md`、`workflow.md`，内容不改，只做格式化。
- `assets/sidecar/eprj3/`：源仓库 `scripts/`（含 `lib/`、`tools/`）、`templates/`、`recipe/`、`package.json`、`LICENSE`，原样复制。
- `tests/fixtures/eprj3/blink/`：源仓库 `examples/blink`，作为回归夹具。`examples/esp32-s31`（约 10 MB）不进仓库，相关用例在源目录存在时才跑。

没有复制：`examples/` 其余目录、`test/`、`eval/`、`CHANGELOG.md`、`.github/`。

## 逐模块处置

| 源文件 | 处置 | 落点 |
| --- | --- | --- |
| `scripts/lib/eprj3.js` 的记录模型部分（`parseRecord`、`formatRecord`、`isDocHeadLine`、`readLines`、文档分段） | TS 移植 | `src/eprj3/records.ts` |
| 记录归约（源仓库缺失） | TS 新写 | `src/eprj3/records.ts` |
| `scripts/lib/eprj3.js` 其余部分（`DocBuilder`、`Project`、库暂存、写盘、`clientIdFrom` 之外的 id 生成） | sidecar 原样保留 | `assets/sidecar/eprj3/scripts/lib/eprj3.js` |
| `scripts/lib/checks.js`、`scripts/validate.js` 的格式门 | TS 移植并修正误报 | `src/eprj3/validate.ts` |
| `scripts/lib/netlist.js` 与它用到的 `geom.js`、`parts.js` 函数（`pinTip`、`pointSegDist`、`parseSymbolEntry`、并查集） | TS 移植 | `src/eprj3/netlist.ts` |
| `scripts/build.js`、`add-*.js`、`set-refdes.js`、`generate-*.js`、`load-library.js`、`erc.js`、`drc.js`、`lint-layout.js`、`intent.js`、`init.js`、`eda.js`、其余顶层脚本 | sidecar 原样保留，由 `src/eprj3/sidecar.ts` 子进程调用 | `assets/sidecar/eprj3/scripts/` |
| `templates/`（图框、库条目、工程索引样板）、`recipe/`（电路配方） | sidecar 数据 | `assets/sidecar/eprj3/` |
| 工程索引与 inspect | TS 新写 | `src/eprj3/project.ts` |

## sidecar 运行方式

`assets/sidecar/eprj3/package.json` 没有 `type` 字段，Node 按 CommonJS 解析这一层，根仓库的 `"type":"module"` 不影响它。脚本可以单独跑：

```
node assets/sidecar/eprj3/scripts/validate.js --dir <工程目录>
```

`src/eprj3/sidecar.ts` 只放行白名单里的顶层脚本名（不带路径、不带 `.js`），用 `process.execPath` 启动，返回 `{exitCode, stdout, stderr, json?}`。写操作类脚本在 MCP 层需要 `confirm: true`。

## 已知限制

`scripts/eval.js` 与 `scripts/make-board.js` 通过 `require('../test/capture')` 依赖源仓库的 `test/` 目录。`test/` 是测试床，没有复制，所以这两个文件虽然随 `scripts/` 一起收进来了，单独运行会报 `MODULE_NOT_FOUND`。它们不在 sidecar 白名单里，CLI 与 MCP 都调不到。

`package.json` 里的 `test*`、`eval`、`make-board` 脚本仍指向源仓库的 `test/`，在本仓库不适用；实际验证走 `tests/eprj3.test.ts`。

## TS 移植的行为差异

`src/eprj3/validate.ts` 保留源版检查项，另修了四处对真机的误报：

1. 先按 ticket 归约再检查，墓碑（空体删除）记录不参与 Device/Symbol/Footprint/PAD_NET 引用判断。
2. `LINE.lineGroup` 指向已删除的 WIRE 时降为 warning。源版在 `examples/esp32-s31` 上因此报 921 个 error。
3. `ATTR.parentId` 接受 `<元件 id>-<符号引脚元素 id>`，引脚元素 id 允许 16-hex 随机原子，不限于 `eN`。
4. 板框除了单个 `polyType:"BOARD_OUTLINE"` 的 POLY，也接受画在 `layerType:"OUTLINE"` 图层上的 POLY/ARC/LINE。`esp32-s31` 的 PCB2 就是后者。

另外，PCB 的空 NET（id `["NET",""]`）在 builder 与客户端写盘里都是空体，归约时按结构占位保留，不当删除处理。

用源仓库示例只读验证的结果：

| 工程 | 源版 `validate.js` | 本仓库 `validateEprj3Project` |
| --- | --- | --- |
| `examples/blink`（仓库内夹具） | 0 error / 0 warning | 0 error / 0 warning |
| `examples/eprj3-example` | 0 error / 1 warning（缺 `.evar`） | 0 error / 1 warning（同一原因） |
| `examples/esp32-s31` | 1106 error / 1 warning | 1 error / 922 warning |

`esp32-s31` 剩下的 1 个 error 是真实悬挂引用：NET `"EN"` 已被墓碑删除（ticket 771467），PCB 主文档里仍有一条存活 PAD_NET（ticket 621520）指向 `"EN"`。922 个 warning 里 921 个是上面第 2 条的 `LINE→WIRE` 删除残留，1 个是缺 `.evar`。

`validate --strict` 会再对每条存活记录调用 `src/format` 的校验器。格式 schema 与真机写盘有已知出入（例如 ATTR 的 `groupId` 在真机里可以整键缺失），strict 结果只作参考，默认关闭。
