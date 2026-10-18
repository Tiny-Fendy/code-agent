/**
 * 自动重连策略
 *
 * - 配置解析：不配置即不重试（返回 null），配置项缺省回退默认值
 * - 延迟计算：指数退避 + 抖动，封顶 maxDelay（attempt 从 1 起，首次重试即 baseDelay）
 * - Retry-After 解析：retry-after-ms（毫秒）优先，Retry-After（秒）次之，均无或非法返回 null
 */

import type { SSEReconnectOptions } from './types.js';

/** 重连配置（默认值已填充） */
export interface ResolvedReconnectOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  jitter: number;
  reconnectOnVisible: boolean;
}

export const RECONNECT_DEFAULTS: ResolvedReconnectOptions = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30_000,
  jitter: 0.3,
  reconnectOnVisible: false,
};

/** 解析重连配置：未配置返回 null（即不重试），否则填充默认值 */
export function resolveReconnectOptions(
  options?: SSEReconnectOptions,
): ResolvedReconnectOptions | null {
  if (!options) return null;
  return { ...RECONNECT_DEFAULTS, ...options };
}

/**
 * 计算第 attempt 次重试的等待时间（毫秒）
 *
 * 指数退避：baseDelay * 2^(attempt-1)，±delay*jitter 随机抖动避免惊群，封顶 maxDelay。
 * attempt 从 1 起：首次重试延迟即 baseDelay±jitter。
 */
export function calculateReconnectDelay(
  attempt: number,
  options: ResolvedReconnectOptions,
): number {
  let delay = options.baseDelay * Math.pow(2, attempt - 1);
  if (options.jitter > 0) {
    delay += (Math.random() * 2 - 1) * delay * options.jitter;
  }
  return Math.min(Math.max(delay, 0), options.maxDelay);
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
