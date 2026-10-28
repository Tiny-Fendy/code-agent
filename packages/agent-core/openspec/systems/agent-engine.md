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
  → 无工具调用：最终答案，return { status: 'completed', steps }
  → 有工具调用：逐个执行（确认 → 开始 → 执行 → 结果 → 观察回灌）
    → 检测到 finish 工具：return { status: 'finished', steps, summary }
    → 其他工具：回到循环顶部
步数耗尽：return { status: 'maxSteps', steps }
中断：return { status: 'aborted' }
LLM 失败：return { status: 'llmFailed', message }
```

### 3.2 事件流契约

| 事件 | 时机 |
|------|------|
| text_delta / tool_call_delta | LLM 流式增量透传 |
| tool_call_confirm | 高危工具执行前（仅注入确认回调时） |
| tool_call_start / tool_call_result | 工具执行前后 |
| message_complete | 一轮 LLM 响应完成（含 step 序号） |
| context_compact | 上下文压缩应用成功（before/after token） |

事件流**只含过程数据**。成功 / 失败 / 超出步数 / 中断等结束语义不走事件，一律由 `run()` 的生成器返回值 `SendResult` 承载：`completed`（含 steps）、`finished`（含 summary）、`llmFailed`（含 message）、`maxSteps`、`aborted`。

### 3.3 中断机制

`abort()` 做三件事：置中断标志、触发 run 级 `AbortController`、调用在途 LLM 请求句柄（`LLMRequest`，含压缩摘要请求）的 `abort()`。

- **在途 LLM 请求**：连接立即中断，不等流事件到达
- **门控等待**（工具确认 / ask_user）：与 run 级信号 race，立即收口，不依赖宿主把回调 settle 掉
- **标志位检查点**：循环顶部、LLM 流读取中、工具执行间

中断统一以 `SendResult { status: 'aborted' }` 收尾，不抛异常。两种情况区别处理：

- assistant 消息已落地：先用「任务已中断，工具未执行」补齐所有未回灌的 `tool_call`（同时 yield `tool_call_result`），保证消息对完整，同一会话可在中断后继续使用
- LLM 流中断（无完整 assistant 消息）：不产生任何补齐

**职责边界**：中断由外部发起（宿主调 `Agent.abort()`）。引擎只保证自身不挂起与历史合法；宿主负责清理自己的等待（确认弹窗、待决表、迟到决议），如 Electron 侧 `ChatSession` 的 `settleConfirms`。当前不存在 agent-core 主动发起的终止源，因此没有向外的中断通知通道；终局的 `SendResult` 即既有回传通道。

### 3.4 工具确认流

- 工具声明 `requiresConfirmation` 且宿主注入了确认回调 → 先 yield `tool_call_confirm`，再 await 回调
- 回调返回 true 放行；false 拒绝；**回调抛异常按拒绝处理（安全默认）**
- 等待期间与 run 级取消信号 race：`abort()` 立即收口，不等待回调返回；迟到决议被丢弃，不触发工具执行
- 拒绝时不执行工具，但**仍回灌一条 tool 消息**（Function Calling 协议要求每个 tool_call 都有响应），LLM 据此自行调整
- 中断的未执行工具使用独立文案「任务已中断，工具未执行」，与「用户拒绝」区分（中断后不会有下一轮思考，不得误导模型调整策略）
- 未注入回调 → 自动放行（CLI / 自动化场景），不产生 confirm 事件

### 3.5 用户输入流（ask_user）

- `ask_user` 是标准内置工具（`requiresConfirmation=false`），Agent 不做工具名特判
- 工具从 `ToolContext.requestUserInput` 取宿主回调（由 `AgentOptions.onAskUser` 在构造时注入），`ToolManager` 不感知
- 用户回答映射为 ToolResult 回灌，LLM 继续下一轮；未注入回调 / 回调异常 / 空回答均降级为错误观察，不挂起
- 等待期间监听 `ToolContext.signal`（Agent 每个 run 注入的取消信号）做协作式中断：中断返回「用户交互已被中断」的错误观察；进入工具时信号已中断则不触达宿主回调
- **不新增 AgentEvent**：请求随 `tool_call_start.arguments` 留痕，回答随 `tool_call_result` 留痕；交互弹层由宿主回调驱动
- 超时由宿主回调负责；宿主在 `abort()` 时自行关闭交互弹层并清理待决项

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
| 门控等待用 run 级 AbortSignal 收口 | 引擎自洽：不依赖宿主 settle 回调；宿主只负责自己的 UI 与待决表 |
| 中断补齐未回灌的 tool 消息 | Function Calling 协议要求消息成对；补齐后同一会话可继续，避免宿主重建会话丢上下文 |
| 中断与拒绝使用不同文案 | 拒绝是用户决策，模型应调整策略；中断是任务终止，不应诱导模型重试 |
| 取消信号向内注入 ToolContext，不向外扩宿主契约 | 中断由宿主发起，宿主本就知道；终局 SendResult 已是回传通道，无重复通知的必要 |
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
- 运行中的长任务工具（`run_command` 子进程、`web_fetch` 请求）不响应中断，只能等自身超时或自然结束（属后续「长任务取消」议题）；门控等待（确认 / ask_user）已可中断
- 自定义工具若不监听 `ToolContext.signal`，中断仍可能在其内部等待
- 摘要质量依赖模型能力，弱模型可能丢失细节（后续可加"摘要 + 关键消息原文保留"策略）

## 7. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-10-14 | 初版补录：ReAct 循环、事件流契约、中断机制、工具确认流、压缩编排（均已落地实现） |
| 2026-10-16 | finish 工具接入：循环内检测 finish 调用后 return { status: 'finished', summary } 退出；系统提示词追加 finish 使用引导 |
| 2026-10-24 | abort 链路补全：`LLMProvider.chat()` 返回 `LLMRequest` 句柄（events + abort），`Agent.abort()` 经句柄立即中断在途 LLM 请求（此前仅标志位，流挂起时需等下一个事件才生效） |
| 2026-10-25 | 门控等待可中断：run 级 `AbortController` 作为唯一取消源，确认等待与 ask_user 等待均与信号 race，不依赖宿主 settle；中断后补齐未回灌的 tool 消息保证历史成对；`ToolContext` 新增可选 `signal`（向内注入） |
