# 对话会话保持与工具确认门控 — 需求规格 (spec.md)

> 主进程 P0 缺口：会话跨轮丢失上下文、高危工具确认门控未接线。
> 关联：[rpc-communication 系统文档](../../systems/rpc-communication.md)、
> agent-core `006-logging`（options 注入）、`007-ask-user`（交互回调先例）。

---

## 1. 背景与现状

### 1.1 会话不保持

`ChatServiceImpl.send()` 每次调用都 `new Agent(...)`（`src/rpc/services/ChatServiceImpl.ts:32`）。
Agent 的上下文在实例内累积（`Agent.runLoop` 每轮仅追加 user 消息，不清空），因此：

- UI 侧消息连续显示，引擎侧每条消息都是**全新对话**
- 多轮追问无法引用上文，工具调用历史全部丢失

### 1.2 确认门控未落地

agent-core 已具备完整机制：

- `ToolManager.requiresConfirmation(name)` 判定高危工具（write_file / edit_file / run_command 等）
- 执行前 `yield tool_call_confirm` 事件，随后 `await options.onConfirm(toolCall)`
- 返回 `false` 时回灌 `DENIED_RESULT`，不执行工具

但宿主侧：

- `ChatServiceImpl.send()` 未注入 `onConfirm` → 引擎走"未注入自动放行"分支
- `ChatServiceImpl.confirmTool()` 为空实现（`ChatServiceImpl.ts:53`）
- Web 阶段②已完成确认卡片并调用 `rpc.chat.confirmTool(toolCallId, ok)`

即：**真实 Electron 环境下高危工具全部静默执行**，只有浏览器 mock 验证过确认交互。

---

## 2. 范围

本次只改 `packages/electron-main`：

1. 会话保持：Agent 实例跨 `send()` 复用，按需重建
2. 确认门控：打通 `onConfirm` ↔ `chat.confirmTool`
3. 两者的生命周期、并发与异常清理
4. 补齐 electron-main 的 Vitest 测试基础设施与 `ChatSession` 单测

---

## 3. 目标

- 连续两次 `send()` 使用同一 Agent，LLM 能引用上一轮上下文
- 高危工具执行前必须等待 UI 决议；拒绝则不执行
- 取消对话、流终局后无悬挂确认、无忙锁残留
- 配置或项目变更后自动重建 Agent，不带着错误上下文继续
- 以上行为由纯逻辑单测覆盖，不依赖 Electron 运行时

---

## 4. 详细需求

### 4.1 会话保持

- **R1 实例复用**：同一工作区下，连续 `chat.send()` 复用同一 Agent 实例，上下文连续累积。
- **R2 重建条件**（满足任一即丢弃旧实例、新建空上下文 Agent）：
  - API 配置变更（apiKey / baseUrl / model / temperature / maxTokens 等）
  - 当前项目路径变更（Agent 的工具根目录随之变化）
  - 上一轮被标记为"上下文不完整"（见 R7）
- **R3 并发保护**：上一轮流尚未终局时再次 `send()`，立即返回失败终局（错误码 `chat.BUSY`），不排队、不互相打断。

### 4.2 工具确认门控

- **R4 需确认即挂起**：注入 `onConfirm` 后，高危工具在执行前经 `tool_call_confirm` 事件通知 UI，并等待决议。
- **R5 决议生效**：`chat.confirmTool(toolCallId, ok)` 应答后，对应等待立即解除；`ok=false` 时工具不执行，引擎回灌拒绝观察。
- **R6 幂等与容错**：
  - 同一 `toolCallId` 重复决议按 first-wins 处理，后者忽略
  - 未知 / 已过期 `toolCallId` 静默忽略并记 warn 日志，不抛错

### 4.3 取消与异常安全

- **R7 上下文完整性**：若一轮结束时仍有"未闭环的工具调用"（assistant 消息声明了 toolCalls，
  但没有对应的 tool 结果回灌），标记会话不完整；下次 `send()` 重建 Agent，避免上游协议因
  "每个 tool_call 必须有 tool 消息"而报错。
- **R8 终局清理**：流以任意状态终局（completed / failed / aborted）后：
  - 忙锁复位
  - 待决确认表清空（未决议项按拒绝 settle）
  - 取消时立即 `agent.abort()` 并解除所有确认等待，避免生成器永久挂在 `await onConfirm`

### 4.4 可测试性

- **R9**：会话逻辑（复用 / 重建 / 忙锁 / 确认 / 完整性判定 / 清理）以纯 TS 类实现，
  不依赖 Electron、RPC 传输；单测通过注入伪 Agent 工厂覆盖上述全部分支。

---

## 5. 非目标

- 多会话 / 多标签页管理（当前单窗口单工作区）
- 会话跨应用重启持久化（内存态，重启即清空）
- 确认超时自动拒绝（窗口关闭、渲染层失联等极端场景记为已知限制）
- `ask_user` 接线（需契约新增事件通道，另立变更）
- 上下文"补丁修复"（补齐缺失 tool 消息），依赖 agent-core 能力，暂以重建兜底

---

## 6. 验收方向

1. 连续两轮对话，第二轮模型能引用第一轮内容（上下文未重置）
2. 请求写文件时 UI 出现确认卡片；拒绝后文件未改动，对话继续并说明被拒
3. 确认等待期间点击停止：无悬挂、无报错，随后可正常发起新对话
4. 流进行中重复发送被拒绝，错误码为 `chat.BUSY`
5. 修改模型配置或切换项目后，下一次对话从新上下文开始
6. `pnpm --filter @code-agent/electron-main test` 通过；typecheck / build 通过
