/**
 * fetch-sse-client
 *
 * 基于 fetch 的 SSE（Server-Sent Events）客户端库。
 * 基础能力：SSE 协议解析、自动重连、三层超时、原生 AbortSignal 取消。
 *
 * 分层定位：
 * - 网络协议层：本包，与具体业务无关
 * - 业务协议层：调用方（如 agent-core 的 OpenAICompatibleProvider）
 */

// 核心函数
export { fetchSSE } from './fetch-sse';

// 底层构件（也可单独使用）
export { createSSEParser, type SSEParser } from './parser';
export { calculateReconnectDelay } from './reconnect';

// 类型导出
export type {
  SSEEvent,
  SSEJsonEvent,
  SSEError,
  SSEErrorType,
  SSEStreamEvent,
  ReconnectStrategy,
  FetchSSEOptions,
} from './types';
