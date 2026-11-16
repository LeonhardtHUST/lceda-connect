# 依赖与配置指南

本文覆盖本 skill 的三个依赖：`lceda-pro-client`、`python-runtime`、`cdp-endpoint`。
连接层已内置在 `scripts/`，不再是外部依赖。核验日期 2026-11-02，只写官方入口，不引用第三方教程。

## 官方入口一览

| 用途 | 地址 |
|---|---|
| 立创EDA 官方主页 | https://lceda.cn/ |
| 专业版官方文档 | https://prodocs.lceda.cn/ |
| 客户端下载页 | https://lceda.cn/page/download |
| Python 官方主页 | https://www.python.org/ |
| Python 官方文档 | https://docs.python.org/3/ |
| Python 下载页 | https://www.python.org/downloads/ |
| Chrome DevTools 协议主页 | https://chromedevtools.github.io/ |
| Chrome DevTools 协议文档 | https://chromedevtools.github.io/devtools-protocol/ |

本 skill 不申请任何账号、不需要 Token、不联网调用第三方接口。

---

## lceda-pro-client

- 用途：被连接的目标本体，所有读取和操作都在它里面发生。
- 支持版本：专业版 4.1.x。4.1.78 在 Windows 上实测跑通；4.1.93 同期在官方下载页可见，未实测。
- 登录网址：不需要。本 skill 不登录、不接管账号。
- Token / Key / OAuth：不需要。
- 权限：普通用户安装即可，后续操作不需要管理员权限。
- 支持平台：官方提供 Windows（x64 / arm64 / Win7 x64）、macOS（x64 / arm64）、Linux（x64 / loong64 / sw64 / arm64）。
- 已验证平台：仅 Windows x64。macOS 与 Linux 机制同源（都是 Electron，profile 目录按 `~/.config/<产品名>/cache.<arch>.3` 组织），但未实测。

### 配置步骤

1. 从官方下载页取对应平台的安装包并安装，安装目录自行决定，后续命令里用实际路径替换 `<安装目录>`。
2. 首次启动会要求导入激活文件。激活文件由官方页面提供，导入后存放在数据目录 `Documents/LCEDA-Pro`（macOS / Linux 为 `~/.config` 下的对应目录）。没有激活会停在注册/激活界面，这不是故障。
3. 启动后确认能进到编辑器主界面，说明客户端本体正常。
4. 关闭客户端，再按主流程第一步带 `--remote-debugging-port` 重启。

### 凭据与隐私

- 激活文件、账号、工程数据均属用户私有。不要读取、复制、上传或写进任何报告。
- 页面 URL 会携带账号字段，任何输出前先过 `redact`（URL 账号参数 + 邮箱 + 手机号）。

### 验证方式

`check_environment.py --json` 里 `client-profile`（或可选的 `client-executable`）为 `ready`，即说明客户端存在。

### 撤销

关闭客户端即撤销调试能力；需要彻底恢复默认时，正常启动一次（不带任何参数）即可，不会有端口残留。

---

## python-runtime

- 用途：跑 `scripts/` 下的全部脚本（连接、扫描、体检、布线、渲染）。
- 支持版本：Python 3.10 及以上。
- 登录 / 凭据：不需要。
- 依赖范围：只用标准库（`socket`、`struct`、`urllib`、`json`、`base64`、`re`、`pathlib`），不需要 pip 安装任何包。
- 权限：只读写本 skill 目录与 `--out` 指定的目录。

### 配置步骤

1. 安装 Python 3.10+，Windows 安装时勾选把 `python` 加入 PATH。
2. 运行 `python --version` 确认版本。
3. 不需要创建虚拟环境，也不需要安装依赖。

### 验证方式

`check_environment.py --json` 里 `python-version` 为 `ready`。

---

## cdp-endpoint

- 用途：真正承载调试能力的本地 HTTP + WebSocket 服务，由客户端启动时开启。
- 下载地址：不需要——这不是要安装的东西，是客户端进程内建的服务。
- 登录 / 凭据：不需要。
- 权限：仅回环，`127.0.0.1`，禁止 `0.0.0.0`、端口转发、内网穿透。

### 配置步骤

1. 彻底退出客户端（托盘退出不算）。
2. 带参数启动：

   ```powershell
   & "<安装目录>\lceda-pro.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
   ```

3. 观察 stderr 是否出现 `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<uuid>`。
4. 运行 `python scripts/lceda_cdp.py discover` 确认端点与 uuid 归属。

不想每次手敲参数时，用 `python scripts/render_launcher.py --out-dir <目录>` 生成启停脚本，之后 `start` / `status` / `endpoint` / `stop` 四条命令搞定。脚本要由用户在自己的终端执行，详见 `launcher.md`。

### 能不能靠配置常驻

不能。`config.json` 里唯一的调试相关键是 `devTools`，它只在启动后打开本地 DevTools 窗口，不监听端口、不写 `DevToolsActivePort`（设成 `detach` 实测确认）。要让 CDP 常驻，只能让启动过程带上参数：装开始菜单入口，或把快捷方式指向启停脚本。改 `app.js` 注入开关也能做到，但要动安装文件、升级即失效、端口长期敞开，不推荐。

### 端口与多实例

- 端口被占用时换端口，或 `--remote-debugging-port=0` 让 Chromium 自选，实际端口写进 profile 目录下的 `DevToolsActivePort`。
- 同一 profile 下再启动第二个实例会绑定失败并退出，第一个实例的端点不受影响。
- 已经跑起来的实例不会再接受新开关，参数会被转交给老实例后丢弃。

### 验证方式

```bash
python scripts/lceda_cdp.py discover --json
```

`found` 为真即通过；判定依据是 `/json/version` 同时返回 `Browser` 与 `Protocol-Version`。

### 撤销

关掉客户端。想显式关闭端口而不关客户端，Chromium 没有提供运行时关闭接口，只能重启客户端且不带该参数。

---

## 一次完整的最小验证

```bash
python scripts/check_environment.py --json          # 退出码 0 或 1 即可用
python scripts/uimap.py scan --out ./ui-map/smoke --label baseline
python scripts/uimap.py entries --out ./ui-map/smoke
```

`check_environment` 的 `status` 为 `ready`，且 `ui-map/smoke/states/00-baseline.json` 里的区域节点数大于 5，说明环境可用。
`partial` 只说明客户端在、但没带调试端口启动，按上文重启即可。

## 数据与隐私

- 界面文字里会出现账号名、工程名、最近打开记录。产物属于本地私密材料，外发前自己确认。
- 脚本对 URL 查询参数、邮箱、手机号做替换，但**不替换界面文字里的账号名**。
- 不读取 cookie、localStorage 里的凭据、激活文件。
- 截图可能含工程名与器件编号，`--no-shot` 可关闭截图。
- `eval_cdp.py` 与 `diag_ns.py` 输出原文、不脱敏，别把原始 dump 贴进公开报告。

## 排错入口

- 端点开了但 `/json/list` 为空：页面还没建出来，等 4—6 秒。
- 只看到 `Regist` 页：客户端未激活，属正常状态。
- 动态端口找不到：读 profile 目录下的 `cache.*/DevToolsActivePort`，第一行是端口，第二行是 browser 路径。
- `connect-module` 检查失败：skill 目录不完整，重新安装并核对 `api-contract.md` 的符号集。
