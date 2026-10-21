# Agent 引擎（ReAct 循环）

> 本文档是 Agent 引擎子系统的**持续性设计文档**，随代码演进同步更新。
> 上下文管理的详细设计见 [context-management.md](./context-management.md)；单次变更走 `openspec/changes/`。

## 1. 定位

Agent 是整个引擎的编排中枢，实现 ReAct（Reasoning + Acting）循环：LLM 思考 → 调用工具 → 观察结果 → 继续思考，直到给出最终答案。对外以 AsyncGenerator 推送事件流，宿主环境（Electron / CLI）消费事件渲染 UI。

## 2. 职责边界

| 职责 | 归属 | 说明 |
|------|------|------|
| ReAct 循环编排（思考/行动/观察） | Agent | 步数上限控制、终止判定 |
| 事件流推送 | Agent | 流式增量 + 生命周期事件 |
| 工具执行调度 | Agent（调）/ ToolManager（执） | Agent 只依赖 Tool 抽象，不认识具体工具 |
| 高危工具确认 | Agent（编排）/ 宿主（决策） | 确认回调注入，Agent 不关心 UI |
| 上下文压缩编排 | Agent | 摘要区交给 LLM 压缩并应用（数据操作在 ContextManager） |
| 消息存储 / token 估算 | ContextManager | 纯数据结构，见上下文管理文档 |
| LLM 通信 | OpenAICompatibleProvider | OpenAI 兼容流式协议 |

## 3. 核心机制

### 3.1 ReAct 循环流程

每一步（step）依次执行：

```
中断检查 → 上下文压缩检查 → 思考（调 LLM，流式转发）
  → 无工具调用：最终答案，done(completed)
  → 有工具调用：逐个执行（确认 → 开始 → 执行 → 结果 → 观察回灌）
    → 检测到 finish 工具：done(finished, summary)
    → 其他工具：回到循环顶部
步数耗尽：done(max_steps)
```

### 3.2 事件流契约

| 事件 | 时机 |
|------|------|
| text_delta / tool_call_delta | LLM 流式增量透传 |
| tool_call_confirm | 高危工具执行前（仅注入确认回调时） |
| tool_call_start / tool_call_result | 工具执行前后 |
| message_complete | 一轮 LLM 响应完成（含 step 序号） |
| context_compact | 上下文压缩应用成功（before/after token） |
| error | 出错（LLM 失败、步数耗尽等） |
| done | 任务结束（reason: completed / finished / aborted / max_steps；finished 时携带 summary） |

### 3.3 中断机制

`abort()` 设置中断标志，在四个检查点生效：循环顶部、LLM 流读取中、工具执行间、确认回调返回后。中断统一以 `done(aborted)` 收尾，不抛异常。

### 3.4 工具确认流

- 工具声明 `requiresConfirmation` 且宿主注入了确认回调 → 先 yield `tool_call_confirm`，再 await 回调
- 回调返回 true 放行；false 拒绝；**回调抛异常按拒绝处理（安全默认）**
- 拒绝时不执行工具，但**仍回灌一条 tool 消息**（Function Calling 协议要求每个 tool_call 都有响应），LLM 据此自行调整
- 未注入回调 → 自动放行（CLI / 自动化场景），不产生 confirm 事件

### 3.5 用户输入流（ask_user）

- `ask_user` 是标准内置工具（`requiresConfirmation=false`），Agent 不做工具名特判
- 工具从 `ToolContext.requestUserInput` 取宿主回调（由 `AgentOptions.onAskUser` 在构造时注入），`ToolManager` 不感知
- 用户回答映射为 ToolResult 回灌，LLM 继续下一轮；未注入回调 / 回调异常 / 空回答均降级为错误观察，不挂起
- **不新增 AgentEvent**：请求随 `tool_call_start.arguments` 留痕，回答随 `tool_call_result` 留痕；交互弹层由宿主回调驱动
- 超时与取消由宿主回调负责，与确认流一致（等待期间 `abort()` 无法中断已 await 的回调）

### 3.6 上下文压缩编排

每轮循环开头检查阈值；触发时把摘要区序列化为对话记录文本，交给 LLM 生成五段式结构化摘要（目标/进展/文件/决策/待办），应用后 yield `context_compact`。摘要请求**不携带 tools 定义**，防止压缩轮再次触发工具调用。详见上下文管理文档。

## 4. 关键设计决策

| 决策 | 理由 |
|------|------|
| Agent 只依赖 Tool 抽象 | 内置工具组装内聚在 ToolManager 构造函数中，Agent 零具体工具依赖；新增工具不改动 Agent |
| 确认回调注入而非事件轮询 | 宿主用 Promise 桥接 UI 异步决策，与引擎解耦 |
| 拒绝/失败均回灌 tool 消息 | 保证消息对完整性，OpenAI 兼容协议强制要求 |
| 压缩失败静默跳过 | 压缩是优化手段而非任务本身，失败不应中断用户任务 |
| 中断用标志位而非异常 | AsyncGenerator 中断需在多个 await 点检查，标志位语义清晰、易审计 |
| finish 是标准工具而非硬编码特殊逻辑 | LLM 只能通过工具调用来表达意图；工具机制天然支持 schema 校验、错误回灌、结果回传 |

## 5. 参数默认值

| 参数 | 默认值 | 说明 |
|------|--------|------|
| maxSteps | 10 | 最大思考-行动步数 |
| contextTokens | 8000 | 上下文预算（透传 ContextManager） |
| systemPrompt | 内置代码助手提示词 | 可通过 AgentConfig 覆盖 |
| 摘要输出上限 | 800 token | 压缩编排内部约束 |

## 6. 已知限制与非目标

- LLM Provider 在构造时固定为 OpenAICompatibleProvider，未开放注入（当前只有一种协议，等出现第二种再抽象）
- 无子 Agent / 并行工具执行（工具串行执行）
- 无会话持久化与恢复
- 摘要质量依赖模型能力，弱模型可能丢失细节（后续可加"摘要 + 关键消息原文保留"策略）

## 7. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-10-14 | 初版补录：ReAct 循环、事件流契约、中断机制、工具确认流、压缩编排（均已落地实现） |
| 2026-10-16 | finish 工具接入：循环内检测 finish 调用后 return { status: 'finished', summary } 退出；系统提示词追加 finish 使用引导 |
