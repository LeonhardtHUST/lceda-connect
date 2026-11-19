# MCP 配置进阶

首次接入请先看 [README 的 Quick Start](../README.md#quick-start)。客户端的启动命令和参数要分开填写；`mcp tools` 只列清单，不启动 stdio 服务。

## Windows 找不到 npx

先在终端运行 `where.exe npx`。桌面客户端未继承相同的 PATH 时，优先在配置中填写 `npx.exe` 的绝对路径。如果系统只提供 `npx.cmd`，而客户端不支持直接启动批处理，改用 `cmd.exe` 启动这个固定命令：

```json
{
  "mcpServers": {
    "lceda": {
      "type": "stdio",
      "command": "cmd.exe",
      "args": ["/d", "/c", "npx.cmd", "-y", "lceda-connect", "mcp", "--toolsets", "offline"]
    }
  }
}
```

同样的 Command 和 Args 也可用于 Codex 或 DeepSeek Harness 的 stdio 配置。重新打开客户端后，先调用 `lceda_info`。如果仍无法找到 `npx.cmd`，可用已构建的本地代码：Command 填 `node.exe` 的绝对路径，第一个参数填 `dist/cli.mjs` 的绝对路径，后面填 `mcp`、`--toolsets` 和 `offline`。

## DeepSeek Harness 组合配置

Desktop / Web 用户优先从设置中的 MCP 管理添加服务。自建组合使用 `@deepseek-ai/dsh-mcp-manager` 时，把 `lceda` 合并入现有管理器的 `config.servers`；不要新建第二个管理器。`cordis.patch.yml` 对 `servers` 是整张表替换，手工编辑时要一并保留已有服务。管理器配置节选：

```yaml
config:
  servers:
    lceda:
      transport: stdio
      command: npx
      args: ["-y", "lceda-connect", "mcp", "--toolsets", "offline"]
```

如果使用配置型 bundle 为某个预设固定连接，可在该预设中使用 `@deepseek-ai/dsh-mcp-client`，而不是配置全局管理器。字段与已安装的 DeepSeek Harness 0.2.2-rc.3 文档核对。连接成功后工具名形如 `mcp__lceda__lceda_info`。

## 连接编辑器和固定版本

`offline` 不加载 CDP、Bridge 和 EDA 编辑器工具。确认本地环境可用后，可把命令中的 `offline` 改成 `live`，并按 [Windows 连接说明](../README.md#windows连接-easyeda-pro)配置编辑器。`offline` 仍包含写盘与仿真功能，不能代替操作系统隔离或调用审批。

团队配置可以把 `lceda-connect` 改为 `lceda-connect@0.1.0` 等已经发布的精确版本，升级时再显式改版本。不要把 Bridge token 或 npm 凭据提交到项目的 `.mcp.json`；优先使用同一用户下的 Bridge 凭据文件，或客户端支持的凭据机制。
