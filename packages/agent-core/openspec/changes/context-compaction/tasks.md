# 上下文压缩与裁剪 - 任务拆解 (tasks.md)

## 开发顺序说明

按照"从数据层到编排层"的顺序开发：

1. **数据层**：token 估算修复 → 入口截断 → 分区/切点/compact
2. **协议层**：shared 新事件类型
3. **编排层**：Agent 接入压缩流程
4. **验证**：单测 + mock LLM 端到端

---

## Task 1: Token 估算修复（中英分桶）

**优先级**：P0
**预估工作量**：小

**任务内容**：
- [x] 重构 `ContextManager.getTokenCount()` 为分桶估算：`CJK字符数 / 1.5 + 非CJK字符数 / 4`
- [x] 抽出 `estimateTokens(content: string)` 私有方法供各处复用
- [x] 单元测试：纯中文 / 纯英文 / 混合 / toolCalls 计入

**验收标准**：
- 纯中文 3000 字估算 ≈ 2000 token（旧算法只算 1000，低估 50%）
- 纯英文 4000 字符估算 ≈ 1000 token
- 与旧实现相比，中文场景不再低估

---

## Task 2: 工具结果入口截断

**优先级**：P0
**预估工作量**：小

**任务内容**：
- [x] `addMessage()` 对 `role='tool'` 消息执行截断
- [x] 截断策略：上限 4000 字符，保留头 2/3 + 尾 1/3，中间插入 `...[已截断 N 字符]...`
- [x] 截断上限可通过构造参数配置
- [x] 单元测试：未超限原样保留 / 超限截断 / 恰好等于上限不截断 / user 消息不截断

**验收标准**：
- 超长 tool 结果写入后 content 长度 ≤ 上限 + 截断提示长度
- 截断提示中 N 为实际移除的字符数
- 非 tool 消息不受影响

---

## Task 3: 分区、切点与 compact

**优先级**：P0
**预估工作量**：中（本变更核心）

**任务内容**：
- [x] 实现 `shouldCompact()`：`getTokenCount() > maxTokens × 0.8`
- [x] 实现 `getCompactableRange()`：
  - 从尾部按预算（maxTokens × 25%）向前累加确定候选切点
  - 切点为 `tool` 消息时回溯到其 assistant 父消息
  - 返回 system 之后、切点之前的消息切片
- [x] 实现 `compact(summary)`：摘要区替换为一条 `role='user'` 消息（content 前缀 `[历史摘要]`）
- [x] 防御：compact 后仍超触发阈值时由调用方决定跳过（ContextManager 不做该判断）
- [x] 单元测试：
  - 切点落在 user/assistant 消息上
  - 切点算出 tool 消息时正确回溯
  - system 永远保留
  - compact 后消息数组形态正确（system + 摘要 + 尾部）
  - assistant(toolCalls) ↔ tool 消息对始终同侧

**验收标准**：
- 任何消息序列下切点不产生孤儿 tool 消息
- compact 后 `getTokenCount()` 下降
- 原始消息引用不被外部修改（getCompactableRange 返回副本或只读使用）

---

## Task 4: shared 事件与配置

**优先级**：P0
**预估工作量**：小

**任务内容**：
- [x] `AgentEvent` 新增 `{ type: 'context_compact'; data: { before: number; after: number } }`
- [x] `AgentEventType` 加入 `'context_compact'`
- [x] `AgentConfig` 新增可选字段 `contextTokens?: number`
- [x] 重建 shared

**验收标准**：
- typecheck 通过，事件联合类型完整

---

## Task 5: Agent 编排接入

**优先级**：P0
**预估工作量**：中

**任务内容**：
- [x] Agent 构造时将 `config.contextTokens` 透传给 ContextManager
- [x] `run()` 每轮循环开头（callLLM 之前）：
  - `shouldCompact()` 为 true → 取 `getCompactableRange()` 切片
  - 调 `this.llm.chat()` 生成结构化摘要（不传 tools，maxTokens 800，提示词覆盖目标/进展/文件/决策/待办五段式）
  - 压缩后预估仍超触发阈值 → 跳过应用
  - 应用 `compact(summary)` → yield `context_compact` 事件（before/after）
- [x] 摘要请求失败（网络/模型错误）→ 跳过本轮压缩，继续正常循环（不中断任务）
- [x] 更新 Agent.ts 头部事件流注释

**验收标准**：
- 压缩触发时事件流出现 `context_compact`
- 压缩失败不影响任务继续
- abort 在压缩期间生效（循环顶部检查）

---

## Task 6: 端到端验证

**优先级**：P0
**预估工作量**：中

**任务内容**：
- [x] mock LLM 服务：可指定每轮响应（工具调用轮 / 摘要轮 / 最终回答轮）
- [x] 场景 1：长对话触发压缩 → 消息数组形态 = system + [历史摘要] + 尾部轮次，无孤儿 tool 消息
- [x] 场景 2：切点回溯（尾部为 tool 消息的场景）——单测已覆盖回溯逻辑，端到端验证消息对完整性（无孤儿 tool）
- [x] 场景 3：超长工具结果被入口截断（通过压缩请求 transcript 验证存储形态）
- [x] 场景 4：压缩后事件 `context_compact` 的 before/after 数值合理（after < before，after ≤ 50% 水位）
- [x] 清理临时测试文件

**验收结果**：17 项断言全部通过（真实 Agent + 真实 run_command 工具 + mock SSE 服务）

**验收标准**：
- 全部场景断言通过
- typecheck + build 通过

---

## 依赖关系图

```
Task 1 (token估算) ──→ Task 2 (入口截断) ──→ Task 3 (分区/切点/compact) ──→ Task 5 (Agent编排) ──→ Task 6 (端到端)
                                                                Task 4 (shared类型) ────────┘
```

- Task 1 → 2 → 3 顺序执行（同一文件，避免冲突）
- Task 4 可与 Task 1-3 并行
- Task 5 依赖 Task 3 + 4
- Task 6 依赖 Task 5

---

## 文档同步

- [ ] 实现完成后核对 `openspec/systems/context-management.md` 与实际代码一致（接口签名、默认参数）
