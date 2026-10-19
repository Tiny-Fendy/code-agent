# SSE Client 接入（Provider 三层拆分落地）- 需求规格 (spec.md)

## 1. 背景

`openspec/systems/llm-provider.md` 已定稿三层架构：网络协议层由独立的 fetch-sse-client 包承担，业务状态累积由 OpenAIAccumulator 承担，Provider.chat() 只保留编排。当前 fetch-sse-client 已完成 API v2（类 + 事件驱动 + 严格 JSON 解析 + [DONE] 哨兵消化 + 三层超时 + 可选自动重连），但 OpenAICompatibleProvider 仍在内联手写 SSE 解析：

- reader/decoder/buffer 切分、`data: ` 前缀过滤、`[DONE]` 特判与库能力重复
- 无超时机制，僵死连接无法检测
- 畸形 data 行静默跳过（`catch { continue }`），与库的严格解析策略不一致
- tool_calls 累积逻辑内联在流循环里，无法独立单测
- agent-core 尚未声明对 fetch-sse-client 的依赖

本次变更把 Provider 改造为三层编排，落地 llm-provider.md §6 剩余两项（OpenAIAccumulator 抽离、chat() 改造）。

## 2. 目标

- Provider.chat() 内部改用 SSEClient 驱动流式请求，删除全部内联 SSE 解析代码
- tool_calls 增量累积抽离为独立的 OpenAIAccumulator 类
- chat() 对 Agent 的接口（AsyncGenerator\<LLMEvent\> 签名、四类事件语义）保持不变
- 获得库带来的新能力：连接/读取超时、严格解析、规范的错误分类

## 3. 详细需求

### R1：依赖接入

- `packages/agent-core/package.json` 的 dependencies 新增 `fetch-sse-client: workspace:*`
- pnpm workspace 自动链接；agent-core 构建前需保证 fetch-sse-client 已构建（pnpm 拓扑序天然保证，无需额外配置）

### R2：chat() 改用 SSEClient 编排

- 请求组装保持现状：URL 拼接、Authorization 头、body（model/messages/stream/tools/temperature/max_tokens）的映射逻辑不变
- 内部创建 `SSEClient` 实例驱动请求，订阅 data / done / error 事件翻译为 LLMEvent
- 超时配置：本期不显式传 timeouts，采用库默认值（connect 10s / read 30s / total 0 不限）；后续如需调优再以 Provider 选项增量引入
- **不开启 reconnect**：LLM 流式请求重放语义敏感（计费、副作用），保持库默认关闭；自动重连是否开放后续单独评估

### R3：OpenAIAccumulator 抽离

- 新增 `src/llm/OpenAIAccumulator.ts`，承载现有内联逻辑：
  - content 全文累积
  - tool_calls 按 index 归位、id/name 就位、arguments 增量拼接
  - 产出部分 toolCalls（tool_call_delta 事件用，arguments 可能不完整）
  - 流末构建完整 ChatMessage（arguments 统一 JSON.parse，失败保留 `_raw` fallback）
- 与协议层 OpenAIStreamChunk 类型解耦：Accumulator 接收的是 delta 片段，不认识 chunk 结构

### R4：行为对齐与差异

| 场景 | 现状（内联实现） | 接入后 |
|------|------------------|--------|
| 畸形 data 行 JSON 解析失败 | 静默跳过（catch continue） | 严格策略：SSEClientError(parse) → LLMEvent error 终结，与库策略对齐 |
| `[DONE]` 哨兵 | 内联特判 | 库内消化，Provider 收到的 done complete 即流终结 |
| 流异常结束（无 [DONE] 但有累积内容） | 兜底产出 MessageComplete | **保留**：done complete 时若 Accumulator 有累积内容，产出 MessageComplete |
| 网络失败 / HTTP 非 2xx | 手写错误文案 | 由 SSEClientError 映射（见 R5） |
| 超时 | 无 | 库三层超时生效，timeout 错误 → LLMEvent error |

### R5：错误映射

- SSEClientError → LLMEvent(error)，message 格式：`[${err.type}] ${err.message}`
- type 取值 network / timeout / http / parse 直接进方括号前缀，http 错误 message 中已含状态码
- retryable 字段本期不透出（LLMEvent 结构不变），仅在日志/调试时可查

### R6：事件桥接与资源释放

- SSEClient 是事件驱动 API，chat() 是 AsyncGenerator：内部以 push-pull 队列适配，**不新增公开 API**
- 生成器被消费方提前终止（break / return / Agent abort）时，finally 中调用 `client.abort()` 释放连接；closed 态调用为 no-op，天然安全

### R7：测试策略确立

- 当前 test 目录无 Provider 测试，本次建立覆盖：
  - OpenAIAccumulator 独立单测（新增 `test/llm/OpenAIAccumulator.test.ts`）
  - chat() 集成测试（新增 `test/llm/OpenAICompatible.test.ts`）：通过 `vi.stubGlobal('fetch', ...)` 桩掉全局 fetch（SSEClient 默认使用全局 fetch，无需为测试侵入 Provider 公开 API）
- 测试目录结构与 src 镜像

## 4. 非目标

- 不改 LLMProvider 抽象与 LLMEvent 类型（Agent 引擎消费方式零感知）
- 不开放 reconnect / 自定义超时等 Provider 新配置项
- 不处理 fetch-sse-client 的可见性重连（Node 端场景无关）
- openai-types.ts 不动（协议层类型已独立）

## 5. 验收标准

- [ ] package.json 声明 fetch-sse-client 依赖，构建/类型检查通过
- [ ] chat() 中不再存在 reader/decoder/buffer/`data: `/`[DONE]` 等内联解析代码
- [ ] OpenAIAccumulator 独立成类，content 累积、tool_calls 按 index 归位、arguments 拼接、流末 JSON.parse（含 `_raw` fallback）均有单测覆盖
- [ ] LLMEvent 产出与现状语义一致：text_delta / tool_call_delta / message_complete / error
- [ ] 流异常结束兜底保留（无 [DONE] 但有内容 → message_complete）
- [ ] 畸形 data → error 事件终结（严格解析行为变化有测试锁定）
- [ ] 生成器提前终止时连接被 abort 释放
- [ ] 全量测试通过，无回归
