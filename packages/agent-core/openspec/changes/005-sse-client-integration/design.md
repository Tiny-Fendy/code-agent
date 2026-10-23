# SSE Client 接入（Provider 三层拆分落地）- 设计方案 (design.md)

## 1. 核心设计决策

### D1：事件驱动 → AsyncGenerator 的内部桥接

**决策**：chat() 内部以 push-pull 队列适配 SSEClient 的事件 API，不引入第三方库，不改动公开签名。

**结构**：

```typescript
async *chat(params: ChatCompletionParams): AsyncGenerator<LLMEvent> {
  const client = new SSEClient({ url, method: 'POST', headers, body });
  const accumulator = new OpenAIAccumulator();

  // 内部桥接：事件 push 入队，生成器 pull 出队；done/error 推入终结哨兵
  const queue: Array<{ event?: LLMEvent; terminal?: 'done' | 'error'; error?: SSEClientError }> = [];
  let notify: (() => void) | null = null;
  const push = (item: (typeof queue)[number]) => {
    queue.push(item);
    notify?.();
  };

  client.on('data', (chunk) => {
    // chunk 即 OpenAIStreamChunk（库已 JSON.parse）
    // → 翻译为 text_delta / tool_call_delta 事件 push 入队
  });
  client.on('done', ({ reason }) => push({ terminal: 'done' }));
  client.on('error', (err) => push({ terminal: 'error', error: err }));

  client.start();
  try {
    while (true) {
      while (queue.length === 0) {
        await new Promise<void>((resolve) => { notify = resolve; });
      }
      const item = queue.shift()!;
      if (item.terminal === 'error') {
        yield { type: LLMEventType.Error, data: { message: mapError(item.error!) } };
        return;
      }
      if (item.terminal === 'done') {
        // 兜底：流异常结束（无 [DONE]）但有累积内容时仍产出 MessageComplete
        if (accumulator.hasContent()) {
          yield { type: LLMEventType.MessageComplete, data: { message: accumulator.buildMessage() } };
        }
        return;
      }
      yield item.event!;
    }
  } finally {
    client.abort(); // 生成器提前终止（break/Agent abort）时释放连接；closed 态为 no-op
  }
}
```

**理由**：
- 库的事件 API 与生成器的 pull 模型天然错位，桥接是必要适配层；队列 + 单等待者模式是最小实现（同一时刻至多一个挂起的 await，无并发订阅）
- 桥接代码完全内聚在 chat() 内部，Agent 引擎与 LLMProvider 抽象零感知

### D2：OpenAIAccumulator 接口

**决策**：Accumulator 接收 delta 片段（而非完整 chunk），产出两类结果。

```typescript
export class OpenAIAccumulator {
  /** 累积 content 增量，返回非空增量（供 text_delta 事件；无增量返回 null） */
  pushContent(delta: string | undefined): string | null;

  /** 累积 tool_calls 增量，返回累积中的部分 toolCalls（供 tool_call_delta 事件） */
  pushToolCalls(deltas: OpenAIStreamToolCall[] | undefined): PartialToolCall[] | null;

  /** 是否有任何累积内容（content 非空或存在有效 toolCall） */
  hasContent(): boolean;

  /** 流末构建完整 ChatMessage：arguments 统一 JSON.parse，失败保留 { _raw } fallback */
  buildMessage(): ChatMessage;
}
```

- `PartialToolCall` 即现有 AccumulatedToolCall 结构（id/name/arguments 原始字符串），从 OpenAICompatible.ts 迁移到 Accumulator 文件
- `buildMessage()` 平移现有 `buildCompleteMessage` 逻辑（过滤无 name 的不完整项、JSON.parse 失败 `_raw` 兜底）
- **理由**：Accumulator 只依赖 delta 结构不认识 chunk，职责单一、可纯单测；chat() 的流循环中不再出现索引归位、字符串拼接等有状态逻辑

### D3：chunk 翻译归属 chat() 编排层

**决策**：`chunk.choices[0].delta` 的结构解读留在 chat()（或其私有辅助），不进入 Accumulator。

```
data(chunk) → choices[0].delta → ┬─ delta.content      → accumulator.pushContent → text_delta
                                 └─ delta.tool_calls   → accumulator.pushToolCalls → tool_call_delta
```

**理由**：choices 数组、delta 双分支是 OpenAI 协议形状，属于「协议层 → 业务层」的翻译；Accumulator 只关心累积语义。与 llm-provider.md §3 职责表一致。

### D4：错误映射

**决策**：SSEClientError → LLMEvent(error)，message 统一前缀错误分类。

```typescript
function mapError(err: SSEClientError): string {
  return `[${err.type}] ${err.message}`;
}
// 示例：[timeout] Read timeout / [http] HTTP 429: rate limited / [parse] JSON parse failed: ...
```

**理由**：
- LLMEvent(error) 的 data 只有 message 字段（结构不变），分类信息以前缀保留，UI/日志可辨
- http 错误的 message 库内已含状态码与响应文本，信息不丢失
- retryable 不透出：LLMEvent 结构不变；重试决策未来若做，在 Agent/Provider 层另行设计

### D5：严格解析的行为变化对齐

**决策**：接受库的严格策略，畸形 data 行从「静默跳过」变为「error 终结」，不保留旧的宽容行为。

**理由**：
- 旧行为会静默吞掉协议异常（如服务端返回非 JSON 的错误页混入流），问题被掩盖
- OpenAI 系端点正常响应的 data 必为 JSON，严格策略的误伤面仅覆盖已损坏的流
- 与 fetch-sse-client 设计决策（对标 openai-node 行为一致）对齐，不在 Provider 层重新开口子

### D6：超时不显式配置，reconnect 保持关闭

**决策**：SSEClient 构造不传 timeouts（用库默认 connect 10s / read 30s / total 0），不传 reconnect。

**理由**：
- read 30s 是「相邻 chunk 最大间隔」，覆盖 LLM 正常流式生成；长推理模型若触发可调优，届时以 Provider 选项增量引入
- LLM 请求重放有计费/副作用风险，自动重连必须显式评估（fetch-sse-client 决策表同此结论），本期不开放

## 2. 模块结构

| 文件 | 变更 |
|------|------|
| `src/llm/OpenAICompatible.ts` | 改造：chat() 三层编排，删除内联 SSE 解析与累积逻辑 |
| `src/llm/OpenAIAccumulator.ts` | 新增：累积类 + PartialToolCall 类型 |
| `src/llm/openai-types.ts` | 不动 |
| `package.json` | dependencies 新增 `fetch-sse-client: workspace:*` |
| `test/llm/OpenAIAccumulator.test.ts` | 新增：纯单测 |
| `test/llm/OpenAICompatible.test.ts` | 新增：stubGlobal fetch 的集成测试 |

## 3. 边界情况

| 场景 | 处理 |
|------|------|
| 流异常结束（reader done，无 [DONE]）有累积 | done complete → MessageComplete 兜底产出 |
| 流异常结束且无累积 | done complete → 直接 return，无事件（同现状） |
| 畸形 data 行 | 库抛 parse 错误 → error 事件终结（行为变化，测试锁定） |
| 首个 chunk 前 HTTP 非 2xx | 库抛 http 错误（message 含状态码+响应文本）→ error 事件 |
| 连接/读取超时 | 库抛 timeout 错误 → error 事件 |
| 生成器被提前 break | finally client.abort() 释放连接 |
| done 与 error 并发 | 库保证互斥且只发一次，桥接层无竞态 |
| choices 为空 / delta 无 content 无 tool_calls | 跳过该 chunk，无事件产出（同现状） |

## 4. 与现有机制的关系

- **Agent 引擎**：chat() 签名与事件语义不变，Agent.run() 消费零改动
- **上下文压缩**：压缩请求同样走 chat()，自动获得超时与严格解析能力
- **mock-provider**：MockProvider 不走网络，不受影响

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 严格解析使部分容错场景变为终结错误 | 设计决策（D5）明示；测试锁定新行为；真实 OpenAI 系端点 data 恒为 JSON |
| read 30s 默认值对慢推理模型偏紧 | 间隔超时而非总时长，正常流式生成不会触发；触发后以 Provider 选项调优（后续迭代） |
| 桥接层队列内存累积（消费慢于产出） | LLM 场景 Agent 逐事件消费，速率匹配；队列无界但事件体积极小，风险可忽略 |
| workspace 依赖构建顺序 | pnpm 按拓扑序构建，fetch-sse-client 先于 agent-core，无需额外编排 |
