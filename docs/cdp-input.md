# 定向 CDP 输入

优先使用嘉立创 EDA 编辑器 API。只有 API 不适用时，才用 `lceda-connect cdp input`（或 `lceda-cdp input`）和 MCP 工具 `cdp_input`，向已运行的指定 PCB 页面单次派发点击、有限按键或文本。

1. 用 `lceda-connect cdp targets --port PORT --json` 确认精确的 page target ID。用 `lceda-connect cdp docs active --port PORT --match TITLE --json` 核对当前 PCB UUID；标题命中不唯一时先停止，不猜目标。
2. `input` 必须显式提供端口、精确 target、当前 PCB UUID 和确认。点击坐标是目标顶层页面的视口 CSS 像素，不是 Windows 桌面坐标或板上坐标。

```text
lceda-connect cdp input click --port PORT --target TARGET --document PCB_UUID --x 600 --y 330 --confirm --json
lceda-connect cdp input key --port PORT --target TARGET --document PCB_UUID --key Escape --confirm --json
lceda-connect cdp input text --port PORT --target TARGET --document PCB_UUID --text 示例 --confirm --json
```

MCP 示例（`confirm` 必须为 `true`）：

```json
{
  "port": 9222,
  "target": "PAGE_TARGET_ID",
  "documentUuid": "PCB_UUID",
  "action": { "kind": "click", "x": 600, "y": 330 },
  "confirm": true
}
```

- 输入仅使用定向的 CDP。工具不启动客户端、不主动激活 Windows 窗口或移动系统指针，也不调用系统键鼠。点击须命中同源画布 iframe 内的 `canvas`；键盘要求画布已有合适的页面内焦点，文本要求其中已有普通可编辑控件的焦点。不满足时停止，不拉前台或静默改走其他通道。客户端收到输入后的窗口行为仍需真机核验。
- 模态框、目标身份变化等可能使操作被拒绝。确认表示允许派发输入，点击、按键和文本都可能改变编辑器状态；请勿同时在同一个 PCB 页面手工操作或从其他进程并发派发。
- `protocol-acknowledged` 表示协议确认接收，不等于所需操作生效。请按动作回读 EDA 状态，例如选区、界面状态或截图。收到 `CDP_INPUT_UNCERTAIN` 时，先查结果，不要盲目重试。
- 客户端版本、页面焦点、被遮挡或最小化均可能影响输入是否生效。本功能不承诺这些状态下都可以操作，也不替代尚未移植的专用布局、布线或规则编辑流程。

## 隔离真机复验

使用已授权的测试会话和可弃用 PCB。先选择能安全回读效果的动作，然后在同一 Windows 桌面让另一应用保持前台。记录派发期间的前台窗口与系统指针位置，检查 EDA 回读已变化、Windows 前台窗口和指针未被工具改变。把「CDP 返回成功」「EDA 实际变化」和「Windows 前台未改变」分别记录；只有三者都有证据才算该场景通过。不要在用户日常工程上验证。
