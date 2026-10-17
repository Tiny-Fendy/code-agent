import { describe, it, expect } from 'vitest';
import { calculateReconnectDelay } from '@/reconnect';

describe('calculateReconnectDelay', () => {
  it('exponential：base * 2^attempt', () => {
    expect(calculateReconnectDelay(0, 'exponential', 1000, 30000, 0)).toBe(1000);
    expect(calculateReconnectDelay(1, 'exponential', 1000, 30000, 0)).toBe(2000);
    expect(calculateReconnectDelay(3, 'exponential', 1000, 30000, 0)).toBe(8000);
  });

  it('linear：base * (attempt + 1)', () => {
    expect(calculateReconnectDelay(0, 'linear', 500, 30000, 0)).toBe(500);
    expect(calculateReconnectDelay(2, 'linear', 500, 30000, 0)).toBe(1500);
  });

  it('fixed：固定 base', () => {
    expect(calculateReconnectDelay(5, 'fixed', 2000, 30000, 0)).toBe(2000);
  });

  it('自定义函数策略', () => {
    const fn = (attempt: number) => attempt * 100;
    expect(calculateReconnectDelay(3, fn, 1000, 30000, 0)).toBe(300);
  });

  it('结果不超过 maxDelay', () => {
    expect(calculateReconnectDelay(10, 'exponential', 1000, 5000, 0)).toBe(5000);
  });

  it('自定义函数返回值同样受 maxDelay 限制', () => {
    expect(calculateReconnectDelay(0, () => 999999, 1000, 5000, 0)).toBe(5000);
  });

  it('自定义函数返回负数时截断为 0', () => {
    expect(calculateReconnectDelay(0, () => -100, 1000, 5000, 0)).toBe(0);
  });

  it('jitter > 0 时结果在 ±jitter*delay 范围内', () => {
    for (let i = 0; i < 20; i++) {
      const delay = calculateReconnectDelay(2, 'exponential', 1000, 30000, 0.5);
      // 基础值 4000，抖动 ±2000
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(6000);
    }
  });

  it('maxDelay 限制在抖动之后仍然生效', () => {
    for (let i = 0; i < 20; i++) {
      const delay = calculateReconnectDelay(3, 'exponential', 1000, 5000, 0.5);
      expect(delay).toBeLessThanOrEqual(5000);
    }
  });
});
