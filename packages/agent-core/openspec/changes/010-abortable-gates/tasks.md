# 门控等待可中断 - 任务清单 (tasks.md)

> 状态：Task 1-4 已实施（2026-10-25）。任务按依赖顺序排列。

## 实施结果

| 项 | 落点 |
|----|------|
| run 级取消源 | `Agent.run()` 新建 `AbortController`，注入 `toolContext.signal`，`finally` 清理；`abort()` 置标志 + 触发信号 + 中断在途请求 |
| 确认门控 race | `executeToolCall` 用 `raceAbort(onConfirm, signal)`，中断视为未执行 |
| ask_user 门控 | `ToolContext.signal`（contracts 可选字段）+ `AskUserTool` 预检与 race |
| 历史补齐 | `answered` 集合 + `backfillAbortedToolCalls()`，补齐「任务已中断，工具未执行」并 yield `tool_call_result` |
| 测试 | 新增 13 项（AgentRun 6 / AskUserTool 2 / raceAbort 5），全量 241 项通过 |
| 文档 | agent-engine.md §3.3-3.5、§4、§6、§7；tool-system.md §6、§7、§8 已同步 |

## Task 1：run 级取消源 + 确认门控可中断 + 历史补齐

**优先级**：P0
**预估工作量**：中

- [x] `Agent` 新增 `abortController: AbortController | null`
  - `runLoop` 入口新建，注入 `toolContext.signal`，`finally` 清理
  - `abort()` = 置 `aborted` + `controller.abort()` + `currentRequest?.abort()`
- [x] 新增模块级 `raceAbort(promise, signal)`：信号触发 resolve 哨兵；两条分支均移除监听器
- [x] `executeToolCall` 的确认等待改为 `raceAbort(onConfirm, signal)`
  - 中断 → 视为未执行（不走拒绝分支）
  - 回调异常仍按拒绝处理（既有行为不变）
- [x] 历史补齐
  - `answered: Set<string>` 登记已写入 tool 消息的 `toolCall.id`
  - 新增 `backfillAbortedToolCalls(assistantMessage, answered)`：为未回灌调用补 `Error: 任务已中断，工具未执行` 并 yield `tool_call_result`
  - 中断退出点：assistant 消息已落地 → 补齐后 `return { status: 'aborted' }`；LLM 流中断 → 直接返回，不补齐
- [x] 新增 `ABORTED_RESULT` 常量，与 `DENIED_RESULT` 文案区分

**验收标准**：

- 确认门控挂起时 `abort()`，生成器在下一次 `next()` 即 `done`，返回 `aborted`，不依赖宿主 settle
- 中断后 assistant 消息中的每个 `tool_call` 都有 tool 消息与 `tool_call_result` 事件
- 未中断路径行为与现状一致

---

## Task 2：ask_user 门控可中断

**优先级**：P0
**预估工作量**：小

- [x] `packages/contracts/src/types/tool.ts`：`ToolContext` 新增可选 `signal?: AbortSignal`（向内，注释说明用途）
- [x] `AskUserTool.run`
  - 进入时 `signal.aborted` 预检 → 立即返回错误，不触达回调
  - 等待期间与 signal race → 中断返回 `用户交互已被中断`
- [x] 确认 `ToolManager` / 其他 8 个工具无需改动（signal 可选）

**验收标准**：

- `requestUserInput` 挂起时 `abort()`，工具立即返回中断错误，Agent 收尾为 `aborted`
- signal 已中断时不触达宿主回调
- 既有工具测试零回归

---

## Task 3：测试用例

**优先级**：P0
**预估工作量**：中

- [x] `test/agent/AgentRun.test.ts`
  - 确认门控中断：`onConfirm` 永不 resolve → abort 后立即 `aborted`
  - 迟到决议：中断后 resolve(true) → 无工具执行、无新增 tool 消息
  - 多工具调用补齐：3 个 tool_call 在第 1 个确认时中断 → 3 条 tool 消息齐全
  - LLM 挂起中断：历史条数不变（不补齐）
  - 跨 run 复用：中断后再次 `run()` 正常完成
- [x] `test/tools/ask-user/AskUserTool.test.ts`
  - 等待中断 → 返回中断错误
  - signal 已中断 → 不触达回调
- [x] 全量测试通过（基线 228 项 + 新增用例）

**验收标准**：

- 每条断言针对具体行为（不等待、不执行、消息成对），非仅 `success: false`
- 既有用例零回归

---

## Task 4：文档同步

**优先级**：P1
**预估工作量**：小

- [x] `openspec/systems/agent-engine.md`
  - §3.3 中断机制：补充门控等待 race、职责边界
  - §3.4 确认流：中断与拒绝的语义区分
  - §3.5 用户输入流：改为「signal 协作式中断」，移除「abort 无法中断已 await 的回调」
  - §6 已知限制：更新条目
  - 变更记录追加
- [x] `openspec/systems/tool-system.md`
  - §7 已知限制：移除门控等待不可中断，保留「运行中工具不可中断」
  - 变更记录追加
- [x] 勾选本 tasks.md 与 spec.md 验收项

**验收标准**：

- 文档与代码实态一致，职责边界（引擎 vs 宿主）表述清晰

---

## 依赖关系

```
Task 1（取消源 + 确认门控 + 补齐）
   └─ Task 2（ask_user 门控）
        └─ Task 3（测试）
             └─ Task 4（文档）
```

## 提交规划

- 批次 1（feat）：Agent 取消源 + 确认门控 + 历史补齐 + contracts `ToolContext.signal` + AskUserTool
- 批次 2（test）：新增中断用例
- 批次 3（docs）：change 三件套勾选 + 两份 systems 文档

## 后续立项（不在本期）

- 长任务取消：`run_command` 进程树终止、`web_fetch` 请求取消
- agent-core 主动终止源（策略/成本）出现时，再评估向外的中断通知
- Task 4 顺带修复文档漂移（见前一阶段盘点，单独 docs 提交，不混入本期）
