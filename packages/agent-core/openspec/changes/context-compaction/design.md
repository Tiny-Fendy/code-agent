# 上下文压缩与裁剪 - 设计文档 (design.md)

> 本次变更的设计决策记录。落地后的稳定形态见 `../../systems/context-management.md`。

## 1. 业界参考

| 项目 | 机制 | 借鉴点 |
|------|------|--------|
| Claude Code | 分代 GC：根集（system/CLAUDE.md/最近用户消息）永不回收，老消息晋升为摘要 | 分区模型、根集概念、自动触发 |
| OpenHands | LLMSummarizingCondenser：保留头部 + 摘要化中部 + 保留尾部 | 摘要提示词结构（目标/进展/待办） |
| agent-sh | 工具输出 head+tail 截断，保护最近 N token 工具输出 | 保头保尾的截断策略 |

## 2. 方案选型

### 2.1 为什么是"两层机制"而不是单层

- 只做摘要压缩：单条 20KB 的 read_file 结果也要等触发阈值才处理，且摘要它浪费一次 LLM 调用——入口截断在写入时就消灭了 90% 的膨胀源
- 只做入口截断：消息条数本身也会累积（几十轮 ReAct 循环），必须有摘要层兜底
- 两层正交：截断在 ContextManager 内部无感知完成，摘要有感知、有事件、可观察

### 2.2 为什么摘要由 Agent 编排而不是 ContextManager 内聚

- ContextManager 保持纯数据结构（不依赖 LLM Provider），可独立测试
- Agent 已持有 llm 实例，复用零成本；摘要请求与 ReAct 循环共享 abort/错误处理路径
- 与本包「依赖注入、Agent 只调度」的既有架构约定一致

### 2.3 摘要消息为什么用 role='user'

- 部分 OpenAI 兼容端点对 assistant 开头的消息序列有兼容性怪癖，user 最安全
- content 前缀 `[历史摘要]` 显式标识来源，避免 LLM 误认为是用户新指令

### 2.4 尾部保留策略：按 token 预算而非固定条数

消息大小悬殊（一条 tool 结果可能是一条 user 消息的 50 倍），固定条数会导致尾部水位不可控。按预算（maxTokens × 25%）从尾部向前累加确定切点，水位可控。

## 3. 切点算法（核心难点）

```
输入：messages[]（已排除 system）
1. 从尾部向前累加消息 token，直到预算（maxTokens × 25%）用尽 → 得到候选切点 i
2. 若 messages[i].role === 'tool'：向前回溯到其 assistant 父消息（该 assistant 的 toolCalls 包含此 toolCallId）
3. 返回切点 i（getCompactableRange() = system 之后到 i 之前的消息）
```

不变式：**切点位置的消息 role ∈ {user, assistant}**，且 assistant 消息若带 toolCalls，其全部 tool 响应必须在切点同一侧（回溯天然保证）。

## 4. 防抖设计

- 触发：token > 80% → 压缩至 ≤ 50%
- 若摘要生成后应用仍 ≥ 80%（摘要本身超长）：跳过应用，yield `context_compact` 事件（after === before 表明未生效）？——否，未应用则不发事件，下轮重新尝试。避免 UI 收到无效事件
- 压缩是 await 的，期间 abort 检查点在循环顶部天然生效

## 5. 接口变更

### ContextManager（新增/修改）

```typescript
addMessage(message: ChatMessage): void      // 修改：tool 结果自动截断
shouldCompact(): boolean                    // 新增
getCompactableRange(): ChatMessage[]        // 新增：摘要区切片
compact(summary: string): void              // 新增：应用压缩
private estimateTokens(content: string): number  // 重构：中英分桶
```

### Agent

```typescript
constructor(config, projectPath, onConfirm?)  // 不变
// run() 循环开头新增：
//   if (cm.shouldCompact()) → summarize(range) → cm.compact() → yield context_compact
// 摘要复用 this.llm.chat()（不传 tools，maxTokens 限制 800）
```

### shared

```typescript
AgentEvent 新增：{ type: 'context_compact'; data: { before: number; after: number } }
AgentConfig 新增：contextTokens?: number
```

## 6. 边界情况

| 场景 | 处理 |
|------|------|
| 摘要区为空（只有 system + 尾部一条） | shouldCompact 为 false 不会触发；防御性返回空切片，Agent 跳过压缩 |
| 历史中无 user 消息（纯工具循环） | 切点规则不依赖 user 边界，assistant/tool 对完整即可 |
| tool 消息被截断后 LLM 需要完整内容 | Agent 可重新调用工具获取（截断提示中已说明被截断） |
| 压缩期间用户 abort | await 返回后循环顶部检查 aborted，正常退出；摘要已生成但未应用则丢弃 |

## 7. 测试策略

- 单测：token 估算（中/英/混合）、截断（未超限/超限/恰好边界）、切点（正常/tool 边界回溯/预算为 0）
- 集成：mock LLM 长对话 → 触发压缩 → 验证消息数组形态（system + 摘要 + 尾部）、协议完整性（无孤儿 tool 消息）、事件顺序

## 8. 风险

- 摘要质量依赖模型能力：弱模型可能丢细节 → 提示词强调保留路径/命令/报错；可接受，后续可加"摘要 + 关键消息原文保留"策略
- token 估算仍有误差 → 阈值留了 20% 余量，防抖目标再留 30%，双重缓冲
