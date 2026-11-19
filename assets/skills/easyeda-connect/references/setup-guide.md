# 依赖配置与撤销

四条依赖里没有一条需要账号或凭据。全部只在本机回环地址上通信；本技能不读取激活文件、cookie、工程内容以外的任何账号信息。

## python-runtime

- 用途：运行全部脚本。缺它一切不可用。
- 支持版本：Python 3.10 及以上，仅标准库。
- 官方主页：https://www.python.org/
- 官方文档：https://docs.python.org/3/
- 下载地址：https://www.python.org/downloads/
- 登录网址：不需要。
- 配置步骤：
  1. 安装 3.10 或更高版本，安装时勾选加入 PATH。
  2. 终端执行 `python --version`，确认不低于 3.10。
  3. 不需要安装任何第三方包。
- 验证方式：`python scripts/check_environment.py --json`，`checks` 里 `python-version` 为 `ready`。
- 安全：脚本只读写本技能目录与显式指定的输出目录，不读取环境变量里的凭据类字段。
- 轮换与撤销：不需要。升级解释器即可，脚本无版本锁。
- 核验日期：2026-11-02。

## easyeda-cdp-connect

- 用途：视觉通道。纯画布出图、界面上执行、差分对全链路、重建灌注、美学检查脚本都依赖它。缺失时这些功能降级为人工。
- 支持版本：契约 2.x（稳定符号集与退出码语义冻结）。
- 官方主页：https://github.com/LeonhardtHUST/leonskill-easyeda-cdp-connect
- 官方文档：https://github.com/LeonhardtHUST/leonskill-easyeda-cdp-connect/blob/master/README.md
- 登录网址：不需要。
- 配置步骤：
  1. 克隆到用户级技能目录，目录名与技能同名：
     `git clone https://github.com/LeonhardtHUST/leonskill-easyeda-cdp-connect.git ~/.workbuddy/skills/leonskill-easyeda-cdp-connect`
  2. 确认该目录下存在 `scripts/lceda_cdp.py`。
  3. 若仓库放在别处，用环境变量 `EASYEDA_CONNECT_SCRIPTS` 指向其 `scripts` 目录。
- 验证方式：自检的 `connect-module` 为 `ready`，且九个稳定符号齐全。
- 安全：只连回环地址；本技能不通过它读取凭据或上传工程。
- 轮换与撤销：删除该目录或清空 `EASYEDA_CONNECT_SCRIPTS` 即撤销；本技能随即进入无视觉通道模式。
- 核验日期：2026-11-02。

## easyeda-bridge

- 用途：官方 API 通道。工程管理、制造导出、自动布线、图元读写走它。缺失时这些功能改走 CDP 或降级。
- 支持版本：协议 v1（`/health` 返回 `service: easyeda-bridge`，端口区间 49620-49629）。
- 官方主页：https://lceda.cn/
- 官方文档：https://prodocs.lceda.cn/
- 下载地址：https://jlc-ext.com/item/oshwhub/run-api-gateway
- 登录网址：不需要。
- 配置步骤：
  1. 在客户端扩展市场或上述地址获取 `run-api-gateway` 扩展并加载。
  2. 启动 bridge 服务（Node.js 常驻进程），它会占用 49620-49629 中的一个端口。
  3. 扩展加载后自动连接服务；自检能看到窗口数大于零即为连通。
- 验证方式：`python scripts/check_environment.py --json`，`bridge-probe` 为 `ready` 且 `windows` 大于零。
- 安全：服务只监听回环；本技能不往该通道发送工程数据以外的内容，不调用下单类接口。
- 轮换与撤销：关闭 bridge 进程或在客户端禁用扩展即撤销；重启客户端后端口释放。
- 核验日期：2026-11-02。

## lceda-pro-client

- 用途：被操作的目标程序。两条通道都依附于它。
- 支持版本：专业版 4.1.x（4.1.78 在 Windows x64 实测）。
- 官方主页：https://lceda.cn/
- 官方文档：https://prodocs.lceda.cn/
- 下载地址：https://lceda.cn/page/download
- 登录网址：不需要（本技能不代替用户登录）。
- 配置步骤：
  1. 安装专业版并完成激活，确认能进入编辑器。
  2. 走官方 API 通道：加载 bridge 扩展即可，无需重启。
  3. 走视觉通道：彻底退出客户端（托盘退出不算），带 `--remote-debugging-port=9222` 启动；已运行的实例无法事后追加端口。
- 验证方式：自检的 `client-session` 为 `ready`（至少一条通道能看到客户端）。
- 安全：不改安装文件、不注入进程、不打补丁。不要附加部分客户端版本不识别的 `--remote-debugging-address`；启动后在系统监听表确认调试端口只监听回环，发现非回环监听时停止该调试会话。
- 轮换与撤销：正常重启客户端即撤销调试端口；卸载扩展即撤销 API 通道。
- 核验日期：2026-11-02。

## 通道缺失时的行为

| 缺失项 | 立即影响 | 继续可做的事 |
|---|---|---|
| bridge | 工程管理、制造导出不可用；自动布线改走 CDP | 读板、DRC、规则、区域、铺铜、丝印、差分对、出图 |
| CDP | 无视觉回路；差分对与重建灌注不可用 | 开工程、读板、DRC、规则、区域、布线、铺铜建框、丝印、导出 |
| 两者都缺 | 无法操作客户端 | 只输出配置步骤，不产生任何设计变更 |
