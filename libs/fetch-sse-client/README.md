# fetch-sse-client

基于 fetch 的 SSE（Server-Sent Events）客户端库，提供生产级的流式请求基础能力。

> 开发中。详细设计文档见 [openspec/systems/fetch-sse-client.md](openspec/systems/fetch-sse-client.md)。

## 特性

- **SSE 协议解析**：实现 W3C EventSource 规范（多行 data、event、id、retry 字段、注释、CRLF）
- **自动重连**：指数退避 + 抖动，可配置最大次数与自定义策略，重连时自动回传 `Last-Event-ID`
- **三层超时**：连接超时 / 读取超时 / 总超时独立控制
- **取消机制**：直接使用原生 fetch 的 `AbortSignal`，不做二次封装
- **错误分类**：network / timeout / http / parse / abort 五类，标记可重连性
- **环境兼容**：Node.js 18+ / 现代浏览器 / Electron，零运行时依赖

## 安装

```bash
npm install fetch-sse-client
```

## 快速开始

```typescript
import { fetchSSE } from 'fetch-sse-client';

const controller = new AbortController();

for await (const event of fetchSSE({
  url: 'https://api.example.com/stream',
  method: 'POST',
  headers: { 'Authorization': 'Bearer <token>' },
  body: { query: 'hello' },
  parseJson: true,
  signal: controller.signal,
  autoReconnect: true,
})) {
  switch (event.type) {
    case 'json':
      console.log(event.event.data);
      break;
    case 'error':
      // event.error.willRetry === true 表示将自动重连，流未终结
      console.error(event.error);
      break;
    case 'done':
      console.log('stream finished');
      break;
  }
}

// 取消：原生 AbortSignal
controller.abort();
```

## API 概览

- `fetchSSE(options)` — 核心函数，返回 `AsyncGenerator<SSEStreamEvent, void, unknown>`
- `createSSEParser()` — 底层 SSE 解析器（可单独使用）
- `calculateReconnectDelay(...)` — 重连延迟计算（可单独使用）

## 事件模型

| 事件 | 说明 |
|------|------|
| `{ type: 'event', event }` | 原始 SSE 事件（未开启 parseJson） |
| `{ type: 'json', event }` | data 已 JSON 解析的事件（parseJson: true） |
| `{ type: 'error', error }` | 错误；`error.willRetry === true` 表示即将自动重连 |
| `{ type: 'done' }` | 流正常结束 |

## License

MIT
