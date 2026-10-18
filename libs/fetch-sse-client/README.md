# fetch-sse-client

基于 fetch 的 SSE（Server-Sent Events）客户端基础库，提供生产级的流式请求能力。

> 开发中。详细设计文档见 [openspec/systems/fetch-sse-client.md](openspec/systems/fetch-sse-client.md)。

## 特性

- **事件驱动 API**：`data` / `done` / `error` 三事件，`on()` 返回退订函数
- **严格 JSON 解析**：data 负载必为 JSON 解析后的对象，解析失败即 parse 错误终结；`[DONE]` 哨兵为唯一例外（库内消化，不透传）
- **三层超时**：连接 / 读取 / 总超时独立控制
- **取消封装**：`abort()` 方法，内部 AbortController 对消费端零暴露；取消归 `done { reason: 'aborted' }`，非错误
- **错误分类**：`SSEClientError` 四类 —— network / timeout / http / parse
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
client.on('done', ({ reason, eventCount }) => {
  // reason: 'complete'（正常结束 / [DONE] 哨兵）| 'aborted'（主动取消）
  console.log(`stream finished: ${reason}, ${eventCount} events`);
});
client.on('error', (err: SSEClientError) => {
  // 终结性错误：network / timeout / http / parse
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

## 终局语义（done 与 error 严格分工）

| 场景 | 出口 |
|------|------|
| 服务端关闭连接 | `done { reason: 'complete' }` |
| 收到 `[DONE]` 哨兵 | `done { reason: 'complete' }`，库主动关流 |
| 调用 `abort()` | `done { reason: 'aborted' }` |
| 网络失败 / 三层超时 / HTTP 非 2xx / onOpen 抛错 / JSON 解析失败 | `error`（SSEClientError） |

## API 概览

- `SSEClient` — 核心类，构造与 `start()` 分离，实例一次性
- `SSEClientError` — 结构化错误，`type` / `status?` / `cause?`
- `createSSEParser()` — 底层 SSE 解析器（W3C EventSource 规范，可单独使用）

## License

MIT
