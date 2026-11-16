# 界面结构地图

实测对象：立创EDA专业版 4.1.78.34f5b8d9 / Electron 41.2.1 / Chromium 146，Windows x64。
下面的结构在不同版本可能变化，连接后先用 `targets` 和 `frames` 复核，不要照搬。

---

## target 组成

典型一次运行的 `/json/list`：

| 类型 | 数量 | 说明 |
|---|---|---|
| `page` | 1—2 | 主界面；未激活时另有注册页 |
| `service_worker` | 1 | URL 形如 `https://client/editor?entry=sw.js` |
| `worker` | 2—3 | 标题与 URL 多为空 |

`type` 只有这几种实际出现，没有独立的 `iframe` target，也没有 `browser` 之外的其它页面型 target。

## page 的三种形态

| 形态 | URL 特征 | 何时出现 |
|---|---|---|
| 注册 / 激活页 | `https://client/editor?entry=regist` | 客户端未激活 |
| 编辑器主界面 | `https://client/editor` | 正常就绪 |
| 外壳容器页 | `file:///.../resources/app/assets/view/index.html` | 主窗口装载阶段 |

主界面标题形如 `嘉立创EDA(专业版) - V<版本>`。URL 上可能带查询参数，其中一部分是账号信息，输出前必须脱敏。

## iframe 结构

未打开工程时，frame 树很浅：

```text
page  嘉立创EDA(专业版) - V4.1.78
├── frame (main)          https://client/editor
└── frame (main)          about:blank
```

打开 PCB 之后，多出编辑器的预览 frame：

```text
page  嘉立创EDA(专业版) - V4.1.78
├── frame (main)                    https://client/editor
├── frame                           about:blank
└── frame frame_preview_<hex>       https://client/editor?entry=pcb
```

- `entry=pcb` 是 PCB 编辑器；只在真的开了 PCB 时出现，空跑时查不到属正常。
- `entry=regist` 是注册/激活流程。
- 原理图、封装、符号等编辑器的 `entry` 取值未实测，不要凭猜写死；用 `frames` 现查。

**关键**：切换编辑器时 page target 不变，只有 iframe 的 URL 变。所以自动化逻辑要绑 page + 按 frame URL 匹配，不能靠 target 列表区分编辑器。

**另一个坑**：`document.querySelectorAll('iframe')` 在 DOM 里可能返回空数组，而 CDP 的 frame 树照样能看到 frame。判断页面结构用 `frames` 命令，别用 DOM 查询；两者不等价。

## 画布限制

PCB 与原理图用 canvas 渲染，设计内容（器件、网络、走线、坐标）不以 DOM 存在。

- DOM 查询只能读到界面框架，读不到设计数据。
- 想让人看见，用 `shot` 截图。
- 想拿到结构化设计数据，必须走客户端内部接口，这条路未验证。不要承诺能做，也不要假装做到了。

## 可以放心读的表达式

```javascript
document.title
location.href
navigator.userAgent
document.readyState
document.querySelectorAll('canvas').length
JSON.stringify(Array.from(document.querySelectorAll('iframe')).map(f => f.src))
```

## 必须脱敏的字段

页面 URL 与部分接口参数里会出现下列字段，输出、截图说明、日志、报告一律替换成 `<REDACTED>`：

- `username`
- `email`
- `phone`
- `customer_code`
- `license`
- 其它 `token` / `session` / `ticket` 类

## 版本指纹

连接成功后先记下这三个值，出问题时用来判断是不是版本漂移：

| 字段 | 来源 |
|---|---|
| `Browser` | `/json/version`，形如 `Chrome/146.0.7680.188` |
| `User-Agent` 里的 Electron 段 | `/json/version`，形如 `Electron/41.2.1-jlc-sa-win-x64.6` |
| `V8-Version` | `/json/version` |

客户端版本看主界面标题里的 `V<版本>`，以及 `User-Agent` 里的产品段。

## 进程形态

同一份主程序会以不同角色跑多个进程，靠 `--type=` 区分：无 `--type` 的是 browser 进程（CDP 服务在它里面），其余是 `renderer` / `gpu-process` / `utility` / `crashpad-handler`。

按进程名分类会失效——它们全叫同一个名字。
