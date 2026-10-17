/**
 * fetch-sse-client 类型定义
 *
 * 设计原则：基础功能优先——SSE 流式解析 + 自动重连 + 三层超时。
 * 取消机制直接使用原生 fetch 的 AbortSignal，不做二次封装。
 */

/** SSE 原始事件（W3C EventSource 规范） */
export interface SSEEvent {
  /** 事件类型（默认 "message"） */
  event: string;
  /** 数据负载（多行 data 以 \n 拼接） */
  data: string;
  /** 事件 ID（重连时通过 Last-Event-ID 头回传服务端） */
  id?: string;
  /** 服务端建议的重连间隔（毫秒） */
  retry?: number;
}

/** data 已 JSON 解析的事件 */
export interface SSEJsonEvent<T = unknown> {
  event: string;
  data: T;
  id?: string;
  retry?: number;
}

/** 错误类型 */
export type SSEErrorType = 'network' | 'timeout' | 'http' | 'parse' | 'abort';

/** 结构化错误 */
export interface SSEError {
  type: SSEErrorType;
  message: string;
  /** HTTP 状态码（type === 'http' 时存在） */
  status?: number;
  /** 原始错误 */
  cause?: unknown;
  /** 是否可重试 */
  retryable: boolean;
  /** 服务端建议的重连等待（毫秒） */
  retryAfter?: number;
  /** 本次错误后将自动重试（true 表示流尚未终结） */
  willRetry?: boolean;
}

/** 流式事件（AsyncGenerator 产出的值） */
export type SSEStreamEvent =
  | { type: 'event'; event: SSEEvent }
  | { type: 'json'; event: SSEJsonEvent }
  | { type: 'error'; error: SSEError }
  | { type: 'done' };

/** 重连策略 */
export type ReconnectStrategy = 'exponential' | 'linear' | 'fixed' | ((attempt: number) => number);

/** fetchSSE 配置选项 */
export interface FetchSSEOptions {
  /** 目标 URL（完整 URL，含协议与域名） */
  url: string;
  /** HTTP 方法（默认 GET） */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** 请求头（对象或函数，支持动态 token） */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** 请求体（普通对象自动 JSON 序列化） */
  body?: BodyInit | Record<string, unknown>;
  /** URL 查询参数（undefined 值会被忽略） */
  params?: Record<string, string | number | boolean | undefined>;

  // ---- 超时 ----
  /** 连接超时（毫秒，0 不限，默认 10000） */
  connectTimeout?: number;
  /** 读取超时（毫秒，两次数据到达的最大间隔，0 不限，默认 30000） */
  readTimeout?: number;
  /** 总超时（毫秒，单次连接的生命周期上限，0 不限，默认 0） */
  totalTimeout?: number;

  // ---- 重连 ----
  /** 是否自动重连（默认 false） */
  autoReconnect?: boolean;
  /** 最大重连次数（默认 3） */
  maxReconnects?: number;
  /** 重连策略（默认 'exponential'） */
  reconnectStrategy?: ReconnectStrategy;
  /** 基础重连延迟（毫秒，默认 1000） */
  baseReconnectDelay?: number;
  /** 最大重连延迟（毫秒，默认 30000） */
  maxReconnectDelay?: number;
  /** 抖动系数 0-1（默认 0.3） */
  reconnectJitter?: number;
  /** 自定义重连决策（默认按 error.retryable 判断） */
  shouldReconnect?: (error: SSEError, attempt: number) => boolean;

  // ---- 取消 ----
  /** 取消信号：直接使用原生 fetch 的 AbortSignal 机制 */
  signal?: AbortSignal;

  // ---- 高级 ----
  /** 自定义 fetch 实现（测试或特殊环境） */
  fetchImpl?: typeof fetch;
  /** 自动 JSON 解析 data（默认 false） */
  parseJson?: boolean;
  /** JSON 解析失败策略（默认 'emit'：产出 parse error 事件） */
  jsonParseErrorStrategy?: 'emit' | 'skip' | 'raw';
}
