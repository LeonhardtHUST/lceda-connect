# 扩展安装/卸载真机验收记录（2026-11-24）

状态：**待执行**。本文件是 [docs/extensions.md](../extensions.md) 第 4 节的执行清单，不是验收结论。
执行前必须满足隔离前提并取得操作者逐次授权；通过后把结果与证据路径补到文末“验收结果”。

## 0. 本轮隔离方式（操作者已确认，2026-11-25）

- 方式：**Leon 账户下的弱隔离**，不是独立 OS 用户或虚拟机。操作者明确选择并接受风险；本节如实记录不满足 docs/extensions.md §4.1 的事实。
- 缓解措施：只打开临时 PCB 副本（`out/acceptance/blink-copy`）；CDP 使用 19463（避开 9222 上的 Chrome 调试实例）。**注意：4.1.105 的渲染进程会把 `--user-data-dir` 改写为 `C:\Users\Leon\AppData\Local\LCEDA-Pro\cache.x64.3`，扩展实际写入日常客户端存储；本轮通过卸载与 IndexedDB 回读确认测试扩展已清除，但隔离性不达标，风险已由操作者明确接受。**
- 限制：安装/卸载仍写入当前 OS 用户的客户端存储，不能证明日常配置完全不受影响。**本轮结果只作为功能演练与证据，不作为 §4.1 合格验收，也不据此宣布生产可用。**

## 1.1 启动受控实例（当前实例没有可用 CDP 时）

当前 EDA 在首页、无打开工程，且启动参数里的 9222 被一个 Chrome 调试实例占用，EDA 实际没有可用 CDP。操作者授权后按下列步骤换成受控实例：

```powershell
# 1) 关闭前确认主窗口只有首页（标题不含工程名）
Get-Process lceda-pro | Where-Object { $_.MainWindowTitle } | Select-Object Id,MainWindowTitle
# 2) 操作者确认没有未保存工程后关闭主进程
Stop-Process -Id <主进程 PID>
# 3) 用独立用户目录与端口启动
New-Item -ItemType Directory -Force "C:\Users\Leon\AppData\Local\LCEDA-Acceptance" | Out-Null
Start-Process "D:\Program Files\lceda-pro\lceda-pro.exe" -ArgumentList '--remote-debugging-port=19463','--user-data-dir=C:\Users\Leon\AppData\Local\LCEDA-Acceptance'
# 4) 确认 DevToolsActivePort 与监听
Get-Content "C:\Users\Leon\AppData\Local\LCEDA-Acceptance\DevToolsActivePort"
Get-NetTCPConnection -LocalPort 19463 -State Listen
```

随后在新窗口打开临时工程副本 `blink-copy\blink.eprj3`（或在欢迎页选择“打开工程”）。不要打开用户原板。

## 1. 前置条件（缺一不可）

| 项       | 要求                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------- |
| 环境     | 独立 Windows 操作系统用户或虚拟机；不复用日常桌面、客户端配置和登录态                                |
| 客户端   | 嘉立创 EDA 专业版 4.1.105，中文界面，已打开一个**临时 PCB 副本**                                     |
| 扩展列表 | 「已安装」列表为空；不覆盖任何已有扩展                                                               |
| 账号     | 不登录生产账号；需要登录时由操作者使用测试账号完成                                                   |
| 授权     | 每一次安装/卸载写操作前单独授权；`--confirm` 只是预览后同意执行，不是授权                            |
| 证据     | 命令输出、界面截图、列表回读统一存到 `out/extension-acceptance/2026-11-24/`（已被 git 忽略，不提交） |

命令约定（在 Windows PowerShell 中执行；WSL 里只能用 Windows 版 node 调用，因为写命令要求 `process.platform === "win32"`）：

```powershell
$Repo = "D:\Projects\GitHub\lceda-connect"
$CLI  = "$Repo\dist\cli.mjs"
$Pkg  = "$Repo\out\acceptance\lceda-acceptance-probe.eext"
```

若 PowerShell 里没有 `node`，改用 `C:\Users\Leon\.vite-plus\bin\node.exe`。

## 2. 准备测试包与回显服务

```powershell
cd $Repo
pnpm build
node scripts\make-acceptance-extension.mjs --out $Pkg
node "$CLI" extension inspect --file $Pkg
```

记录脚本输出的 `uuid`、`name`、`displayName`、`version` 和 `sha256`，写入 `01-inspect.json`。

回显服务（用于验证「允许外部交互」）：

```powershell
node scripts\acceptance-echo-server.mjs 49631
```

测试扩展会在点击「连接回显端口」时连接 `ws://127.0.0.1:49631`，发送 `ping` 并显示回执。

## 3. 记录窗口身份

```powershell
node "$CLI" cdp targets --port 9222 --json
node "$CLI" bridge exec --code "return await eda.dmt_Project.getCurrentProjectInfo()"
node "$CLI" bridge exec --code "return await eda.dmt_SelectControl.getCurrentDocumentInfo()"
```

记录：CDP target ID、端口、窗口标题、工程 UUID、PCB UUID。若 bridge 不可用，改用受控的只读查询；不要修改工程。

核对：窗口标题以临时副本名开头并以 ` | 嘉立创EDA(专业版) - V4.1.105` 结尾；URL 为 `https://client/editor...`，工程/PCB UUID 与查询结果一致。

## 4. §4.2 可见工作流（逐步执行，每步留证）

| 步骤 | 命令 / 操作                                                                                                                                                                                                                   | 期望                                                                                                | 证据                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1    | 打开临时 PCB 副本，记录身份                                                                                                                                                                                                   | 标题/工程/PCB 与记录一致                                                                            | `02-window-identity.json`                       |
| 2    | `extension inspect --file $Pkg`                                                                                                                                                                                               | 返回包身份与 SHA-256，不连 EDA                                                                      | `01-inspect.json`                               |
| 3    | `extension install --file $Pkg --sha256 $Sha --port 9222 --target $Target --project $Project --pcb $Pcb`（不带 `--confirm`）                                                                                                  | `mode: preview`、`connected: false`，不弹界面                                                       | `03-install-preview.json`                       |
| 4    | 由操作者授权后加 `--confirm --isolated-profile` 执行                                                                                                                                                                          | 「已安装」只新增一条；名称/版本/UUID 与预检一致；命令输出 `installed: true`                         | `04-install.json`、截图                         |
| 5    | PCB 菜单 → Acceptance Probe → 读取工程身份                                                                                                                                                                                    | 回显工程/文档/PCB UUID，与记录一致；不写板                                                          | 截图、`05-identity.json`                        |
| 6    | 保持「允许外部交互」关闭，点「连接回显端口」                                                                                                                                                                                  | 回显服务收不到有效请求；界面提示被拒绝                                                              | `06-permission-denied.json`、截图               |
| 7    | 操作者手动打开「允许外部交互」，再点一次                                                                                                                                                                                      | 回显服务收到 `ping`，界面显示 `pong:ping`                                                           | `07-permission-allowed.json`、截图              |
| 8    | 操作者把权限恢复关闭并回读                                                                                                                                                                                                    | 开关为关闭                                                                                          | `08-permission-revoked.json`                    |
| 9    | 由操作者授权后执行 uninstall：`extension uninstall --uuid $Uuid --name $Name --display-name "$DisplayName" --extension-version 0.0.1 --port 9222 --target $Target --project $Project --pcb $Pcb --confirm --isolated-profile` | 对话框名称/版本/UUID 与记录一致、只有一条记录；勾选「我已知悉，继续操作」后确认；列表不再显示该条目 | `09-uninstall.json`、截图、`09-list-after.json` |
| 10   | 收尾                                                                                                                                                                                                                          | 关回显服务；临时副本源文件哈希不变；同机用户会话未被触碰                                            | `10-cleanup.json`                               |

## 5. §4.3 无头只读探测（不写入）

```powershell
node "$CLI" extension inspect --file $Pkg
# 在隔离环境用官方 CLI 建隐藏会话后：
node "$CLI" cdp targets --port <CDP 端口> --json
```

记录：隐藏会话是否可读、是否有可见扩展管理器、`functions` 是否只列出会话可见扩展。任何需要安装/卸载/改权限的操作立即停止，转 §4.2。

## 6. §4.5 负例（逐条留证）

| 编号 | 场景                                 | 操作                                                               | 期望                                                |
| ---- | ------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------- |
| N1   | SHA-256 不一致                       | `install` 加 `--sha256 0…0 --confirm --isolated-profile`           | 连 CDP 前报“包 SHA-256 不匹配，拒绝安装”            |
| N2   | 窗口身份不匹配                       | 改错 `--target`/`--port`/`--project`/`--pcb` 之一                  | 在选窗或 guard 阶段停止，报身份/来源/WebSocket 不符 |
| N3   | 已安装列表非空                       | 先装任一扩展，再装本包                                             | `empty` 阶段拒绝；不覆盖已有扩展                    |
| N4   | 无唯一 `.eext` 控件/不在管理器作用域 | 在管理器搜索框输入过滤条件后执行安装                               | 拒绝确认空列表/拒绝定位控件                         |
| N5   | 安装后回读不一致                     | 构造显示名/版本在界面被改写的包，或注入异常                        | 命令报失败，不继续后续操作                          |
| N6   | 卸载参数不一致/多条记录              | 改错 `--display-name` 或 `--extension-version`；或列表存在同名多条 | 详情/卡片定位失败并停止，不猜测按钮                 |
| N7   | 卸载前权限开启                       | 打开「允许外部交互」后执行 uninstall                               | 报“仍开启，拒绝卸载；请手动关闭权限后重试”          |
| N8   | `--headless` 下安装/卸载             | 加 `--headless`                                                    | 连 CDP 前拒绝                                       |

N5 若无法在真机构造，记录“未覆盖 + 原因”，并在代码级测试（`tests/extension-manager-ui.test.ts` 的 details 用例）中保留证据；不要伪造通过。

## 7. §4.4 证据清单

- 包路径、SHA-256、预检完整身份；
- CDP target ID、端口、窗口标题、工程 UUID、PCB UUID；
- 安装前后的「已安装」列表；
- 权限关闭/开启/恢复的回执与截图；
- 卸载对话框身份核对、卸载后的列表回读；
- 临时副本源文件哈希、回显端口状态、同机用户会话与客户端进程状态；
- 每一步的授权记录（谁、何时、授权了哪条写命令）。

## 8. 验收结果（弱隔离演练，2026-11-25）

**结论：部分通过。** 安装、详情回读、权限关闭拒绝、卸载已走通；权限开启后的正例与 §4.5 的部分负例仍待补。由于 §4.1 隔离要求未满足，本轮不构成合格验收，也不作为 0.3.0 发布依据。

- 环境：Windows 11，嘉立创 EDA Pro 4.1.105 中文版；Leon 账户（弱隔离，操作者已接受）；临时工程 `out/acceptance/blink-copy/blink.eprj3`；CDP 端口 19463。
- 测试包：`lceda-acceptance-probe`，UUID `47fefe57915e855395040b47cda1966a`，版本 `0.0.1`，SHA-256 `a23a91cc89fefb39994256257f08b124c1b346ae78f3b1d26252cb0f0af48999`。
- 通过：`extension inspect` 离线预检；install 预览（`connected:false`）；`install --confirm` 成功并回读 `installed:true`；UI 显示名称/版本/UUID/已启用；`uninstall --confirm` 成功且 IndexedDB 无残留；权限关闭时 `invoke --ext-uuid` 调用 `sys_WebSocket.register` 被宿主拒绝（错误：未启用扩展和独立脚本的外部交互权限）。
- 未通过/未覆盖：权限开启后的回显正例（UI 开关需要操作者手动切换；DOM 合成事件未能改变后端状态）；§4.5 的 N1/N2/N5/N6 仅离线或表达式层覆盖，未在本轮真机逐条执行；§4.3 无头只读探测未执行。
- 真机发现并已修复的差异：项目页 URL 的 `tab=*<PCB>@<工程>` 字面量星号；「导入」是含隐藏 `input` 的按钮且 `input` 带 `multiple`；导入后的「安全提示」需要点唯一「确认」；已安装列表需要切换页签强制刷新；「允许外部交互」是隐藏 `input` + 可见 `label`。
- 证据目录：`out/extension-acceptance/2026-11-25/`（已被 git 忽略）。

## 9. 已知需要在真机确认的假设

- 入口 `./dist/index` 的解析方式、菜单 `registerFn` 的导出形态；
- 扩展管理器根/详情/对话框的 DOM 作用域与 `data-test` 选择器在 4.1.105 中文版是否稳定；
- `sys_WebSocket.register` 在权限关闭时抛错、开启时成功；
- `DOM.setFileInputFiles` 是否需要先 `DOM.enable`，临时文件是否会在导入完成前被清理；
- 4.1.105 之外版本是否按设计 fail-closed（标题/版本硬编码）。
