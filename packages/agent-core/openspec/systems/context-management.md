# 上下文管理子系统（ContextManager）

> 本文档是上下文管理子系统的**持续性设计文档**，随代码演进同步更新。
> 单次变更的需求规格、设计与任务见 `openspec/changes/<change-id>/`。

## 1. 定位

ContextManager 是 Agent "记忆"的载体，负责维护 ReAct 循环的对话历史。它是一个**纯数据结构**：

- 不依赖 LLM（摘要生成由 Agent 编排）
- 不依赖具体 Provider 协议（只操作 `ChatMessage`）
- 可独立测试

## 2. 职责边界

| 职责 | 归属 | 说明 |
|------|------|------|
| 消息存储与增删查 | ContextManager | system / user / assistant / tool 四类消息 |
| Token 估算 | ContextManager | 中英分桶估算（见 §5） |
| 工具结果入口截断 | ContextManager | `addMessage` 时自动执行，Agent 无感知 |
| 分区与切点计算 | ContextManager | `getCompactableRange()` / `compact()` |
| 压缩触发与摘要生成 | **Agent** | Agent 有 LLM 访问能力，负责编排 |
| 压缩事件通知 | **Agent** | yield `context_compact` 事件给 UI |

## 3. 两层压缩机制

### 3.1 第一层：工具结果入口截断（无 LLM）

- 时机：`addMessage()` 时，仅对 `role='tool'` 的消息生效
- 策略：超过上限（默认 4000 字符）→ 保留**头部 2/3 + 尾部 1/3**，中间插入 `...[已截断 N 字符]...`
- 理由：头部通常是报错开头/内容起始（重要），尾部通常是退出码、汇总信息（重要），中间是冗余主体

### 3.2 第二层：compact 摘要压缩（Agent 编排）

分区模型（参考 Claude Code 分代 GC）：

```
[ system 永不裁剪 ][ 摘要区：较早轮次 → 被替换 ][ 最近轮次：全保真保留 ]
                          │  ↑
                          ▼  │
                    LLM 结构化摘要（替换为一条 user 摘要消息）
```

执行流程（在 `Agent.run()` 每轮循环开头检查）：

1. `shouldCompact()`：token > `maxTokens × 0.8` → 触发
2. Agent 取 `getCompactableRange()` 切片，发给 LLM 用结构化摘要提示词压缩
3. `cm.compact(summary)`：摘要区替换为一条 `role='user'` 消息，content 前缀 `[历史摘要]`
4. Agent yield `context_compact` 事件（data: `{ before, after }`）

摘要提示词结构（参考 OpenHands）：用户目标 / 已完成的工作及结果 / 关键文件与代码位置 / 重要决策与约束 / 待办事项。要求保留具体路径、命令、报错等可复用细节，输出限长。

## 4. 关键规则

| 规则 | 内容 |
|------|------|
| system 永不裁剪 | 根集，任何裁剪操作不得触及 |
| 切点安全 | 切点不得落在 `tool` 消息上；若落上则前移到其 assistant 父消息——**不得拆散 assistant(toolCalls) ↔ tool 消息对**（Function Calling 协议约束） |
| 防抖 | 触发阈值 80%，压缩目标 ≤ 50%，避免在阈值附近反复触发 |
| 摘要限长 | 摘要输出 ≤ 800 token，防止摘要本身撑爆窗口 |
| 单消息超窗 | 已知限制：单条超大消息（如用户粘贴巨文）v1 不处理，靠工具结果截断兜底 |

## 5. Token 估算

中英分桶估算，修复早期单一 `/3` 对中文的低估问题：

```
tokens ≈ CJK字符数 / 1.5 + 非CJK字符数 / 4
```

后续可接入 tiktoken 精确计算（非目标，见 §8）。

## 6. 接口清单

```typescript
class ContextManager {
  constructor(maxTokens?: number, toolResultLimit?: number)  // 默认 8000 / 4000
  addMessage(message: ChatMessage): void   // tool 结果自动截断
  getMessages(): ChatMessage[]
  getMessageCount(): number
  getLastMessage(): ChatMessage | null
  clear(): void
  getTokenCount(): number                  // 中英分桶估算
  setMaxTokens(maxTokens: number): void
  shouldCompact(): boolean                 // token > maxTokens × 0.8
  getCompactableRange(): ChatMessage[]     // 摘要区切片（切点算法在此）
  compact(summary: string): void           // 应用压缩，摘要区替换为一条 user 消息
  estimateAfterCompact(summary): number    // 预估压缩后 token（调用方防御判断用）
  getCompactThreshold(): number            // 当前触发阈值（maxTokens × 0.8）
}
```

`clear()` 后由 Agent 重新写入 system prompt（现有行为保持）。

## 7. 参数默认值

| 参数 | 默认值 | 说明 |
|------|--------|------|
| maxTokens | 8000 | 上下文预算，AgentConfig.contextTokens 透传 |
| compact 触发阈值 | 0.8 | `maxTokens × 0.8` |
| compact 目标水位 | 0.5 | 压缩后应低于此水位 |
| 尾部保留预算 | maxTokens × 25% | 按预算从尾部向前找切点 |
| 工具结果截断上限 | 4000 字符 | 头 2/3 + 尾 1/3 |
| 摘要限长 | 800 token | 提示词内约束 |

## 8. 非目标（当前版本不做）

- tiktoken 精确计数
- 跨会话持久记忆 / 向量检索 / 分级记忆（MemGPT 式）
- 服务端 compaction（Claude context editing API 式）
- 用户消息超长截断

## 9. 变更记录

| 日期 | 变更 | 关联 change |
|------|------|------------|
| 2026-10-14 | 初版设计：两层压缩机制（入口截断 + compact 摘要）、分区模型、切点安全规则 | `changes/002-context-compaction/` |
| 2026-10-14 | Tasks 1-6 全部落地并通过端到端验证：分桶估算、入口截断、分区/切点/compact、`context_compact` 事件、Agent 编排接入（`maybeCompactContext()`，摘要限 800 token、失败跳过不中断） | `changes/002-context-compaction/` |
