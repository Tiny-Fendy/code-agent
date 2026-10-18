/**
 * SSEClientError：终结性错误的统一封装
 *
 * 分类规则：
 * - network：连接拒绝、DNS 失败、流读取中断等网络层失败
 * - timeout：三层超时（message 区分 Connect / Read / Total）
 * - http：HTTP 非 2xx、onOpen 校验抛错（status 为响应状态码）
 * - parse：data 负载 JSON 解析失败（[DONE] 哨兵除外）
 *
 * retryable 标记是否属于可重试类别（与库内自动重试解耦，见设计文档 §3.8）：
 * - fetch 拒绝 / connect 超时 / 429 / 5xx / 响应无 body → true（开启 reconnect 且首字节前自动重试）
 * - read 超时 / 流中断 / parse → true（仅作消费方整体重发提示，库内不自动重试）
 * - total 超时 / 其余 4xx / onOpen 抛错 / 请求准备失败 → false
 */

export type SSEClientErrorType = 'network' | 'timeout' | 'http' | 'parse';

export class SSEClientError extends Error {
  /** 错误分类 */
  readonly type: SSEClientErrorType;
  /** HTTP 状态码（type === 'http' 时存在） */
  readonly status?: number;
  /** 是否属于可重试类别（自动重试还需「首字节前 + 开启 reconnect + 预算未耗尽」） */
  readonly retryable: boolean;
  /** 原始错误 */
  readonly cause?: unknown;

  constructor(
    type: SSEClientErrorType,
    message: string,
    options?: { status?: number; cause?: unknown; retryable?: boolean },
  ) {
    super(message);
    this.name = 'SSEClientError';
    this.type = type;
    this.status = options?.status;
    this.retryable = options?.retryable ?? false;
    this.cause = options?.cause;
  }
}
