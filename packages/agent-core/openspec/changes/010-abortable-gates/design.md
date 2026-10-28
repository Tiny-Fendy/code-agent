# 门控等待可中断 - 设计方案 (design.md)

> 状态：已实施（2026-10-25）。需求见 [spec.md](./spec.md)。

## 1. 核心设计决策

### D1：run 级 AbortController 作为唯一取消源

每次 `runLoop` 入口新建 `AbortController`，`abort()` 统一触发：

```ts
abort(): void {
  this.aborted = true;          // 循环检查点用（语义直白、易审计）
  this.abortController?.abort(); // 门控等待 race 用
  this.currentRequest?.abort();  // 在途 LLM 连接立即中断
}
```

保留 `aborted` 布尔而非全靠 `signal.aborted`：

- 五个检查点已在读布尔，改动面最小
- `abortController` 为 null（run 之间）时布尔仍能表达「已中断」

不选「每个门控各建一个 deferred」：一个 run 只应有一个取消源，否则新增门控点就要新增一个信号，容易漏。

### D2：确认门控用 race 收口，宿主 settle 降级为兜底

```ts
const decision = await raceAbort(this.onConfirm(toolCall), signal);
if (decision === ABORTED) {
  // 视为未执行，交给统一的中断收尾（补齐 + return aborted）
}
```

- `raceAbort` 在信号触发时立即 resolve 哨兵值，并在两个分支都移除监听器（防泄漏）
- 未中断时行为与现状完全一致（含回调异常按拒绝处理）
- 宿主的 `settleConfirms(false)` 保留：引擎 race 先完成时它再 resolve 是无害的幂等操作；它是宿主履行自身等待清理的职责，不是正确性前提

### D3：门控中断语义 = 「未执行」，不是「拒绝」

拒绝是用户决策，LLM 应据此调整策略；中断是任务终止，不会再有下一轮思考。两者必须用不同文案：

| 情形 | tool 消息内容 | 来源 |
|------|--------------|------|
| 用户拒绝 | `Error: 用户拒绝了本次工具调用` | 既有 `DENIED_RESULT` |
| 中断 | `Error: 任务已中断，工具未执行` | 新增 `ABORTED_RESULT` |
| ask_user 中断 | `Error: 用户交互已被中断` | AskUserTool 返回值 |

中断路径不再走「拒绝 → 回灌 → 继续循环」，而是统一收尾。

### D4：历史完整性用「已回灌集合」+ 统一补齐

不用「执行到第几个」计数（中断可能发生在确认前、确认中、工具内部，计数语义会跑偏），改为：

```ts
const answered = new Set<string>();  // 已写入 tool 消息的 toolCall.id
```

- 每写一条 tool 消息即 `answered.add(id)`
- 中断退出前统一补齐：遍历该 assistant 消息的 `toolCalls`，未在集合内的补一条中断结果，并 yield `tool_call_result`
- 补齐条件：assistant 消息已加入上下文（LLM 流中断时不会走到这里）

好处：与中断发生位置解耦；多工具调用时一次性补齐全部缺口；UI 也能从事件流看到「被取消」的结果。

不选「留缺口 + 宿主重建会话」：会丢掉整个对话上下文，且把正确性责任推回宿主，与 spec §3 的职责划分冲突。

### D5：ask_user 用 ToolContext.signal 做协作式中断

- `ToolContext.signal` 由 Agent 在每个 run 注入（run 级 controller 的 signal），属于**向内**输入
- `AskUserTool` 进入时先查 `signal.aborted`，等待期间与回调 race；中断返回错误观察
- Agent 侧不硬切 `toolManager.execute`：
  - 硬切对门控工具只是丢一个 pending promise，但对 `run_command` 会留下活着的子进程
  - 工具自己知道什么资源需要清理，协作式是唯一能同时覆盖两类场景的位置
- 自定义工具若不监听 signal，中断仍可能在工具处等待——属已知限制（见 R4）

### D6：不扩展宿主回调契约，不新增向外通知

中断由宿主发起：

```
renderer chat.cancel → ChatSession.abort() → Agent.abort()
```

宿主在调 `abort()` 的那一刻就知道要关弹窗、清待决表；终局又通过 `SendResult` 回传。再给 `onConfirm` / `onAskUser` 传 signal 属于重复信息，且会把「宿主清理」这一职责重新混进引擎契约。

真正的例外是 **agent-core 主动发起**的终止（策略/成本/安全拦截）：那种情形宿主不知情，才需要向外信号。当前不存在此类特性，YAGNI。

## 2. 实现结构

```
src/agent/Agent.ts
├── private abortController: AbortController | null
├── runLoop()
│   ├── 新建 controller + 注入 toolContext.signal
│   ├── finally：清理 controller / signal
│   ├── 门控前检查 aborted（assistant 消息已落地 → 补齐全部未回灌）
│   ├── 工具循环：answered 集合登记
│   └── 中断退出：yield* backfillAbortedToolCalls() → return { status:'aborted' }
├── executeToolCall()
│   └── await raceAbort(onConfirm(...), signal)
└── raceAbort()（模块级辅助）
```

```
src/tools/ask-user/AskUserTool.ts
└── run()
    ├── signal.aborted 预检
    └── race(requestUserInput, signal) → 中断返回 error
```

```
packages/contracts/src/types/tool.ts
└── ToolContext.signal?: AbortSignal（可选，向内）
```

## 3. 风险与验证项

| 风险 | 说明 | 验证 |
|------|------|------|
| R1 迟到决议 | race 后宿主回调才返回 true，可能被误当放行 | 测试：abort 后再 resolve(true)，断言无工具执行、无新增消息 |
| R2 监听器泄漏 | race 的 `abort` 监听器未移除，跨 run 累积 | 实现时在 resolve/reject 两分支都 `removeEventListener`；测试结束后检查 `signal` 无副作用 |
| R3 补齐时机 | LLM 流中断时误补齐（无 assistant 消息） | 测试：LLM 挂起中断 → 历史条数不变；工具阶段中断 → 数量正确 |
| R4 工具不响应 signal | 自定义工具或未接入 signal 的工具仍会等待 | 记录为已知限制；`run_command` / `web_fetch` 归「长任务取消」后续立项 |
| R5 跨 run 污染 | 上一 run 的 controller 残留，导致下一次 run 误中断 | controller 在 `finally` 清理；测试：中断后再次 `run()` 正常完成 |
| R6 宿主重复收口 | ChatSession `settleConfirms` 与引擎 race 同时发生 | 幂等；既有 ChatSession 测试保持全绿 |

## 4. 测试策略

按功能设计编写（`test/agent/AgentRun.test.ts`、`test/tools/ask-user/AskUserTool.test.ts`）：

1. **确认门控中断**：`onConfirm` 永不 resolve 的 provider；`abort()` 后下一次 `next()` 立即 `done: true` 且返回 `aborted`
2. **迟到决议**：中断后 `resolveConfirm(true)`，断言无工具执行、无 tool 消息新增
3. **多工具调用补齐**：一条 assistant 消息含 3 个 tool_call，确认第 1 个时中断 → 3 个 tool 消息齐全，2/3/… 内容为中断文案
4. **ask_user 中断**：回调挂起时 `abort()` → 工具返回中断错误，Agent `aborted`，历史成对
5. **ask_user 预检**：signal 已中断 → 不触达回调
6. **无 assistant 消息不补齐**：LLM 挂起中断 → 历史与中断前一致
7. **跨 run 复用**：中断后再次 `run()` 正常完成

## 5. 后续扩展方向（本期不做）

- 长任务取消：`run_command` 进程树终止、`web_fetch` 请求取消，需要 `ToolContext.signal` 从「协作提示」升级为「强制执行契约」
- agent-core 主动终止源（策略引擎 / 成本上限）出现时，再引入向外的中断通知
