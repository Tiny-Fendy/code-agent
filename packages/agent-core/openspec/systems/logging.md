# Logging（开发者诊断日志）

> 持久化设计文档，与代码保持严格一致。规格来源：openspec/changes/logging/。
> 状态：已落地（2026-10-19）。

## 1. 目标与原则

- **诊断通道**：日志仅面向开发者诊断，不面向用户展示；与面向 UI 的 AgentEvent 事件流严格分离
- **库静默**：agent-core 是库不是应用，未注入 logger 时全程无输出（缺省 NullLogger）
- **硬契约**：Logger 实现必须自行消化异常，任何情况下不得向调用方抛出；埋点处不做逐点防御
- **最小自研**：通用 Logger 接口 + Console 实现，后续按需求扩展（不引入第三方日志库）

## 2. 类型契约（@code-agent/contracts）

| 类型 | 位置 | 说明 |
|------|------|------|
| `LogLevel` | types/logger.ts | `'debug' \| 'info' \| 'warn' \| 'error'` |
| `Logger` | types/logger.ts | `debug/info/warn/error(message, context?)` 四方法接口，context 为可选键值对 |
| `AgentOptions` | types/agent.ts | `{ onConfirm?, logger? }` —— Agent 构造第三参 options 对象 |
| `ToolContext.logger` | types/tool.ts | 可选 logger，工具内诊断信息经此输出 |

## 3. 实现（agent-core src/logging/）

### ConsoleLogger
- `new ConsoleLogger(minLevel?: LogLevel)`，默认 `info`（debug 原文细节默认关闭）
- 输出格式：`[HH:mm:ss.SSS] [LEVEL] message {contextJson}`
- 级别过滤：`debug < info < warn < error`，低于 minLevel 不输出
- 通道：debug/info 走 stdout（console.log），warn/error 走 stderr（console.error）
- context 序列化失败（循环引用等）降级为 `String(value)`，自身不抛异常

### NullLogger
- 四方法空实现，库静默原则的缺省值，agent-core 入口导出

## 4. 注入链路（统一实例贯穿）

```
new Agent(config, projectPath, options?)
  ├─ options.logger ?? new NullLogger()          → Agent 私有 logger（埋点）
  ├─ new ToolManager(projectPath, logger)        → 工具执行埋点（缺省 NullLogger）
  ├─ toolContext = { projectPath, logger }       → 工具实现内取用
  └─ new ContextManager(tokens, limit, logger)   → 截断埋点（缺省 NullLogger）
```

- Agent 构造为 `(config, projectPath, options?: AgentOptions)`，onConfirm 与 logger 由 options 注入；2 参调用兼容（全部走缺省）
- 同一 logger 实例贯穿全链路（Agent / ToolManager / ContextManager / toolContext）

## 5. 埋点清单

### Agent（src/agent/Agent.ts）

| 位置 | 级别 | 消息 | 关键字段 |
|------|------|------|----------|
| run 开始 | info | 任务开始 | messageLength、maxSteps |
| run 终局 | info | 任务终局 | status（completed/finished/llmFailed/maxSteps/aborted）、steps、summaryLength、error |
| callLLM 请求 | info | LLM 请求 | model、messages、tokens、tools |
| callLLM 请求原文 | debug | LLM 请求原文 | messages、tools |
| callLLM 响应 | info | LLM 响应 | durationMs、contentLength、toolCalls |
| callLLM 响应原文 | debug | LLM 响应原文 | message |
| callLLM 失败 | error | LLM 调用失败 | error |
| 确认请求/通过 | info | 确认请求 / 确认通过 | tool、durationMs（用户决策耗时） |
| 确认拒绝 | warn | 确认拒绝 | tool、durationMs |
| 确认回调异常 | warn | 确认回调异常，按拒绝处理 | tool |
| 工具执行完成 | info | 工具执行完成 | tool、success、durationMs |
| finish 命中 | info | finish 命中 | summary |
| 压缩触发 | info | 压缩触发 | before、range |
| 压缩完成 | info | 压缩完成 | before、after、durationMs |
| 压缩防抖 | warn | 压缩后预估仍超阈值，防抖跳过 | estimate、threshold |
| 摘要失败/异常 | warn | 压缩摘要请求失败/异常，跳过本轮压缩 | error |

### ToolManager（src/tools/ToolManager.ts）

| 位置 | 级别 | 消息 | 关键字段 |
|------|------|------|----------|
| 工具未找到 | warn | 工具未找到 | tool |
| 工具执行异常 | error | 工具执行异常 | tool、error |

### ContextManager（src/context/ContextManager.ts）

| 位置 | 级别 | 消息 | 关键字段 |
|------|------|------|----------|
| tool 结果超限 | warn | tool 结果超限截断 | length、limit |

## 6. 已知限制

- LLM Provider（OpenAICompatibleProvider）内部不埋点：Provider 构造不含 logger；其网络/解析失败已通过 LLMEvent(error) 由 Agent 层「LLM 调用失败」error 埋点覆盖，避免 logger 硬塞进 Provider 构造
- ConsoleLogger 仅输出控制台，不写实体文件；宿主可自实现 Logger 写文件
- 暂无 request-id / trace-id 贯穿，按需后续扩展

## 7. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-10-19 | 落地：contracts 类型扩展（AgentOptions / ToolContext.logger）、ConsoleLogger/NullLogger、三处注入、全链路埋点、单测 15 项 |
