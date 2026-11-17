# MCP 工程加固验收

日期：2026-11-18（北京时间）。范围从提交 `792b729` 之后的工程加固开始，包括首轮审查发现的修复和两次安全复核。本轮只做本地提交，不推送、不发包、不替换运行中的 bridge，也不修改真实 EDA 工程。

## 交付内容

- Bridge 校验回环 Host、Origin 与 agent token，限制请求体、代码、WebSocket 消息和待决请求数量；拒绝扩展端 `Origin: null`，修复同窗口重连时旧连接关闭删除新映射的问题。
- `cdp_eval` 采用完整表达式白名单。只允许少量明确的 DOM 只读属性、JSON 值和单个查询 API 调用，其余要求确认；参数只接受 JSON 字面量。修复链式调用、Unicode 标识符、标签模板及 U+2028/U+2029 行注释绕过。
- MCP 上下文接入取消信号、进度和 roots；提供工具集选择、结构化结果、结果资源模板。超过 64 KiB 的完整结果落盘，返回可解析的摘要和资源链接。
- 写路径校验覆盖产物目录；工程报告、网表和仿真产物再通过安全文件写入，拒绝已有最终文件链接并用同目录临时文件原子替换。仿真执行前拒绝 workDir 中已有链接。
- 子进程输出设上限，取消或超时清理进程树；显式批处理解释器的路径与参数都检查 cmd 元字符。
- 校正工具 annotations 和错误码，补真实 stdio、HTTP/WS、子进程、链接逃逸与取消测试。
- CI 使用 Windows/Linux 的 Node 22、24 运行开发工具链；用 Node 24 构建后在 Node 20.11 运行发布产物的 CLI、库和 MCP 握手冒烟。单独的 ngspice job 覆盖真实仿真。
- 加入 packageManager、发布元数据与条件导出。关闭构建自动改写 exports，构建前后 package.json 哈希一致。

变更说明见 [CHANGELOG](../../CHANGELOG.md)，使用方式与安全约定见 [README](../../README.md)。

## 验证环境与结果

本机为 Windows，Node `v26.13.1`、pnpm `12.21.0`。测试使用临时目录和模拟编辑器服务；本机已安装 ngspice。

| 命令                                             | 结果                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `pnpm exec vp check`                             | 169 个文件格式通过，146 个文件无 warning、lint 或类型错误                       |
| `pnpm exec vp test`                              | 26 个文件通过，373 passed、1 skipped，共 374 个用例                             |
| `pnpm exec vp pack`                              | 46 个文件，994.45 kB，成功；package.json 哈希与状态不变                         |
| `pnpm install --frozen-lockfile --lockfile-only` | 成功，lockfile 哈希不变；此命令验证冻结锁一致性，不等同于干净环境完整安装       |
| `npm pack --dry-run --json`                      | 1,692 个文件，解包 10,526,037 B，压缩 2,352,238 B，低于 15 MiB / 2,500 文件门禁 |

唯一跳过项为“未安装 ngspice 时的失败分支”，因为本机装有 ngspice。真实 ngspice 瞬态仿真通过。

Verbose 回归确认以下用例在本机实际执行并通过，未因为 Windows 链接权限而跳过：

- 批处理解释器的危险路径、危险参数被拒绝，普通路径和参数可执行。
- `epro2_report` 的 `meta.json` 指向目录外文件时拒绝写入，外部内容不变。
- 仿真 `stdout.txt` 在执行期间被换成链接时拒绝写入，外部内容不变。
- raw 对应的 CSV 指向目录外文件时拒绝写入，外部内容不变。
- 预置工作目录 reparse point 被拒绝，执行器没有启动。
- U+2028/U+2029 结束行注释后的副作用代码被 MCP 确认闸口拒绝。

原始命令、退出码、环境、verbose 输出及打包 JSON 保存在验证机器的临时证据目录：

```text
C:\Users\Leon\AppData\Local\Temp\lceda-acceptance\
  final-env.txt
  final-check.txt
  final-test.txt
  final-security-verbose.txt
  final-pack.txt
  final-lock.txt
  final-package.json
  final-status.txt
  final.diff
```

这些日志为本机运行证据，未提交到仓库。CI 配置已通过本地语法与脚本检查，但尚未推送触发 GitHub Actions；本报告不声称跨平台远端矩阵已经执行。

## 复核与边界

首轮安全审查未通过，发现了查询表达式绕过、扩展端 null Origin、批处理解释器路径注入、输出文件链接逃逸和重连竞态。上述问题修复后再次复核；复核又发现 Unicode 行终止符问题，补回归后重新运行全部命令。

本轮验证不等于操作系统隔离：

- 写路径策略用于防误写，不能限制任意 JavaScript、ngspice deck、生成器和 sidecar 自身的全部文件访问。它们以当前用户权限运行，只应执行可信内容。
- 临时文件原子替换不会跟随最终文件链接，但不提供针对恶意本地进程持续替换父目录的完整隔离；需要此威胁模型时应在容器或受限用户下运行。
- `confirm: true` 是调用方提供的参数，不代替客户端人工审批。查询 API 的只读约定依赖可信编辑器实现。
- 超限结果按完整原文归档，不自动脱敏。POSIX 新目录和文件权限分别为 0700/0600，Windows 继承用户目录 ACL；不要使用共享运行态目录。
- `Origin: null` 被拒绝可能影响使用此来源的旧扩展；本轮未对真实扩展连接 Origin 做端到端兼容验证。
- 上游许可证核实、大文件拆分、实验性 MCP tasks 和更严格的执行沙箱不在本轮完成范围内。
