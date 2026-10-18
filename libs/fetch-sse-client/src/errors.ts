/**
 * SSEClientError：终结性错误的统一封装
 *
 * 分类规则：
 * - network：连接拒绝、DNS 失败、流读取中断等网络层失败
 * - timeout：三层超时（message 区分 Connect / Read / Total）
 * - http：HTTP 非 2xx、onOpen 校验抛错（status 为响应状态码）
 * - parse：data 负载 JSON 解析失败（[DONE] 哨兵除外）
 */

export type SSEClientErrorType = 'network' | 'timeout' | 'http' | 'parse';

export class SSEClientError extends Error {
  /** 错误分类 */
  readonly type: SSEClientErrorType;
  /** HTTP 状态码（type === 'http' 时存在） */
  readonly status?: number;
  /** 原始错误 */
  readonly cause?: unknown;

  constructor(
    type: SSEClientErrorType,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message);
    this.name = 'SSEClientError';
    this.type = type;
    this.status = options?.status;
    this.cause = options?.cause;
  }
}
