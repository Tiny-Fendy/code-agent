# LLM 接入（Provider 抽象与三层拆分）

> 本文档是 LLM 接入子系统的**持续性设计文档**，随代码演进同步更新。
> 单次需求变更走 `openspec/changes/`（spec / design / tasks / check）。

## 1. 定位

LLM 接入层负责与模型服务通信：组装聊天补全请求、消费 SSE 流式响应、把协议层数据翻译为 LLM 层事件（LLMEvent），供 Agent 引擎消费。当前唯一实现是 OpenAICompatibleProvider，覆盖 OpenAI 官方、DeepSeek、Moonshot 及 vLLM / Ollama 等遵循 `/chat/completions` 流式协议的服务。

## 2. 三层架构

LLM 接入按职责拆为三层，网络与业务严格分离：

```
┌─────────────────────────────────────────────────────────┐
│ chat() 编排层（OpenAICompatibleProvider）                │
│   组装请求体 → 驱动 SSEClient → 把数据翻译为 LLMEvent     │
├─────────────────────────────────────────────────────────┤
│ 业务状态累积层（OpenAIAccumulator）                      │
│   tool_calls 按 index 累积、arguments 增量 JSON 拼接、    │
│   流末组装完整 ChatMessage                               │
├─────────────────────────────────────────────────────────┤
│ 网络协议层（fetch-sse-client 包，libs/fetch-sse-client） │
│   HTTP + SSE 解析 + JSON 解析 + [DONE] 哨兵 + 超时/取消  │
└─────────────────────────────────────────────────────────┘
```

## 3. 职责边界

| 职责 | 归属 | 说明 |
|------|------|------|
| 请求体组装（model/messages/tools/temperature） | Provider.chat() | ToolDefinition → OpenAI function schema 的映射在此完成 |
| SSE 传输、解析、超时、取消 | fetch-sse-client | 见 libs/fetch-sse-client/openspec/systems/fetch-sse-client.md |
| `[DONE]` 哨兵处理 | fetch-sse-client | 库内消化，Provider 收到的 done 即流终结 |
| chunk.choices[0].delta 结构解读 | Provider.chat() | content / tool_calls 分支判断 |
| tool_calls 增量累积 | OpenAIAccumulator | 按 index 归位，arguments 逐段拼接，流末统一 JSON.parse |
| LLMEvent 产出 | Provider.chat() | text_delta / tool_call_delta / message_complete / error |

## 4. 事件模型（LLMEvent）

| 事件 | 时机 |
|------|------|
| text_delta | content 增量到达 |
| tool_call_delta | tool_calls 增量到达（携带累积中的部分参数，供 UI 实时展示） |
| message_complete | 一条 assistant 消息组装完成（content + 完整 toolCalls） |
| error | 网络 / 超时 / HTTP / 解析失败（由 SSEClientError 映射） |

chat() 以 AsyncGenerator\<LLMEvent\> 产出事件，最后一定以 message_complete 或 error 收尾。该签名保持不变——三层拆分只改内部实现，不改对 Agent 的接口。

## 5. 关键设计决策

| 决策 | 理由 |
|------|------|
| SSE 传输独立为 fetch-sse-client 包 | 网络协议层与业务协议层解耦；作为开源产出物独立演进；Provider 不再内联手写 reader/decoder/buffer 逻辑 |
| tool_calls 累积独立为 OpenAIAccumulator 类 | arguments 增量拼接是有状态业务逻辑，从 chat() 的流循环中抽出后可独立单测；chat() 只留编排 |
| chat() 保持 AsyncGenerator\<LLMEvent\> 签名 | Agent 引擎的消费方式不变；SSEClient 的事件驱动 API 在 Provider 内部适配为生成器 |
| Provider 构造时固定为 OpenAICompatible，不抽象注入 | 当前只有一种协议，等出现第二种再抽象（Agent 引擎文档已记录此决策） |
| 协议层原始类型（OpenAIStreamChunk 等）独立存放 openai-types.ts | 避免实现文件内联匿名嵌套类型，保持接口结构清晰可复用 |
| 错误以 LLMEvent(error) 事件产出而非抛出 | 与 Agent 引擎的事件流消费模型对齐；SSEClientError 的 type/status 映射进 error message |
| Mock 切换点收在 chat() 入口，不开放 Provider 注入 | Mock 是开发态工具而非正式功能，不值得动公共 API；Agent / 调用方零改动，外部零感知（见 §6） |

## 6. MockProvider（开发态剧本驱动）

定位：开发态工具而非正式功能，用于半流程验证（除 LLM 外的全链路：工具链、确认流、压缩、finish）与问题复现，不消耗 token。

关键设计（详见 `openspec/changes/004-mock-provider/design.md`）：

- **外部零感知**：`chat()` 入口 `if (mockEnabled()) { yield* mockStream(params); return; }` 薄委托，Agent / contracts / 调用方零改动；未来三层重构后委托仍位于编排层入口，不冲突
- **事件同构硬约束**：Mock 合成的事件 data 形状与真实 Provider 输出逐字段对齐（TextDelta 分块、ToolCallDelta 累积形状、MessageComplete 完整消息），保证 Agent 全链路被真实驱动
- **双入口与优先级**：显式 `setMockProvider()`（动态剧本全能力，函数条目可检查 `params.messages` 做有状态剧本）> 环境变量 `CODE_AGENT_MOCK_SCRIPT`（JSON 静态剧本，首次调用惰性加载）> 关闭
- **fail-loud**：env 配置失败进入错误态单例反复报错，绝不静默回退真实 LLM；剧本耗尽默认 Error 事件显式暴露（可选 loop 重复最后一条）
- **测试隔离**：`clearMockProvider()` 清除全部 mock 状态（含 env 惰性缓存）；`calls` 记录收到的全部请求供断言

## 7. 实施状态

- [x] 协议层类型独立（openai-types.ts）
- [x] fetch-sse-client 独立成包（libs/fetch-sse-client，API v2 定稿）
- [x] MockProvider 与切换机制落地（§6）
- [x] OpenAIAccumulator 类抽离
- [x] Provider.chat() 改造为三层编排（删除内联 SSE 解析；mock 委托保留在编排层入口）

## 8. 已知限制与非目标

- 严格解析策略：畸形 data 行以 error 事件终结流（对齐 fetch-sse-client），不做静默跳过
- 未开放 reconnect / 自定义超时配置（库默认 connect 10s / read 30s / total 0；重放语义敏感，开放前需单独评估）
- 未实现重试、限流、token 用量统计
- 仅支持 OpenAI 兼容流式协议（`/chat/completions` + SSE）
- Mock 不做录制/回放、不模拟 token 用量

## 9. 变更记录

| 日期 | 变更 | 关联 change |
|------|------|------------|
| 2026-10-16 | 协议层类型独立：SSEChunk 等内联类型提取至 openai-types.ts，AccumulatedToolCall 接口抽离 | — |
| 2026-10-17 | 三层拆分方案定稿：fetch-sse-client API v2（类 + 事件驱动）设计完成；本文档补录，填掉 systems README 中"LLM 接入—待记录"占位 | libs/fetch-sse-client API 重设计讨论 |
| 2026-10-18 | MockProvider 落地：剧本驱动 + 双入口切换（chat() 入口委托），新增 §6 MockProvider 与已知限制小节 | mock-provider |
| 2026-10-19 | 三层拆分落地：chat() 接入 SSEClient（push-pull 队列桥接）、OpenAIAccumulator 独立成类；畸形 data 从静默跳过改为 error 终结，新增超时能力；错误 message 统一 `[type]` 前缀 | sse-client-integration |
