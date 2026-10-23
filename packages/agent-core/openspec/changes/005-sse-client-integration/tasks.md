# SSE Client 接入（Provider 三层拆分落地）- 任务清单 (tasks.md)

## 任务拆解

### Task 1：依赖接入

**优先级**：P0
**预估工作量**：小

- [x] `packages/agent-core/package.json` dependencies 新增 `"fetch-sse-client": "workspace:*"`
- [x] `pnpm install` 链接 workspace 依赖
- [x] 验证 agent-core `typecheck` / `build` 通过（pnpm 拓扑序保证 fetch-sse-client 先构建）

**验收标准**：
- agent-core 可正常 `import { SSEClient } from 'fetch-sse-client'`
- 构建与类型检查通过

---

### Task 2：OpenAIAccumulator 抽离

**优先级**：P0
**预估工作量**：中

- [x] 新建 `src/llm/OpenAIAccumulator.ts`
- [x] 平移 OpenAICompatible.ts 中的 AccumulatedToolCall 接口（更名 PartialToolCall 并导出）
- [x] 实现 pushContent / pushToolCalls / hasContent / buildMessage
- [x] 平移 buildCompleteMessage 逻辑（过滤无 name 项、arguments JSON.parse、失败 `_raw` fallback）
- [x] 新建 `test/llm/OpenAIAccumulator.test.ts`（设计驱动，与 src 镜像）

**测试用例覆盖**：
- content 逐段累积，空增量返回 null
- tool_calls 按 index 归位（含乱序/跳 index 场景）
- id/name 后到补齐、arguments 逐段拼接
- pushToolCalls 返回部分 toolCalls（arguments 原始字符串）
- buildMessage：纯 content / content+toolCalls / 仅 toolCalls
- buildMessage：arguments 非法 JSON → `{ _raw }` fallback
- buildMessage：无 name 的不完整项被过滤
- hasContent 判定

**验收标准**：
- Accumulator 单测全部通过
- 不依赖 chunk 结构（仅接收 delta 片段）

---

### Task 3：chat() 三层编排改造

**优先级**：P0
**预估工作量**：中

- [x] 改造 `src/llm/OpenAICompatible.ts` chat()
- [x] 请求组装逻辑保持现状（URL / headers / body 映射不变）
- [x] 内部创建 SSEClient（不传 timeouts / reconnect，用库默认）
- [x] 实现 push-pull 队列桥接（事件入队、done/error 终结哨兵、单等待者 notify）
- [x] data → OpenAIStreamChunk → choices[0].delta 翻译：content 分支 → text_delta；tool_calls 分支 → tool_call_delta
- [x] done complete → hasContent() 为真时产出 MessageComplete 兜底
- [x] error → LLMEvent(error)，message 为 `[${type}] ${message}` 格式
- [x] finally 中 client.abort() 释放连接
- [x] 删除全部内联解析代码（reader/decoder/buffer/`data: `/`[DONE]`/内联累积）
- [x] 更新文件头注释为三层架构描述

**验收标准**：
- chat() 中无 SSE 解析残留代码
- LLMEvent 产出语义与现状一致（除严格解析差异外）
- typecheck / build 通过

---

### Task 4：chat() 集成测试

**优先级**：P0
**预估工作量**：中

- [x] 新建 `test/llm/OpenAICompatible.test.ts`
- [x] `vi.stubGlobal('fetch', ...)` 桩全局 fetch，构造 SSE 流式响应
- [x] 用例覆盖：
  - 正常文本流：多 chunk content → text_delta 序列 + message_complete（content 正确拼接）
  - 工具调用流：tool_calls 增量 → tool_call_delta（部分参数）+ message_complete（完整 arguments 已 parse）
  - content 与 tool_calls 混合流
  - `[DONE]` 哨兵：库消化，message_complete 正常产出
  - 流异常结束（无 [DONE]）有累积 → message_complete 兜底
  - 流异常结束无累积 → 无 message_complete
  - HTTP 非 2xx（如 401）→ error 事件（message 含 `[http]` 前缀与状态码）
  - fetch 拒绝 → error 事件（`[network]` 前缀）
  - 畸形 data 行 → error 事件（`[parse]` 前缀，严格解析行为锁定）
  - choices 为空 / delta 无内容的 chunk → 跳过无事件
  - 生成器提前 break → fetch 的 abort 信号被触发（连接释放）

**验收标准**：
- 集成测试全部通过
- agent-core 全量测试无回归

---

### Task 5：文档同步

**优先级**：P1
**预估工作量**：小

- [x] 更新 `openspec/systems/llm-provider.md` §6 实施状态（勾选 Accumulator 抽离、chat() 改造两项）
- [x] llm-provider.md §7 变更记录补录本次条目（关联 sse-client-integration）
- [x] 勾选本 tasks.md 全部任务

**验收标准**：
- 文档与代码实态一致

---

## 依赖关系

```
Task 1 (依赖接入) ──→ Task 3 (chat 改造) ──→ Task 4 (集成测试)
Task 2 (Accumulator) ──┘        ↑
                                 │
Task 5 (文档) 最后执行 ──────────┘
```

- Task 1 与 Task 2 可并行
- Task 3 依赖 Task 1（import SSEClient）与 Task 2（复用 Accumulator）
- Task 4 依赖 Task 3
- Task 5 最后执行

## 关联文档

- 需求规格：`openspec/changes/005-sse-client-integration/spec.md`
- 设计方案：`openspec/changes/005-sse-client-integration/design.md`
- 子系统设计：`openspec/systems/llm-provider.md`（三层架构已定稿，本次落地剩余两项）
- 网络层设计：`libs/fetch-sse-client/openspec/systems/fetch-sse-client.md`
