/**
 * 自动重连策略
 *
 * - 配置解析：不配置即不重试（resolve 返回 null），配置项缺省回退默认值
 * - 延迟计算：指数退避 + 抖动，封顶 maxDelay（attempt 从 1 起，首次重试即 baseDelay）
 * - Retry-After：retry-after-ms（毫秒）优先，Retry-After（秒）次之，均无或非法返回 null
 */

import type { SSEReconnectOptions } from './types.js';

/** 重连配置（默认值已填充） */
export interface ResolvedReconnectOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  jitter: number;
}

export const RECONNECT_DEFAULTS: ResolvedReconnectOptions = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30_000,
  jitter: 0.3,
};

/**
 * 重连策略：持有已解析的配置，提供重试延迟计算。
 * 不配置即不重试（resolve 返回 null）。
 */
export class ReconnectPolicy {
  private constructor(private readonly options: ResolvedReconnectOptions) {}

  /** 解析重连配置：未配置返回 null（即不重试），否则返回策略实例 */
  static resolve(options?: SSEReconnectOptions): ReconnectPolicy | null {
    if (!options) return null;
    return new ReconnectPolicy({ ...RECONNECT_DEFAULTS, ...options });
  }

  /** 最大重试次数 */
  get maxRetries(): number {
    return this.options.maxRetries;
  }

  /**
   * 计算第 attempt 次重试的等待时间（毫秒）
   *
   * Retry-After 优先（封顶 maxDelay），否则指数退避 + 抖动，封顶 maxDelay。
   * attempt 从 1 起：首次重试延迟即 baseDelay±jitter。
   */
  nextDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, this.options.maxDelay);
    }
    let delay = this.options.baseDelay * Math.pow(2, attempt - 1);
    if (this.options.jitter > 0) {
      delay += (Math.random() * 2 - 1) * delay * this.options.jitter;
    }
    return Math.min(Math.max(delay, 0), this.options.maxDelay);
  }
}

/**
 * 解析 429 / 5xx 响应的重试延迟
 *
 * 优先 retry-after-ms（毫秒），其次 Retry-After（秒 × 1000）；均无或值非法返回 null。
 * Headers.get 不区分大小写，HTTP-date 形式的 Retry-After 不支持（回退指数退避）。
 */
export function parseRetryAfterHeaders(headers: Headers): number | null {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && ms.trim() !== '') {
    const value = Number(ms);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const seconds = headers.get('retry-after');
  if (seconds !== null && seconds.trim() !== '') {
    const value = Number(seconds);
    if (Number.isFinite(value) && value >= 0) return value * 1000;
  }
  return null;
}
