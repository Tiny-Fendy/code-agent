# 对话会话保持与工具确认门控 — 设计提案 (design.md)

> 需求见 [spec.md](./spec.md)。本文只讨论 host 侧（electron-main）方案，
> 不改 contracts / agent-core / rpc / web。

---

## 1. 问题定位

两个缺口共享同一根因：`send()` 是"一次性"实现。

| 现象 | 代码事实 | 后果 |
| --- | --- | --- |
| 多轮无上下文 | `send()` 内 `new Agent(...)` | Agent 上下文随每次调用重置 |
| 高危工具静默执行 | `AgentOptions` 只传 `logger` | 引擎走"未注入 onConfirm → 自动放行" |
| `confirmTool` 无效 | 空实现 | UI 决议无处投递 |

因此本次把"一次对话"升级为"一个会话"：会话持有 Agent 实例、确认待决表与生命周期状态，
`send()` 只负责把 RPC 流接上去。

---

## 2. 分层方案

```
ChatServiceImpl（RPC 适配层，保持薄）
   │  send / confirmTool
   ▼
ChatSession（会话逻辑，纯 TS，可单测）
   │  start / confirm / abort
   ▼
Agent（agent-core 引擎，上下文累积）
```

- **ChatSession** 新增于 `src/rpc/services/ChatSession.ts`，承接全部状态逻辑
- **ChatServiceImpl** 只做三件事：创建 RPC 流、注册 abort 钩子、把业务异常翻译为失败终局
- **Agent** 不改：引擎已支持 `run()` 多次调用、`onConfirm` 挂起回调、`abort()`

依赖装配不变（Composition Root 仍只 `new ChatServiceImpl(config, workspace, logger)`），
ChatSession 由 ChatServiceImpl 内部构造；Agent 工厂由 ChatServiceImpl 注入
（ChatSession 仅依赖类型契约，不直接 import agent-core 实现）。

---

## 3. 状态与数据结构

```ts
class ChatSession {
  private agent: Agent | null = null;
  /** Agent 创建时的配置/路径快照，用于判定是否需要重建 */
  private agentKey: string | null = null;
  /** 流进行中标记（同步置位，防同 tick 重入） */
  private busy = false;
  /** 上下文结构不完整：下次 start 必须重建 */
  private dirty = false;
  /** toolCallId → 决议函数 */
  private pendingConfirms = new Map<string, (ok: boolean) => void>();
  /** 本轮 assistant 声明、尚未回灌结果的工具调用 id */
  private openToolCalls = new Set<string>();
}
```

`agentKey` 由 `AgentConfig` 全字段 + 有效项目路径序列化而成；比较在 `start()` 同步完成。

---

## 4. 关键流程

### 4.1 start（一次 send）

```
start(message):
  1. busy === true            → throw ChatSessionBusyError
  2. 计算 agentKey
  3. dirty || key 变化 || 无实例 → 丢弃旧实例，new Agent(..., { logger, onConfirm })
  4. busy = true
  5. 返回包装生成器（见 4.2）
```

重建原因逐项记 info 日志（config-changed / project-changed / dirty / first）。

### 4.2 包装生成器（观察 + 兜底清理）

```
async *run(message):
  try:
    for await (逐帧转发 agent.run(message)):
      - message_complete → openToolCalls 重置为 message.toolCalls 的 id 集合
      - tool_call_result → openToolCalls.delete(id)
      - 其余事件原样 yield
  finally:
    busy = false
    settleConfirms(false)          // 未决议项按拒绝收口，防止生成器悬挂
    dirty ||= openToolCalls.size > 0
    openToolCalls.clear()
```

生成器返回值（`SendResult`）原样透传给 RPC 终局帧，不改变既有四态语义。

### 4.3 confirm（UI 决议）

```
onConfirm(toolCall) → new Promise(resolve => pendingConfirms.set(id, resolve))
confirmTool(id, ok):
  - 命中：删除 + resolve(ok)（first-wins）
  - 未命中（未知 / 已过期 / 重复）：warn 后忽略，不抛错
```

引擎在 `await onConfirm` 返回后先检查 `aborted`，再按决议分支，因此取消期间 settle 为
`false` 不会产生多余的拒绝结果事件。

### 4.4 abort（取消）

```
stream.onAbort → session.abort():
  agent.abort()          // 引擎置中断标记
  settleConfirms(false)  // 唤醒 await onConfirm，让生成器得以执行 finally
```

只调 `agent.abort()` 不够：生成器挂起在 `await onConfirm` 时，Router 的 `gen.return()`
无法立即完成，必须由会话先解除确认等待。

### 4.5 busy 拒绝

`send()` 同步捕获 `ChatSessionBusyError` 后，返回一个**立即失败的流**
（`createRpcStream()` 推模式 + `error({ code: 'chat.BUSY', ... })`），
而不是直接 throw：

- throw 会被 Router 包装成 `RPC_HANDLER_ERROR`，丢失业务码
- 立即失败的流让 UI 沿用既有 `onEnd(failed)` 分支展示错误，无需改渲染层

---

## 5. 决策记录

| # | 决策 | 取舍与理由 |
| --- | --- | --- |
| D1 | 会话状态集中到独立 `ChatSession` 类 | 与 RPC 适配解耦，纯 TS 可单测；不引入多会话管理器（单窗口单工作区） |
| D2 | Agent 实例复用，按配置/路径/脏标记重建 | 复用是上下文连续的唯一途径；重建条件显式可测 |
| D3 | 重建即丢弃历史 | 引擎无"改写历史消息"API；配置/项目变更后旧上下文本身已不适用 |
| D4 | 确认桥接采用"回调挂起 + 待决表" | 与引擎 `await onConfirm` 天然对齐，无需引擎挂起/外部回传的第二套机制 |
| D5 | 决议 first-wins，未知 id 静默 | 重复点击、迟到决议属预期噪声；抛错会打断 UI 正常收尾 |
| D6 | 取消时主动 settle 待决确认 | 否则生成器永久挂起、finally 不执行、busy 泄漏 |
| D7 | 忙锁在 `start()` 同步置位 | 异步生成器体内置位存在同 tick 重入窗口；同步检查 + 立即置位消除竞态 |
| D8 | 完整性判定基于事件观测（message_complete / tool_call_result） | 无需访问 Agent 私有上下文；未闭环集合非空即可判定"下次必须重建"，与终局类型无关 |
| D9 | busy 错误用立即失败流承载业务码 | 保留 `chat.*` 业务错误约定，UI 无需新增错误通道 |
| D10 | 注入 Agent 工厂（由 ChatServiceImpl 传入真实构造） | 仅服务于单测与包解耦；不引入 IoC 容器，不改变 Composition Root |

---

## 6. 竞态与边界

| 场景 | 处理 |
| --- | --- |
| 流结束瞬间再次 send | 生成器 finally 已复位 busy，新流正常开始 |
| 确认等待期间流被取消 | session.abort() settle(false) → 生成器 finally 清理 |
| 确认决议早于 `onConfirm` 注册 | 不可能：`tool_call_confirm` 事件先于 `await onConfirm` 发出，UI 收到事件后才可能决议 |
| 同一 toolCallId 重复决议 | first-wins，第二次 warn 忽略 |
| 渲染层在确认等待中刷新/失联 | 待决项只能由取消终局解除；属已知限制（见 spec 非目标） |
| tool_call_result 已发出但上下文回灌前被强制 return | 极窄窗口，观测已判为闭环；记为已知限制，待引擎侧修正消息顺序 |

---

## 7. 影响面

| 区域 | 变更 |
| --- | --- |
| `src/rpc/services/ChatSession.ts` | 新增 |
| `src/rpc/services/ChatServiceImpl.ts` | 改为委托会话；注入 onConfirm；confirmTool 落地；busy 失败流 |
| `src/rpc/services/index.ts` | 不变（装配签名不变） |
| `packages/electron-main/package.json` | test 脚本切换 Vitest，新增 devDependency |
| `vitest.config.ts` / `test/` | 新增（electron-main 首次引入单测） |
| contracts / agent-core / rpc / web | **零改动** |

---

## 8. 测试设计

新增 `test/rpc/services/ChatSession.test.ts`（镜像 `src/rpc/services/ChatSession.ts`），
通过构造参数注入伪 Agent 工厂（其 `run` 返回可控的异步生成器，`abort` 为 spy）：

1. 连续两次 `start` 复用同一 Agent（工厂仅调用一次）
2. 配置变更 → 重建
3. 项目路径变更 → 重建
4. 未闭环工具调用 → 下次 `start` 重建（dirty）
5. busy 期间 `start` 抛 `ChatSessionBusyError`，终局后可再次 `start`
6. `onConfirm` 挂起 → `confirm(id, true)` 放行、`false` 拒绝
7. 未知 / 重复 id 决议静默且 first-wins
8. `abort()` 调用 `agent.abort()` 并 settle 待决确认
9. 任意终局后待决表为空、busy 复位
10. 生成器返回值原样透传

`ChatServiceImpl` 因依赖 `@code-agent/rpc/main`（连带 electron 适配层）不做 Node 单测，
由 typecheck + Electron 手测覆盖；RPC 流终局语义已有 rpc 包测试保障。

---

## 9. 已知限制

- 重建即丢失会话历史（R2 触发时），UI 历史消息仍在，但模型不再拥有上文
- 无确认超时：渲染层失联时只能靠用户取消/关闭应用解除
- `ask_user` 仍不可用（需契约新增事件通道，另立变更）

---

## 10. 变更记录

- 2026-10-23：初版设计（P0：会话保持 + 确认门控）。
