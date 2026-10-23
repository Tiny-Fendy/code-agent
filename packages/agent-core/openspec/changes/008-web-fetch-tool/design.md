# web_fetch 工具 - 设计方案 (design.md)

## 0. 参考实现对照

| 维度 | Claude Code `WebFetch` | opencode `webfetch` | 本项目 `web_fetch` |
|------|------------------------|---------------------|---------------------|
| 定位 | 抓页面 + 用小模型回答一个问题 | 抓页面转 markdown/text/html | 抓页面 / 只读接口，返回内容 |
| 方法 | 仅 GET | 仅 GET | 仅 GET |
| 参数 | `url` + `prompt`（必填） | `url` + `format` + `timeout` | `url` + `format` + `timeout_ms` |
| 权限 | 每次需批准 | `ctx.ask` 权限优先 | `requiresConfirmation = true` |
| 大小上限 | 抓取约 10MB，正文截到 100KB | 5 MiB | 5 MiB（流式计数） |
| 内容处理 | Turndown 转 Markdown + Haiku 摘要 | 图片 Base64、HTML 转 MD/Text | turndown 转 MD、text / html 可选、图片只报元信息 |
| 超时 | — | 30s 默认 / 120s 上限 | 30s 默认 / 120s 上限（毫秒表达） |
| 缓存 | 15 分钟 TTL | 大内容托管存储 | 不缓存 |
| UA | 浏览器 UA | 浏览器 UA + Accept 协商 | 浏览器 UA + Accept |

## 1. 核心设计决策

### D1：只做 GET，收敛为「网页/内容抓取器」

**决策**：不提供 method / headers / body 参数，固定 GET。

**理由**：

- 与两个成熟实现完全一致——它们的定位都是「读」，不是通用 HTTP 客户端
- 参数从 5 个降到 3 个，模型选错参数的概率显著下降
- 写请求（POST/PATCH）天然不可重放、风险更高，继续交给需要确认的 `run_command` + curl
- 名字随之从 `http_request` 改为 `web_fetch`，避免占住通用 HTTP 客户端的语义位

**代价**：带鉴权的 API（如需要 token 的 GitHub 接口）抓不了。已在 spec §5 与工具描述中写明。

### D2：参数只留 url / format / timeout_ms

**决策**：`format` 枚举 `markdown` / `text` / `html`，默认 `markdown`；`timeout_ms` 默认 30000、上限 120000。

**理由**：

- `format` 对齐 opencode，把「怎么读」的选择权交给 LLM
- 超时用毫秒而非秒：仓库内 `run_command` 已用 `timeout_ms`，同包保持单位一致，避免两个工具单位不同踩坑

### D3：HTML → Markdown 引入 turndown

**决策**：新增运行时依赖 `turndown`（+ devDep `@types/turndown`），在 Node ESM 下直接可用（自带 domino，无需额外 DOM 依赖）。

**理由**：

- `markdown` 是默认格式，没有转换能力时这个参数就是空的
- 自写转换器无法正确处理表格、代码块、嵌套列表，代码量还更大
- 实测 `import TurndownService from 'turndown'` 在 Node 18+ ESM 下开箱可用，构建链路无需特殊处理
- 转换失败降级为纯文本，绝不因页面结构异常中断工具

**代价**：包体积增加（turndown + domino 约数百 KB），这是本项目第一个 HTML 解析类依赖。

### D4：三层内容处理，二进制只报元信息

**决策**：

| 类型 | 行为 |
|------|------|
| HTML | 按 `format` 转 markdown / text / html，并回显 `<title>` |
| 其他文本（JSON/XML/纯文本） | 原样返回，不受 `format` 影响 |
| 二进制 | 只报 `content-type` 与字节数 |

**理由**：

- JSON 转 markdown 毫无意义，`format` 只应作用于 HTML
- 图片等二进制在 opencode 里走 attachment 通道，而本项目 `ToolResult` 只有 `content: string`；
  把 Base64 塞进字符串纯属烧 token，且模型无法真正「看」图
- 明确回报类型与大小，LLM 可据此换用其他方式

### D5：每次请求都要确认

**决策**：`requiresConfirmation = true`。

**理由**：

- 与 Claude Code / opencode 的权限优先策略一致
- 出网是「影响外部世界」的动作：URL 由 LLM 生成，提示注入可诱导访问内网或恶意域名，确认是唯一的兜底
- 现有引擎已支持确认流，改动成本为零

**退化路径**：未注入 `onConfirm` 的宿主（无 UI 场景）会自动放行——这是引擎既有行为，文档中登记。

### D6：响应体 5 MiB 流式上限 + 内容 10000 字符上限

**决策**：两层独立截断，均追加显式标记。

**理由**：

- 5 MiB 对齐 opencode，用流式读取而非 `response.text()`，避免超大响应先进内存
- 10000 字符与 `run_command` 的 `MAX_OUTPUT_CHARS` 一致，保护上下文窗口
- 两级职责不同：字节上限保护内存与带宽，字符上限保护 token 预算

**与 opencode 的差异**：opencode 会把完整内容留在托管存储里，本项目没有该设施，只截断。

### D7：不输出全量响应头

**决策**：只回显状态行、`content-type`、`标题`（HTML）与内容。

**理由**：

- opencode 的返回形态是「内容 + 少量元信息」，响应头对阅读网页几乎没有价值
- 不输出响应头顺带消除了 `set-cookie` 凭证进入上下文的风险
- 4xx/5xx 的排查信息主要由响应体承载，够用

### D8：任意 HTTP 响应都算成功观察

**决策**：4xx / 5xx 返回 `success: true`；只有「没拿到响应」才是失败。

**理由**：

- 与 `run_command` 把非零退出码当正常结果的处理一致：状态码是 LLM 需要推理的**观察**
- 若把 404 标成 error，模型容易误判为「工具坏了」而不是「页面不存在」

### D9：重定向交给运行时跟随

**决策**：`redirect: 'follow'`，只回显最终 URL。

**理由**：

- 手写逐跳循环要处理 301/302/303/307/308 的方法降级、相对 Location、跳数上限，
  代码量与出错面远大于收益（且本工具只有 GET，方法降级问题不存在）
- 最终 URL 是最有用的信息，LLM 常需要它来修正后续抓取路径
- **已知限制**：中间跳链不可见

### D10：超时只做本地 AbortController

**决策**：仅按 `timeout_ms` 中止，不向 `ToolContext` 新增 `signal`。

**理由**：

- Agent 目前没有贯穿工具执行的取消通道（`ask_user` 已记录同一限制）
- 只为单个工具引入 `signal` 会造成「有的工具可取消、有的不能」的不一致
- 120s 上限已能避免无限挂起

## 2. 实现结构

```
src/tools/web-fetch/
├── WebFetchTool.ts   # 参数校验 + GET + 流式读取 + 内容转换/格式化
└── index.ts          # 导出
```

- 常量集中在文件头：`MAX_URL_CHARS` / `MAX_RESPONSE_BYTES` / `MAX_OUTPUT_CHARS` /
  `DEFAULT_TIMEOUT_MS` / `MAX_TIMEOUT_MS` / `USER_AGENT` / `ACCEPT_HEADER`
- 两个纯函数辅助：`extractTitle`（取 `<title>`）、`htmlToText`（去标签 + 去 script/style）
- turndown 实例作为工具字段，避免每次调用重复构造

## 3. 边界与错误表

| 场景 | 返回 | 前缀 |
|------|------|------|
| URL 为空 / 超长 / 不可解析 / 非 http(s) | error | `[invalid]` |
| `format` 不在枚举内 | error | `[invalid]` |
| `timeout_ms` 非正数 | error | `[invalid]` |
| 超时中止 | error | `[timeout]` |
| DNS / 连接 / TLS / fetch 抛错 | error | `[network]` |
| 收到 4xx / 5xx | **success** | — |
| 响应体超 5 MiB / 内容超 10000 字符 | **success**，截断标记 | — |
| 二进制 content-type | **success**，只报元信息 | — |
| turndown 转换抛错 | **success**，降级为纯文本 | — |

## 4. 测试策略

- 全部用例 stub `globalThis.fetch`，不发真实网络请求
- 用 `ReadableStream` 构造响应体，覆盖流式截断路径
- 超时用例：fetch 实现监听 `init.signal` 的 abort 事件并 reject，断言 `[timeout]`
- format 三态各一条：markdown 断言 `# 标题` / `**World**`，text 断言无标签，html 断言保留原标签
- 目录结构与 src 镜像：`test/tools/web-fetch/WebFetchTool.test.ts`
