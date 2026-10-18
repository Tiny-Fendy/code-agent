# fetch-sse-client

基于 fetch 的 SSE（Server-Sent Events）客户端基础库，提供生产级的流式请求能力。

> 开发中。详细设计文档见 [openspec/systems/fetch-sse-client.md](openspec/systems/fetch-sse-client.md)。

## 特性

- **事件驱动 API**：`data` / `done` / `error` / `reconnecting` 四事件，`on()` 返回退订函数
- **严格 JSON 解析**：data 负载必为 JSON 解析后的对象，解析失败即 parse 错误终结；`[DONE]` 哨兵为唯一例外（库内消化，不透传）
- **三层超时**：连接 / 读取 / 总超时独立控制
- **取消封装**：`abort()` 方法，内部 AbortController 对消费端零暴露；取消归 `done { reason: 'aborted' }`，非错误
- **自动重连（opt-in）**：`reconnect` 配置组，仅首字节前自动重试（fetch 拒绝 / connect 超时 / 429 / 5xx），Retry-After 头优先，指数退避 + 抖动兜底；流中途失败终结并标记 `retryable` 供消费方整体重发
- **可见性重连（opt-in）**：`reconnectOnVisible` 页面隐藏暂停流、可见恢复，新连接轮次重试预算独立，按标准回传 `Last-Event-ID`（仅浏览器环境生效）
- **错误分类**：`SSEClientError` 四类 —— network / timeout / http / parse，附 `retryable` 可重试标记
- **明确终局语义**：`done` 与 `error` 互斥且只发一次
- **环境兼容**：Node.js 18+ / 现代浏览器 / Electron，零运行时依赖

## 安装

```bash
npm install fetch-sse-client
```

## 快速开始

```typescript
import { SSEClient, SSEClientError } from 'fetch-sse-client';

const client = new SSEClient({
  url: 'https://api.example.com/chat',
  method: 'POST',
  headers: { Authorization: 'Bearer <token>' }, // 或 () => ({...}) 动态 token
  body: { query: 'hello' },                      // 普通对象自动 JSON 序列化
  params: { version: 2 },                        // 查询参数，undefined 值忽略
  timeouts: { connect: 10_000, read: 30_000, total: 0 },
  onOpen: async (response) => {                  // 可选：响应头附加校验
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('not an SSE endpoint');
    }
  },
});

client.on('data', (obj) => {
  // 必为 JSON 解析好的对象
  console.log(obj);
});
client.on('reconnecting', (info) => {
  // 重连中间态（非终局）：reason 'error'（带 attempt/delay/error）| 'hidden'（页面隐藏暂停）
  console.log(`reconnecting: ${info.reason}`, info.attempt, info.delay);
});
client.on('done', ({ reason, eventCount }) => {
  // reason: 'complete'（正常结束 / [DONE] 哨兵）| 'aborted'（主动取消）
  console.log(`stream finished: ${reason}, ${eventCount} events`);
});
client.on('error', (err: SSEClientError) => {
  // 终结性错误：network / timeout / http / parse；retryable 标记是否属于可重试类别
  console.error(err.type, err.message);
});

client.start();   // 一次性，重复调用抛错
client.abort();   // 随时取消（idle / closed 态为 no-op）
```

## 事件模型

| 事件 | 负载 | 说明 |
|------|------|------|
| `data` | `unknown` | JSON 解析成功的对象 |
| `done` | `{ reason: 'complete' \| 'aborted', eventCount: number }` | 流终结；eventCount 为已发出的 data 事件数 |
| `error` | `SSEClientError` | 终结性错误，流已关闭 |
| `reconnecting` | `SSEReconnectingInfo` | 重连中间态通知（非终局），仅配置 `reconnect` 后出现 |

## 终局语义（done 与 error 严格分工）

| 场景 | 出口 |
|------|------|
| 服务端关闭连接 | `done { reason: 'complete' }` |
| 收到 `[DONE]` 哨兵 | `done { reason: 'complete' }`，库主动关流 |
| 调用 `abort()`（含重试等待、可见性暂停期间） | `done { reason: 'aborted' }` |
| 首字节前可重试失败（fetch 拒绝 / connect 超时 / 429 / 5xx），未开启 reconnect 或重试预算耗尽 | `error`（retryable=true） |
| 流中途失败（read 超时 / 流中断 / JSON 解析失败） | `error`（retryable=true 仅供消费方整体重发提示，不自动重试） |
| total 超时 / 其余 4xx / onOpen 抛错 / 请求准备失败 | `error`（retryable=false） |

## 自动重连（reconnect）

不配置即不重试。重试边界仅覆盖「首字节前」，流中途失败一律终结（杜绝数据重放）：

```typescript
const client = new SSEClient({
  url: 'https://api.example.com/stream',
  reconnect: {
    maxRetries: 3,           // 最大重试次数（默认 3）
    baseDelay: 1000,         // 指数退避基础延迟毫秒（默认 1000）
    maxDelay: 30_000,        // 延迟上限毫秒（默认 30000）
    jitter: 0.3,             // 抖动系数 0-1（默认 0.3）
    reconnectOnVisible: false, // 页面隐藏暂停、可见恢复（默认 false）
  },
});
```

- **重试延迟**：429/5xx 优先读取 `retry-after-ms` / `Retry-After` 头，均无才用指数退避 + 抖动，统一封顶 `maxDelay`
- **reconnecting 事件**：`{ reason: 'error', attempt, delay, error }`（重试通知）/ `{ reason: 'hidden' }`（页面隐藏暂停）
- **可见性重连**：hidden 时中止当前请求（不发 done/error），visible 立即以新连接恢复并回传 `Last-Event-ID`，新轮次重试预算独立；仅浏览器环境生效

## API 概览

- `SSEClient` — 核心类，构造与 `start()` 分离，实例一次性；开启 reconnect 后重连是 running 态内部循环
- `SSEClientError` — 结构化错误，`type` / `status?` / `retryable` / `cause?`
- `createSSEParser()` — 底层 SSE 解析器（W3C EventSource 规范，可单独使用）

## License

MIT
