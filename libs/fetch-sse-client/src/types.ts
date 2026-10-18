/**
 * fetch-sse-client 类型定义
 *
 * API v2：类 + 事件驱动（data / done / error / reconnecting）。
 * 设计文档：openspec/systems/fetch-sse-client.md
 */

import type { SSEClientError } from './errors.js';

/** SSE 原始事件（W3C EventSource 规范），parser 产出 */
export interface SSEEvent {
  /** 事件类型（默认 "message"） */
  event: string;
  /** 数据负载（多行 data 以 \n 拼接） */
  data: string;
  /** 事件 ID */
  id?: string;
  /** 服务端建议的重连间隔（毫秒） */
  retry?: number;
}

/** 三层超时配置（毫秒，0 表示不限） */
export interface SSETimeouts {
  /** 连接超时：fetch 发起至收到响应头的最大等待（默认 10000） */
  connect?: number;
  /** 读取超时：两次数据到达的最大间隔，用于检测僵死连接（默认 30000） */
  read?: number;
  /** 总超时：单条流的生命周期上限（默认 0，不限） */
  total?: number;
}

/**
 * 自动重连配置组（不配置即不重试，默认关闭）
 *
 * 重试边界：仅「首字节前」自动重试（fetch 拒绝 / connect 超时 / HTTP 429 与 5xx）；
 * 流中途失败一律终结（retryable=true 仅作消费方整体重发提示）。
 */
export interface SSEReconnectOptions {
  /** 最大重试次数（默认 3） */
  maxRetries?: number;
  /** 指数退避基础延迟，毫秒（默认 1000） */
  baseDelay?: number;
  /** 重试延迟上限，毫秒（默认 30000） */
  maxDelay?: number;
  /** 抖动系数 0-1，±delay*jitter 随机偏移避免惊群（默认 0.3） */
  jitter?: number;
  /** 页面隐藏时暂停流、可见后以新连接轮次恢复（默认 false；仅浏览器环境生效） */
  reconnectOnVisible?: boolean;
}

/** SSEClient 配置项 */
export interface SSEClientOptions {
  /** 完整 URL */
  url: string;
  /** HTTP 方法（默认 'GET'） */
  method?: string;
  /** 请求头：对象或函数（start 时求值一次，支持动态 token） */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** 请求体：普通对象自动 JSON 序列化并补 Content-Type；BodyInit 原样透传 */
  body?: BodyInit | Record<string, unknown>;
  /** 查询参数（undefined 值忽略） */
  params?: Record<string, string | number | boolean | undefined>;
  /** 三层超时 */
  timeouts?: SSETimeouts;
  /** 自动重连配置组（不配置即不重试） */
  reconnect?: SSEReconnectOptions;
  /**
   * 响应头附加校验钩子（默认 response.ok 检查始终先执行）。
   * 抛错即终结，归 http 错误（status 为响应状态码，cause 为原始错误）。
   */
  onOpen?: (response: Response) => void | Promise<void>;
  /** 自定义 fetch 实现（测试或特殊环境注入） */
  fetchImpl?: typeof fetch;
}

/** done 事件负载 */
export interface SSEDoneInfo {
  /** complete：服务端关闭连接或收到 [DONE] 哨兵；aborted：主动 abort() */
  reason: 'complete' | 'aborted';
  /** 已发出的 data 事件数（[DONE] 哨兵不计入） */
  eventCount: number;
}

/** reconnecting 事件负载（重连中间态通知，非终局） */
export interface SSEReconnectingInfo {
  /** error：可重试错误触发的自动重试；hidden：页面隐藏暂停（reconnectOnVisible） */
  reason: 'error' | 'hidden';
  /** reason === 'error'：即将进行的重试序号（从 1 起） */
  attempt?: number;
  /** reason === 'error'：本次重试等待毫秒（Retry-After 优先，否则指数退避+jitter，封顶 maxDelay） */
  delay?: number;
  /** reason === 'error'：触发重试的错误 */
  error?: SSEClientError;
}

/** SSEClient 事件负载映射 */
export interface SSEClientEvents {
  /** JSON 解析成功的 data 负载（严格策略：解析失败即 parse 错误终结） */
  data: unknown;
  /** 流终结（正常结束 / 主动取消），与 error 互斥且只发一次 */
  done: SSEDoneInfo;
  /** 终结性错误，流已关闭 */
  error: SSEClientError;
  /** 重连中间态通知（非终局；不配置 reconnect 时不会发出） */
  reconnecting: SSEReconnectingInfo;
}
