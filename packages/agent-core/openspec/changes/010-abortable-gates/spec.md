# 门控等待可中断 - 需求规格 (spec.md)

> 状态：已实施（2026-10-25）。本文档描述需求，设计推理见 design.md。

## 1. 背景

`Agent.abort()` 当前只能终止在途 LLM 请求，无法终止**门控等待**（等待用户决策的挂起点）：

| 门控 | 等待点 | 现状 |
|------|--------|------|
| 工具确认 | `Agent.executeToolCall` 内 `await this.onConfirm(toolCall)` | 只置 `aborted` 标志，await 不返回 → 引擎挂起 |
| ask_user | `AskUserTool.run` 内 `await context.requestUserInput(request)` | 等待发生在工具内部，Agent 无法感知 |

Electron 侧目前靠宿主兜底：`ChatSession.abort()` 在 `agent.abort()` 之后额外 `settleConfirms(false)` 唤醒确认等待。该兜底有三个问题：

- 只覆盖确认门控，ask_user 门控不覆盖
- 是宿主职责而非引擎能力，换宿主（CLI / 测试 / 未来宿主）必须重新复刻
- 中断后若剩余 tool_call 未回灌，历史出现缺口，ChatSession 只能标记 dirty、下次重建会话（丢掉上下文）

## 2. 目标

- `abort()` 能终止**引擎自身**的全部门控等待，不依赖宿主配合
- 中断后保持消息成对：assistant 声明的每个 `tool_call` 都有对应 tool 消息，同一会话可在中断后继续使用
- 门控中断语义与「用户拒绝」区分开，不误导 LLM 调整策略（本次任务已终止，不会再有下一轮思考）
- 中断仍走既有终局通道 `SendResult { status: 'aborted' }`，不新增 AgentEvent

## 3. 职责边界

| 责任方 | 保证 |
|--------|------|
| agent-core | ① 自身绝不挂起：门控中断由引擎内部收口 ② 历史保持成对 ③ 终局通过 `SendResult` 回传 |
| 宿主 | 自己的等待清理：关闭确认弹窗、清空待决表、丢弃迟到的用户决议 |

中断由外部发起（宿主调用 `Agent.abort()`），因此**不扩展 `onConfirm` / `onAskUser` 的回调契约**，也不新增向外的中断通知：

- 宿主在发起 abort 的当下就知道要清理自己的等待
- 终局 `SendResult` 已经是既有的向外通知通道

唯一需要向外通知的情形是 agent-core **主动发起**的终止（如成本/安全策略拦截），当前不存在此类特性，等出现时再立项。

## 4. 详细需求

### R1：run 级取消源

- 每个 `runLoop` 新建一个 `AbortController`，run 结束（含异常/中断）时清理
- `abort()` = 置 `aborted` 标志 + `controller.abort()` + `currentRequest?.abort()`
- 取消源按 run 粒度，不复用、不跨 run 泄漏；同一 Agent 中断后可再次 `run()`

### R2：确认门控可中断

- 等待 `onConfirm` 时与取消信号 race；信号触发即视为「工具未执行」
- 中断不抛异常、不等待宿主回调返回
- 宿主回调迟到返回（true/false）一律丢弃，不得触发工具执行、不得追加消息

### R3：ask_user 门控可中断

- `ToolContext` 新增可选字段 `signal?: AbortSignal`（**向内**传给工具，不是传给宿主）
- `AskUserTool` 用该信号 race 宿主回调：中断时返回 `success: false` 的错误观察（`用户交互已被中断`）
- 进入工具时信号已中断 → 立即返回错误，不触达宿主回调
- 不在 Agent 层硬切 `toolManager.execute`：硬切会留下孤儿回调与僵尸子进程；工具内部协作式中断才是正确位置

### R4：中断后的历史完整性

- 以 `toolCall.id` 维护「已回灌」集合；每写入一条 tool 消息即登记
- 中断退出前，为 assistant 消息中所有未回灌的 `tool_call` 补一条结果：
  - tool 消息内容：`Error: 任务已中断，工具未执行`
  - 同时 yield 对应的 `tool_call_result` 事件（`success: false`），供 UI 标记为已取消
- 仅当 assistant 消息已落地时才补齐；LLM 流中断（无完整消息）不产生任何补齐
- 补齐后同一会话的历史合法，宿主无需重建 Agent

### R5：行为兼容性

- 未中断路径零变化：正常确认、拒绝、工具执行、ask_user 回答的流程与文案不变
- 拒绝（`用户拒绝了本次工具调用`）与中断（`任务已中断，工具未执行`）文案区分
- `ToolContext.signal` 为可选字段，不破坏既有自定义工具与测试
- 不新增 `AgentEvent` 类型；`SendResult` 五态不变

### R6：文档同步

- `openspec/systems/agent-engine.md`：§3.3 中断机制、§3.4 确认流、§3.5 用户输入流、§6 已知限制
- `openspec/systems/tool-system.md`：§7 已知限制（移除「确认/ask_user 等待不可中断」，保留「运行中工具不可中断」）
- 变更记录追加

## 5. 非目标（明确不做）

| 项 | 理由 |
|----|------|
| 运行中工具（`run_command` 子进程、`web_fetch` 请求）强制中断 | 属「长任务取消」议题：需要进程树终止、出网取消、工具契约扩展，独立立项 |
| 扩展 `onConfirm` / `onAskUser` 契约传 signal | 中断由宿主发起，宿主自行清理；终局已有回传通道 |
| 新增向外中断事件 | 当前无 agent-core 主动发起的终止源 |
| 中断时保留已执行工具的部分结果并让 LLM 继续 | 中断语义即终止任务，不进入下一轮思考 |
| 会话持久化 / 重建策略调整 | 宿主侧（ChatSession）职责，本期只保证历史合法，不改变其策略 |

## 6. 验收标准

- 确认门控：`abort()` 后无需宿主 settle，生成器在下一次 `next()` 即返回 `{ status: 'aborted' }`
- ask_user 门控：`abort()` 后工具立即返回中断错误，Agent 收尾为 `aborted`
- 历史成对：中断后 assistant 消息中的每个 `tool_call` 都有对应 tool 消息；同会话再次 `run()` 历史合法
- 迟到决议：中断后宿主回调再返回 true/false，不产生工具执行、不追加消息
- 未中断路径全量测试零回归
- 两份 systems 文档与代码实态一致
