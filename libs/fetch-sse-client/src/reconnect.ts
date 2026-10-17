/**
 * 重连策略计算
 *
 * 支持指数退避、线性退避、固定间隔和自定义函数。
 * 抖动：在计算出的延迟基础上 ±(delay * jitter) 随机偏移，
 * 避免多个客户端同时重连造成“惊群”。
 */

import type { ReconnectStrategy } from './types';

/**
 * 计算本次重连的等待时间（毫秒）
 *
 * @param attempt   当前尝试次数（从 0 开始：首次重连为 0）
 * @param strategy  重连策略
 * @param baseDelay 基础延迟（毫秒）
 * @param maxDelay  最大延迟（毫秒，上限）
 * @param jitter    抖动系数（0-1）
 */
export function calculateReconnectDelay(
  attempt: number,
  strategy: ReconnectStrategy,
  baseDelay: number,
  maxDelay: number,
  jitter: number,
): number {
  let delay: number;

  if (typeof strategy === 'function') {
    delay = strategy(attempt);
  } else {
    switch (strategy) {
      case 'exponential':
        delay = baseDelay * Math.pow(2, attempt);
        break;
      case 'linear':
        delay = baseDelay * (attempt + 1);
        break;
      case 'fixed':
      default:
        delay = baseDelay;
    }
  }

  // 抖动：±jitter * delay
  if (jitter > 0) {
    const jitterAmount = delay * jitter;
    delay += (Math.random() * 2 - 1) * jitterAmount;
  }

  // 确保非负且不超过上限
  return Math.min(Math.max(delay, 0), maxDelay);
}
