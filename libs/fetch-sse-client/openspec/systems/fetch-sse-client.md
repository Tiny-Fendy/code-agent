# fetch-sse-client（SSE 流式请求基础库）

> 本文档是 fetch-sse-client 的**持续性设计文档**，随设计演进同步更新。
> 单次需求变更走 `openspec/changes/`（spec / design / tasks / check）。

## 1. 定位

基于 fetch 的 SSE（Server-Sent Events）客户端基础库，为 LLM 流式响应等场景提供生产级的流式请求能力。**网络协议层**组件，与框架、业务逻辑完全解耦，零运行时依赖，定位是项目对外开源的独立 npm 包。

分层位置：

```
业务协议层  agent-core：OpenAICompatibleProvider（chunk 翻译、tool_calls 累积）
网络协议层  本库：HTTP 请求 + SSE 解析 + 超时 + 取消 + 错误封装
```

## 2. 职责边界

| 职责 | 归属 | 说明 |
|------|------|------|
| HTTP 请求发起与请求体组装 | 本库 | method / headers / params / body（对象自动 JSON 序列化） |
| SSE 协议解析 | 本库（parser.ts） | W3C EventSource 规范：多行 data、event/id/retry 字段、注释、CRLF |
| data 负载 JSON 解析 | 本库 | 严格策略：解析成功丢出对象；除 `[DONE]` 哨兵外解析失败发 parse 错误并终结 |
| `[DONE]` 终止哨兵识别 | 本库 | 约定俗成的流结束标志，命中即关流并发 done，不透传给消费端 |
| 三层超时 | 本库（timeout.ts） | 连接 / 读取 / 总超时，共享内部 AbortController |
| 取消封装 | 本库 | `abort()` 方法，内部 AbortController 对消费端零暴露 |
| 错误分类封装 | 本库（errors.ts） | SSEClientError，type: network / timeout / http / parse |
| 业务协议翻译（chunk → LLMEvent） | **agent-core** | OpenAI delta 结构、tool_calls arguments 增量拼接 |
| 自动重连 / 重试决策 | **本库（后续迭代）** | reconnect 配置组 + reconnecting 事件，本期不实现 |

## 3. API 设计

### 3.1 调用形态

直接调用类，构造与启动分离，实例一次性：

```typescript
const client = new SSEClient({
  url: 'https://api.example.com/chat',
  method: 'POST',
  headers: { Authorization: 'Bearer xxx' },  // 或 () => ({...}) 动态 token
  body: { query: 'hello' },                   // 普通对象自动 JSON 序列化并补 Content-Type
  params: { version: 2 },                     // 查询参数，undefined 值忽略
  timeouts: { connect: 10_000, read: 30_000, total: 0 },
  onOpen: async (response) => {               // 可选：响应头附加校验
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('not an SSE endpoint');
    }
  },
});

const off = client.on('data', (obj) => { /* 必为 JSON 解析好的对象 */ });
client.on('done', ({ reason, eventCount }) => { /* 终局 */ });
client.on('error', (err: SSEClientError) => { /* 终结性错误 */ });

client.start();   // 一次性，重复调用抛错
client.abort();   // 随时取消
```

### 3.2 配置项（SSEClientOptions）

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| url | string | 必填 | 完整 URL |
| method | string | 'GET' | HTTP 方法 |
| headers | Record \| () => Record | {} | 对象或函数（start 时求值一次） |
| body | BodyInit \| Record | — | 普通对象自动 JSON 序列化 |
| params | Record<string, string \| number \| boolean \| undefined> | — | 查询参数 |
| timeouts.connect | number | 10000 | 连接超时（毫秒，0 不限） |
| timeouts.read | number | 30000 | 读取超时（两次数据到达的最大间隔，0 不限） |
| timeouts.total | number | 0 | 单条流生命周期上限（0 不限） |
| onOpen | (response) => void \| Promise\<void\> | — | 响应头附加校验钩子，抛错即终结 |
| fetchImpl | typeof fetch | 全局 fetch | 测试或特殊环境注入 |

### 3.3 事件模型

| 事件 | 负载 | 说明 |
|------|------|------|
| data | unknown | JSON 解析成功的对象（严格策略：负载必为对象，无非 JSON 透传） |
| done | { reason: 'complete' \| 'aborted', eventCount: number } | 流终结（正常结束 / 主动取消），eventCount 为已发出的 data 事件数 |
| error | SSEClientError | 终结性错误，流已关闭 |

`on(event, handler)` 返回退订函数；同一事件可注册多个处理器。

### 3.4 终局语义（done 与 error 严格分工）

| 场景 | 出口 |
|------|------|
| 服务端关闭连接（reader done） | done { reason: 'complete' } |
| 收到 `[DONE]` 哨兵 | done { reason: 'complete' }，库主动关流 |
| 调用 abort() | done { reason: 'aborted' } |
| 网络失败 / 三层超时 / HTTP 非 2xx / onOpen 抛错 / JSON 解析失败（`[DONE]` 除外） | error（SSEClientError） |

**一条流 done 与 error 互斥，且只发一次**；abort 是正常终局而非错误。

### 3.5 生命周期状态机

```
idle ──start()──▶ running ──reader done / [DONE]──▶ closed（发 done complete）
                    │                                      
                    ├──── abort() ────────────────▶ closed（发 done aborted）
                    │                                      
                    └──── 异常（网络/超时/HTTP/onOpen）──▶ closed（发 error）
```

- start() 仅 idle 态可用，其余状态调用抛错
- abort() 在 idle / closed 态为 no-op

### 3.6 `[DONE]` 哨兵处理

OpenAI 系 API（含 DeepSeek、Moonshot、vLLM 等兼容方）约定俗成以 `data: [DONE]` 标记流结束，但 `[DONE]` 不是合法 JSON——若不特判，严格解析策略会把每条正常结束的流误判为 parse 错误。

库内部处理：SSE 事件 `data === '[DONE]'`（parser 已按规范剥离冒号后空格，精确匹配）时，**不透传该事件、不走 JSON 解析**，主动关闭读取并发出 done { reason: 'complete' }。eventCount 不计入该哨兵。**这是严格解析策略的唯一例外。**

### 3.7 错误封装（SSEClientError）

```typescript
class SSEClientError extends Error {
  readonly type: 'network' | 'timeout' | 'http' | 'parse';
  readonly status?: number;   // type === 'http' 时存在
  readonly cause?: unknown;   // 原始错误
}
```

分类规则：三层超时 → timeout（message 区分 connect / read / total）；HTTP 非 2xx 与 onOpen 抛错 → http（onOpen 抛错时 status 为响应状态码）；data 负载 JSON 解析失败（`[DONE]` 哨兵除外）→ parse；其余（连接拒绝、DNS、流读取中断等）→ network。

## 4. 模块结构

| 文件 | 职责 |
|------|------|
| client.ts | SSEClient 类：生命周期、事件分发、请求编排 |
| parser.ts | SSE 协议解析器（W3C 规范，可独立使用） |
| timeout.ts | 三层超时控制器（共享 AbortController） |
| errors.ts | SSEClientError |
| types.ts | SSEClientOptions、事件负载类型 |
| index.ts | 出口：SSEClient、SSEClientError、createSSEParser 及类型 |

## 5. 关键设计决策

| 决策 | 理由 |
|------|------|
| 类 + 显式 start()，不用工厂函数即启动 / AsyncGenerator | 事件注册零时序风险（先 on 后 start 完全由调用方控制）；生命周期状态机清晰；可注入 fetchImpl 控制测试时机 |
| 实例一次性，start() 重复调用抛错 | 重连是未来内部行为，不暴露复用语义；状态机保持简单 |
| abort() 方法封装，不暴露 AbortSignal | 调用方零感知 AbortController；API 表面最小化 |
| data 事件内部完成 JSON 解析，严格策略：解析失败即 parse 错误终结 | LLM 场景 data 必为 JSON；data 负载类型可信（必为对象）；畸形数据快速失败而非静默透传。已对标 openai-node `fromSSEResponse`：JSON.parse 失败即 throw SyntaxError 终结，行为一致 |
| `[DONE]` 哨兵库内消化，严格策略仅此一例例外，不提供 isEnd 钩子 | `[DONE]` 是 OpenAI 系约定俗成的协议层标志，不是业务内部事；通用 isEnd 钩子属于过度设计。对标验证：openai-node 精确匹配 `sse.data === '[DONE]'` 后 break 终结；@microsoft/fetch-event-source 作为通用库不处理哨兵（原样透传，属 EventSource 规范语义） |
| abort 归 done 而非 error | 主动取消是正常终局（与 Agent SendResult 四态收口思路一致）；error 事件永远等于意外失败，消费端无需过滤 |
| error 仅发终结性错误 | 无重连即无中间态错误，消费端收到 error 即可做终局处理 |
| 默认 response.ok 检查 + onOpen 附加校验 | 非 2xx 判定有合理默认；content-type 等附加校验开放钩子，onOpen 抛错即终结 |
| 配置面收敛为 timeouts 分组 | 避免顶层字段膨胀；为后续 reconnect 分组预留位置 |
| 自动重连延期到后续迭代 | 聚焦核心链路；届时以 reconnect 配置组 + reconnecting 事件 + error.retryable 字段增量引入，不破坏现有 API 表面 |

## 6. 已知限制与非目标

- 无自动重连（后续迭代，届时恢复 Last-Event-ID 回传与指数退避策略）
- 不翻译业务协议（OpenAI chunk → LLMEvent 的映射在 agent-core 的 Provider 层）
- 不支持客户端/双向流式，仅服务端流式（SSE 单向语义）
- 无请求/响应拦截器链、无日志钩子（保持核心聚焦，按需再评估）

## 7. 变更记录

| 日期 | 变更 | 关联 change |
|------|------|------------|
| 2026-10-16 | 初版落地：AsyncGenerator 函数式 API（fetchSSE）+ 解析/重连/超时模块，53 项测试 | — |
| 2026-10-17 | API v2 定稿：类 + 事件驱动（data/done/error）替代 AsyncGenerator；取消封装为 abort()；内部 JSON 严格解析（`[DONE]` 哨兵为唯一例外，库内消化）；错误收敛为终结性 SSEClientError；重连能力延期，相关模块（reconnect.ts）撤出待回归 | 本会话 API 重设计讨论 |
| 2026-10-18 | 对标验证：严格 JSON 解析 + `[DONE]` 哨兵策略与 openai-node（微软 Azure OpenAI 官方迁移指定包）行为一致；@microsoft/fetch-event-source 作为通用库对照（原样透传、不处理哨兵） | openai-node / fetch-event-source 源码调研 |
