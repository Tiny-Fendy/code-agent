/**
 * fetch-sse-client 类型定义
 *
 * API v2：类 + 事件驱动（data / done / error）。
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

/** SSEClient 事件负载映射 */
export interface SSEClientEvents {
  /** JSON 解析成功的 data 负载（严格策略：解析失败即 parse 错误终结） */
  data: unknown;
  /** 流终结（正常结束 / 主动取消），与 error 互斥且只发一次 */
  done: SSEDoneInfo;
  /** 终结性错误，流已关闭 */
  error: SSEClientError;
}
