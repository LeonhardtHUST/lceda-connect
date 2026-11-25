# 扩展安装与卸载（实验性）

本文记录嘉立创 EDA Pro 扩展的安装、权限核对与卸载流程，以及 `lceda-connect` 新增的实验性命令边界。适用环境为 Windows 上的嘉立创 EDA Pro 中文版 4.1.105，只应在独立操作系统用户或虚拟机、打开临时 PCB 副本的客户端实例中操作。日常使用的用户配置文件和原板不在本文覆盖范围内。

## 结论

- 2026-11-19 在 PCBWorld-LCEDA 的 M0 勘察中，已用可见界面走通本地扩展的导入、身份读取、外部交互权限关闭与开启、撤权、按完整身份卸载和清理回读。当时使用的是 `eprj3-example` 临时副本，不是日常工程。
- `lceda-connect` 新增了本地 `.eext` 包预检，以及面向上述中文版扩展管理器的固定 UI 驱动命令。包预检、CDP 界面驱动和 CLI 已实现；新命令尚未在隔离真机完成全链路验收。
- 扩展安装/卸载没有官方无头入口。官方文档只描述扩展管理器界面；官方命令行客户端没有扩展生命周期命令；扩展 API 没有安装、启用、禁用或卸载接口。包预检不需要 EDA；安装和卸载收到 `--headless` 一律拒绝。
- 历史 M0 证据只证明当时的手工/探针流程在该版本上可行，不能替代仓库代码改动后的验收。安装和卸载都是写操作，每次执行前需要另行取得操作者授权。

## 1. 历史验证：PCBWorld-LCEDA M0

### 1.1 环境与测试包

| 项         | 值                                                                 |
| ---------- | ------------------------------------------------------------------ |
| 客户端     | 嘉立创 EDA Pro 4.1.105，中文界面，Windows                          |
| 测试窗口   | 已打开的 `eprj3-example` 临时副本，标题以 `eprj3-example` 开头     |
| 扩展名称   | `PCBWorld M0 Temporary Probe`                                      |
| 扩展机器名 | `pcbworld-m0-temp-probe`                                           |
| 扩展版本   | `0.0.1`                                                            |
| 扩展 UUID  | `6a6bb481d7654e9da3e98b8882c1c109`                                 |
| 包 SHA-256 | `23ede788afc9a7dc95a42cf89f700efee87bca63ee1bc612f39fd1e553f527bc` |

测试包只含 `extension.json`、入口脚本和图标三个成员。入口脚本读取工程、文档类型和 PCB UUID，并通过本机回显演示权限控制，不写板。

### 1.2 已走通的界面流程

1. 通过 CDP 连接受控的副本窗口，先核对页面目标 ID、窗口标题、工程 UUID 和 PCB UUID，只附着到该副本，不进入用户日常会话。
2. 打开「高级 → 扩展管理器(E)...」，确认管理器内只有一个接受 `.eext` 的文件输入控件，再用 `DOM.setFileInputFiles` 把测试包交给该控件。选择文件由脚本完成，导入动作由扩展管理器执行。
3. 在「已安装」列表找到该扩展，核对显示名称、版本和完整 UUID，再从 PCB 菜单触发入口函数。入口函数再次核对工程 UUID、文档类型和 PCB UUID，匹配后回显身份。代码由已安装扩展自身执行，没有使用 CLI 内置的 `eda` 身份代跑。
4. 在该扩展的「配置」页确认「允许外部交互」默认关闭。此时 `sys_WebSocket.register` 被宿主拒绝，回显服务没有收到有效请求。
5. 只打开该扩展的「允许外部交互」，`127.0.0.1` 上的临时服务收到一次带测试标识的 `ping` 并回复；扩展回读 `pong`。没有开启全局权限，也没有传输工程数据。
6. 测试结束后把开关恢复为关闭，重新读取控件确认。
7. 在扩展管理器里核对该扩展的名称、完整 UUID 和权限已关闭，点击「卸载」；在二次确认对话框中核对名称、版本、UUID 且只有这一条记录，勾选「我已知悉，继续操作」并点击「确认」。
8. 回读确认「已安装」列表不再显示该条目，回显端口已关闭，样板源文件哈希未变，可见副本与源逐字节一致，用户 RC50 会话仍在。

### 1.3 证据与边界

原始证据来自 `PCBWorld-LCEDA` 工作区，会话 `02ffe83a-0460-446d-9ff2-72f8be0d7014`。以下路径相对那个工作区，未复制测试包、日志或测试标识到本仓库：

- `docs/LCEDA_EXTERNAL_ROUTING_SURVEY.md` 第 14 节，第 311 行到第 327 行。
- `var/lceda-survey-m0/20261119-m0-round3/extension-verdict.json`，汇总安装、权限、卸载和清理结果。
- `var/lceda-survey-m0/20261119-m0-round3/extension-build.json`，测试包身份与 SHA-256。
- `var/lceda-survey-m0/20261119-m0-round3/permission-denied.json` 与 `permission-allowed.json`，权限关闭时的拒绝和开启后的回执。
- `var/lceda-survey-m0/20261119-m0-round3/permission-revoked.json`，权限恢复为关闭。
- `var/lceda-survey-m0/20261119-m0-round3/uninstalled.json`，卸载后的列表回读。
- `var/lceda-survey-m0/20261119-m0-round3/ui.cjs`，固定的 CDP 界面脚本，只操作指定副本。
- `var/lceda-survey-m0/20261119-m0-round3/permission_probe.py`，权限探针，导入与回显的编排。

这次验证没有覆盖：撤权后已有连接或重新连接的行为；卸载后客户端缓存和扩展存储是否清空；扩展自身身份下的写板；无头或自定义 UUID 的 CLI 调用契约；独立扩展窗口；生产级 Agent 通信。

## 2. 仓库端实验性能力

命令组为 `lceda-connect extension`。包预检不连接 EDA，安装与卸载通过固定的扩展管理器 UI 驱动；UI 驱动使用固定表达式和固定选择器，不接受操作者提供的任意 JavaScript。没有 MCP 写工具，也不提供修改扩展权限的命令。预检与安装/卸载的预览、执行结果默认输出 JSON（也接受显式 `--json`）；失败时错误信息写 stderr 纯文本。

### 2.1 本地包预检

```text
lceda-connect extension inspect --file <path\to\package.eext>
```

该命令只读本地文件，不连接 EDA，也不需要 CDP。返回字段：

```json
{
  "path": "D:\\tmp\\probe.eext",
  "sha256": "…",
  "uuid": "6a6bb481d7654e9da3e98b8882c1c109",
  "name": "pcbworld-m0-temp-probe",
  "displayName": "PCBWorld M0 Temporary Probe",
  "version": "0.0.1"
}
```

预检会拒绝以下输入：非本地路径、UNC 路径、设备路径、最终文件是符号链接或特殊文件、超过大小上限的包、根目录缺失或重复 `extension.json`、根清单不在根目录或大小写不规范（如 `Extension.json`）、CRC 或 UTF-8 解码失败、成员路径含绝对路径、`..`、反斜杠、控制字符、Windows 保留设备名、大小写重复或文件/目录前缀冲突、未设置 UTF-8 标志或字节不合法的非 ASCII 成员名。整个包默认上限 64 MiB，清单默认上限 1 MiB。除根清单外不读取任何成员内容，不解压、不执行、不写盘。

清单字段的实际约束：`name` 为 5–30 个字符，只能用小写字母、数字、下划线和连字符；`uuid` 为 32 位十六进制（也接受标准 `8-4-4-4-12` 形式），规范化为小写；`version` 为 SemVer（`major.minor.patch`，可带 prerelease/build），最多 64 个字符；`displayName` 最多 80 个字符、首尾无空白、单行，缺失时回退为 `name`。安装和卸载的身份核对使用回退后的值。

### 2.2 安装

```text
lceda-connect extension install --file <path\to\package.eext> --sha256 <sha256-hex> --target <CDP target ID> --project <project-uuid> --pcb <pcb-uuid> --port <CDP port> --isolated-profile --confirm
```

行为约定：

- 省略 `--confirm` 时只做本地预览：校验包身份和已给出的 SHA-256；若提供窗口参数则要求四项齐全并检查格式，输出包身份及所填窗口参数，不连接 CDP。
- `--sha256` 必须与预检得到的实际字节哈希一致，否则在连接 CDP 之前失败。执行时重新对输入字节计算 SHA-256，只提交摘要一致的临时副本。临时目录不是 Windows ACL 隔离，不防同一系统用户下的恶意进程；只用来源可信的包和隔离环境。
- `--target`、`--port`、`--project`、`--pcb` 用于绑定唯一的编辑器页面。每个界面阶段核对页面 URL、标题与可见性；4.1.105 项目页 URL 带 `tab=*<PCB>@<工程>`，星号是 EDA 的字面量语法，href 仍按精确字符串比较。另在把文件交给输入控件前、以及打开卸载对话框前与确认卸载前，各调用一次编辑器只读 API，核对当前工程、当前文档确为 PCB、PCB UUID 和父工程 UUID；这几次复核之后不再重复调用。
- 扩展管理器中的「已安装」列表必须为空。列表非空时命令拒绝执行，不覆盖任何已有扩展，也不尝试按名称替换。
- 文件输入控件必须位于扩展管理器的固定作用域内，且是唯一接受 `.eext` 的控件。4.1.105 的「导入」是带隐藏 `input` 的按钮，`input` 可能带 `multiple`；命令通过 `DOM.setFileInputFiles` 只设置一个文件，仍拒绝禁用或非唯一控件。导入仍由扩展管理器完成。
- 导入后若弹出「安全提示」，命令只点击其中唯一的可见「确认」；随后切换「扩展广场 / 已安装」页签强制刷新列表，再回读扩展详情，核对目标显示名称、版本和完整 UUID；有机器名标签时一并核对；不一致就报告失败，不继续后续操作。
- 写入命令要求 `--isolated-profile`。它只是操作者声明，表示当前客户端实例位于可弃用的独立用户或虚拟机中，不创建、不验证隔离。
- 写入命令拒绝 `--headless`。带该参数时在连接 CDP 前退出。

### 2.3 卸载

```text
lceda-connect extension uninstall --uuid <uuid> --name <manifest name> --display-name <displayName> --extension-version <version> --target <CDP target ID> --project <project-uuid> --pcb <pcb-uuid> --port <CDP port> --isolated-profile --confirm
```

`--version` 是全局 CLI 的版本参数，扩展版本使用 `--extension-version`，避免与全局参数冲突。

行为约定：

- 省略 `--confirm` 时只打印扩展身份和已提供的窗口参数，不连接 CDP。
- 四个身份参数 `--uuid`、`--name`、`--display-name`、`--extension-version` 都必须提供。完整 UUID、显示名称和版本必须匹配；若面板提供机器名标签也必须相符。无法唯一定位或复核目标时停止。
- 卸载前在该扩展的「配置」作用域内读取「允许外部交互」状态，必须为关闭。4.1.105 的开关是隐藏 `input` 外包可见 `label`；命令只读状态、不切换。开关为开启时拒绝执行，并提示操作者先在界面中处理。
- 卸载对话框中的名称、版本、UUID 需要再次核对，且只允许一条记录；只点击与该记录对应的「确认」按钮，不按位置猜按钮。
- 卸载后回读「已安装」列表，确认该条目消失；回读结果与预期不符时报告失败。
- `--headless` 的处理与安装相同，在任何写入前拒绝。

### 2.4 禁止事项

这些命令不做以下事情：

- 不自动授予或撤销扩展的「允许外部交互」权限。
- 不直接修改扩展安装目录、权限数据库或客户端存储。
- 不启动、重启或终止嘉立创 EDA 客户端；目标实例必须已经打开。
- 不提供 MCP 写工具，安装和卸载只在 CLI 中执行。
- 不在 `--headless` 模式下执行写入。
- 不猜测 CDP 目标，不在目标身份不匹配时继续。

安装和卸载都是写操作。每次执行前需要操作者单独授权；`--confirm` 只表示预览后同意执行，不代替授权。

### 2.5 当前状态

包预检的实现在 `src/extensions/package.ts`，回归在 `tests/extension-package.test.ts`。界面表达式的模拟回归、CLI 预览与拒绝路径，以及安装/卸载编排的写路径测试（`tests/extension-lifecycle.test.ts`）与历史真机结果是独立证据。2026-11-25 在 4.1.105 上做了**弱隔离演练**（非 §4.1 合格验收，见 `docs/reports/2026-11-24-extension-acceptance.md`）：安装、回读、权限关闭/开启、卸载已走通；§4.5 的 N1/N2/N3/N6/N7/N8 已实测拒绝；§4.1 隔离仍未完成（N4/N5 已实测拒绝，§4.3 无头只读探测已执行）。须在独立环境按第 4 节复验新命令，再考虑扩大使用范围。

## 3. 无头边界

官方资料没有提供无头安装或卸载扩展的入口：

- 用户指南《如何安装》的步骤是下载 `.eext`，在编辑器顶部菜单进入「设置 → 扩展 → 扩展管理器」，点击「导入扩展」；启用、禁用和外部交互权限都在管理器内设置。见 <https://prodocs.lceda.cn/cn/api/guide/how-to-install.html>。
- 《扩展的获取和使用》描述 V3 的「高级 → 扩展管理器」和 V2 的「设置 → 扩展 → 扩展管理器」，联网搜索安装或导入本地文件，已安装列表用于设置启用状态和权限。见 <https://prodocs.lceda.cn/cn/api/user-guide/using-extension.html>。
- 官方命令行客户端的命令包括 `activate`、`open`、`stop`、`doctor`、`session`、`invoke`、`functions` 和 `doc`，全局参数含 `--mcp`。`functions` 只列出会话可见的扩展，`invoke --fn` 只调用扩展注册的函数，没有安装、启用、禁用或卸载命令。见 <https://prodocs.lceda.cn/cn/api/guide/cli.html>。
- 扩展 API 的公开参考中没有安装、卸载、启用或禁用扩展的函数。`SYS_Storage` 中与扩展相关的是扩展用户配置的读写和清理，`ISYS_Extension*` 是外部 API 注册表。
- 本机安装版 `app.js` 的小范围静态读取看到 `serve-hidden` 分支会直接以无窗口方式启动。这是客户端内部实现路径，没有公开命令把扩展安装或卸载接到该分支；`functions` 和 `invoke` 分别只做列出和运行。REA（reverse-engineer-anything）的完整结构分析因超时未完成，不能据此确认或排除其他内部路径。
- easyeda 组织下的 `easyeda/extension-dev-mcp-tools` 提供 `import_plugin` 和 `dev_plugin`，实现方式是 Playwright 打开 `https://pro.lceda.cn/editor?cll=debug`，点击「高级 → 扩展管理器 → 导入」，再用 filechooser 选择文件；需要浏览器、扫码登录和独立浏览器配置，只有导入，没有卸载。见 <https://github.com/easyeda/extension-dev-mcp-tools>。
- 企业私有部署的扩展管理在网页管理端完成导入、导出、删除和版本上下架，属于管理员分发，不是本机无头入口。见 <https://prodocs.easyeda.com/cn/private/managers/extension.html>。
- `safetyMode=true` 和 `DANGEROUS_OPERATION_DeleteExtensionStorage=true` 是异常时的全局禁用和全量删除手段，不能当作安装或卸载入口。见 `assets/api-docs/guide/error-handling.md`。

包预检本身完全离线，不接受也不需要 `--headless`；已有隐藏工程会话与扩展管理不同。安装和卸载一律要求可见窗口和 `--confirm`。客户端内部的 no-window 分支不作为本项目的扩展管理通道。

## 4. 隔离真机复验

### 4.1 环境前提

- 使用独立的 Windows 操作系统用户或虚拟机，不复用日常桌面和客户端配置。`--isolated-profile` 只记录操作者声明，不提供技术隔离。
- 在隔离环境中安装嘉立创 EDA Pro 中文版 4.1.105，保持「已安装」扩展列表为空。
- 打开临时 PCB 副本，不使用用户原板。工程 UUID 和 PCB UUID 要单独记录，并与命令参数一致。
- 测试扩展使用独立 UUID、机器名和版本，回显服务使用独立端口。不要复用用户已安装扩展的身份。
- 不要在隔离环境登录用户的生产账号，不导入用户工程，不读取凭据。需要登录时由操作者使用测试账号完成，流程只做界面操作。
- 每次写入前取得单独授权。`--confirm` 表示操作者在预览后同意执行，不代替授权。

### 4.2 可见工作流复验

这一轮需要可见窗口，并需要操作者授权。

1. 在隔离环境中打开临时 PCB 副本，确认窗口标题、工程 UUID 和 PCB UUID，记录 CDP 目标 ID 和端口。
2. 运行 `extension inspect`，记录包路径、SHA-256、UUID、机器名、显示名称和版本。
3. 先用不带 `--confirm` 的 `install` 预览，核对输出中的目标、工程、PCB 与包身份，确认没有连接 CDP。
4. 由操作者授权后执行带 `--confirm` 和 `--isolated-profile` 的安装。确认「已安装」列表只新增一条，显示名称、UUID 和版本与预检一致。
5. 从 PCB 菜单触发一次只读身份读取，确认执行者是已安装扩展，工程和 PCB UUID 匹配。
6. 保持「允许外部交互」关闭，触发一次需要该权限的操作，确认被拒绝。
7. 由操作者手动打开该扩展的「允许外部交互」，重复一次，确认成功；随后由操作者恢复为关闭。命令本身不切换这个开关。
8. 运行带 `--confirm` 的 `uninstall`，核对对话框中的名称、版本、UUID 和记录条数。卸载后回读「已安装」列表，确认条目消失。
9. 关闭隔离环境前，核对临时副本源文件哈希；若测试扩展带本机回显，核对回显端口。同一台机器上还有用户会话时，确认它未被触碰。

### 4.3 隐藏环境的只读探测

这一轮不弹可见窗口，操作者也不盯界面，只做只读检查，不执行写入。

1. 用 `extension inspect --file` 检查包，不连接 EDA。这一步可以在任意无客户端的终端执行。
2. 在隔离环境用官方 `open --headless true` 建会话后，核对会话与当前文档是否可读。若该实例本身开放本机 CDP，可再用 `lceda-connect cdp targets --port <CDP port> --json` 观察是否存在编辑器页面；不要预设隐藏会话一定有顶层 UI 或已安装列表。
3. 记录哪些身份能回读、是否存在可见扩展管理器；`functions` 返回的会话可见扩展不是完整安装清单。
4. 一旦需要安装、卸载、切换权限或修改任何文件，停止本轮，转入第 4.2 节的授权流程。`--headless` 下的写命令会被拒绝。

### 4.4 需要留存的证据

- 包路径和 SHA-256，预检返回的完整身份。
- CDP 目标 ID、端口、窗口标题、工程 UUID、PCB UUID。
- 安装前后的「已安装」列表。
- 权限关闭时的拒绝结果和开启后的成功结果，以及操作者恢复关闭的状态。
- 卸载对话框中的身份核对结果和卸载后的列表回读。
- 临时副本源文件哈希；若测试扩展带本机回显，还包括回显端口状态；同机用户会话和客户端进程状态。

### 4.5 负例

全链路验收至少覆盖以下拒绝路径：

- SHA-256 与包实际字节不一致。
- CDP 目标 ID、端口、窗口标题、工程 UUID 或 PCB UUID 不匹配。
- 「已安装」列表非空。
- 管理器内没有唯一的 `.eext` 文件控件，或控件不在管理器作用域内。
- 安装后回读的名称、UUID 或版本与预检不一致。
- 卸载参数与界面记录不完全一致，或匹配到多条记录。
- 卸载前「允许外部交互」仍为开启。
- 在 `--headless` 下执行安装或卸载。

### 4.6 与历史证据的关系

历史 M0 验证的是 4.1.105 中文版界面上的一次手工/探针流程：导入、身份读取、权限关闭与开启、撤权、卸载。它证明这条界面路径在该版本可用，但没有验证 `lceda-connect` 新增的包预检、目标绑定、SHA-256 校验、空列表约束、无头拒绝和回读逻辑。

仓库代码改动后的全链路验收必须在隔离环境重新执行第 4.2 节和第 4.3 节，并补齐第 4.5 节的负例。历史证据不能替代这次验收，本文也不把历史结果当作新代码的通过证明。验收通过前，安装和卸载只作为实验性能力，不用于生产环境或用户原板。
