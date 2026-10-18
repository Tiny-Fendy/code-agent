/**
 * fetch-sse-client
 *
 * 基于 fetch 的 SSE（Server-Sent Events）客户端基础库。
 * 能力：HTTP 请求组装 + SSE 协议解析 + 严格 JSON 解析（[DONE] 哨兵例外）
 *      + 三层超时 + 取消封装 + 错误分类。
 *
 * 分层定位：
 * - 网络协议层：本包，与具体业务无关
 * - 业务协议层：调用方（如 agent-core 的 OpenAICompatibleProvider）
 */

// 核心类
export { SSEClient } from './client.js';
export { SSEClientError, type SSEClientErrorType } from './errors.js';

// 底层解析器（可独立使用）
export { createSSEParser, type SSEParser } from './parser.js';

// 类型导出
export type {
  SSEEvent,
  SSETimeouts,
  SSEReconnectOptions,
  SSEClientOptions,
  SSEDoneInfo,
  SSEReconnectingInfo,
  SSEClientEvents,
} from './types.js';
