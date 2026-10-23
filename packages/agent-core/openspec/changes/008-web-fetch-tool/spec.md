# web_fetch 工具 - 需求规格 (spec.md)

> 状态：已实施（2026-10-23）。设计与 Claude Code 的 `WebFetch`、opencode 的 `webfetch` 对齐，
> 取舍见 design.md。本文档描述需求，实现见 `src/tools/web-fetch/`。

## 1. 背景

Agent 当前只能操作本地文件与 Shell，**没有任何出网能力**：

- 查不了在线 API 文档，只能凭记忆回答（易过时、易编造）
- 抓不了远程配置 / schema / 更新日志
- 读不了用户贴出的网页链接

`run_command` + `curl` 理论上是替代方案，但要求宿主机装好 curl、shell 引号转义易出错，
且输出无大小与超时约束——一个几百 KB 的 HTML 会直接灌满上下文窗口。

## 2. 目标

- 新增内置标准工具 `web_fetch`：LLM 主动抓取网页 / 只读接口
- 参数收敛为三个：`url` / `format` / `timeout_ms`
- **仅支持 GET**：只做「读」，不承担写请求（与 Claude Code、opencode 一致）
- HTML 按 `format` 转 markdown / text / html；非 HTML 内容原样返回
- 响应体上限 5 MiB，内容上限 10000 字符，超限截断
- **每次调用都需要用户确认**（`requiresConfirmation = true`）

## 3. 工具定义

| 属性 | 值 |
|------|-----|
| name | `web_fetch` |
| description | 抓取网页或接口并返回内容；仅 GET；format 决定 HTML 输出形态 |
| requiresConfirmation | `true`（每次请求前由宿主确认） |
| 实现位置 | `agent-core` 内置，不依赖 `projectPath` |

参数 schema：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `url` | string | 是 | — | 完整 URL，必须 `http://` 或 `https://` 开头，长度 ≤ 2000 |
| `format` | string | 否 | `markdown` | HTML 输出形态：`markdown` / `text` / `html` |
| `timeout_ms` | number | 否 | 30000 | 超时毫秒数，上限 120000 |

## 4. 详细需求

### R1：工具注册

- 作为 agent-core 内置工具随 `ToolManager` 构造自动注册（内置工具 8 → 9）
- 在 `createBuiltinTools` 组装点加一行；Agent 不做工具名特判、不新增事件类型
- 构造不需要 `projectPath`

### R2：URL 校验

发请求之前完成校验，失败以 `success: false` 返回：

- 非字符串 / trim 后为空 → 错误
- 长度 > 2000 字符 → 错误（对齐 Claude Code）
- 无法被 `new URL()` 解析 → 错误
- 协议不在 `http:` / `https:` 内 → 错误（挡住 `file:` / `data:` / `ftp:`）

### R3：format 校验

- 缺省 `markdown`
- 仅接受 `markdown` / `text` / `html`，其他值 → 错误
- `format` 只影响 HTML 内容；JSON / 纯文本 / XML 一律原样返回

### R4：超时

- `timeout_ms` 必须为正数，超过 120000 按 120000 截断（对齐 opencode 的 120s 上限）
- `AbortController` + 定时器实现，超时触发 `abort()`
- 超时 → `success: false`，错误信息含 `[timeout]` 前缀

### R5：请求形态

- 固定 `GET`，无请求体
- 固定请求头：浏览器 UA（对齐 opencode，避免站点拒绝非浏览器 UA）、`accept` 优先文档类型
- `redirect: 'follow'` 由运行时跟随；发生重定向时输出 `最终 URL`
- 不支持自定义请求头，因此**需要鉴权的地址无法抓取**（已知限制）

### R6：响应读取与大小上限

- 流式读取，累计字节达到 5 MiB 即停止并标记截断（对齐 opencode）
- 已读字节按 UTF-8 解码（非法字节替换，不抛异常）
- `204` / `205` / 空响应体 → 输出「（无响应体）」，不报错

### R7：内容处理

| 内容类型 | 处理 |
|----------|------|
| `text/html`、`application/xhtml+xml` | 按 `format` 转换：markdown / text / html |
| 其他文本（`text/*`、JSON、XML、JS、表单） | 原样返回 |
| 无 `content-type` | 按文本处理，原样返回 |
| 二进制（`image/*`、`application/octet-stream` 等） | 只输出 `[二进制响应] content-type，N 字节` |

- HTML 转 markdown 用 turndown（`headingStyle: atx`、`codeBlockStyle: fenced`），转换失败降级为纯文本
- HTML 转 text 用块级标签换行 + 去标签，并剔除 `script` / `style` / 注释
- HTML 时额外输出 `<title>` 为 `标题: ...`
- **图片不回传内容**：`ToolResult` 只有字符串通道，没有附件能力（与 opencode 的附件机制不同）

### R8：输出格式

```
HTTP 200 OK
最终 URL: https://example.com/final        # 仅重定向时输出
content-type: text/html
标题: 示例页                                # 仅 HTML 且能提取到 title 时输出
--- 内容 ---
# 标题
Hello **World**
```

- 内容超过 10000 字符时截断并追加 `[内容超过 10000 字符，已截断]`
- 响应体超过 5 MiB 时追加 `[响应体超过 5242880 字节，已截断]`
- 不再输出全量响应头（对齐 opencode 只回内容与元信息，减少噪音）

### R9：状态语义与错误处理

- **收到任意 HTTP 响应**（含 4xx / 5xx）→ `success: true`，状态码作为观察回灌
- **未收到响应**（DNS、连接、TLS、超时）→ `success: false`，带 `[timeout]` / `[network]` 前缀
- 工具自身绝不抛异常

### R10：确认策略

- `requiresConfirmation = true`：每次调用先走确认流
- 未注入 `onConfirm` 的宿主环境自动放行（现有引擎行为），文档需说明这一退化

### R11：日志埋点

- 发起：`info`，字段 `host` / `format` / `timeoutMs`
- 完成：`info`，字段 `status` / `bytes` / `durationMs` / `truncated` / `redirected`
- 失败：`warn`，字段 `error` / `durationMs`

## 5. 非目标（明确不做）

| 项 | 理由 |
|----|------|
| POST / PUT / PATCH / DELETE | 与两个参考实现一致，只做只读抓取；写请求仍用 `run_command` + curl |
| 自定义请求头、鉴权 | 参数收敛；需鉴权的地址交给其他工具 |
| 二次模型摘要（prompt 预过滤） | Claude Code 用 Haiku 先答再回传；本项目保持原始内容直达主循环 |
| 响应缓存 | Claude Code 有 15 分钟 TTL；本项目单次任务内重复抓取代价可接受 |
| 图片 / 二进制回传 | `ToolResult` 无附件通道，Base64 入上下文只会浪费 token |
| 域名黑白名单、内网地址拦截 | 与参考实现保持同等宽松策略；依赖「每次确认」兜底 |
| 大内容托管存储 | opencode 保留全文到 managed storage；本项目只做截断 |
| 并发 / 批量抓取 | 与现有工具串行调度一致 |

## 6. 验收标准

- `ToolManager.getToolNames()` 含 `web_fetch`，内置工具数为 9
- 单元测试覆盖 R2-R11 的边界：URL 校验、format 三种转换、5 MiB / 10000 字符截断、二进制、4xx、网络异常、超时
- 全量测试零回归
- `tool-system.md` 工具清单、确认列与决策表同步
