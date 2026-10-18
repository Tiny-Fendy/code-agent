import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  calculateReconnectDelay,
  parseRetryAfterHeaders,
  resolveReconnectOptions,
} from '@/reconnect';
import type { ResolvedReconnectOptions } from '@/reconnect';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveReconnectOptions', () => {
  it('未配置 → null（即不重试）', () => {
    expect(resolveReconnectOptions(undefined)).toBeNull();
  });

  it('空对象 → 全部默认值（maxRetries 3 / baseDelay 1000 / maxDelay 30000 / jitter 0.3 / reconnectOnVisible false）', () => {
    expect(resolveReconnectOptions({})).toEqual({
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 30_000,
      jitter: 0.3,
      reconnectOnVisible: false,
    });
  });

  it('部分覆盖 → 覆盖项生效，其余保持默认', () => {
    expect(resolveReconnectOptions({ maxRetries: 5 })).toEqual({
      maxRetries: 5,
      baseDelay: 1000,
      maxDelay: 30_000,
      jitter: 0.3,
      reconnectOnVisible: false,
    });
    expect(
      resolveReconnectOptions({ baseDelay: 100, reconnectOnVisible: true }),
    ).toEqual({
      maxRetries: 3,
      baseDelay: 100,
      maxDelay: 30_000,
      jitter: 0.3,
      reconnectOnVisible: true,
    });
  });
});

describe('calculateReconnectDelay（指数退避 + 抖动）', () => {
  const base: ResolvedReconnectOptions = {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30_000,
    jitter: 0,
    reconnectOnVisible: false,
  };

  it('attempt 从 1 起：1/2/3 次 → base/2x/4x', () => {
    expect(calculateReconnectDelay(1, base)).toBe(1000);
    expect(calculateReconnectDelay(2, base)).toBe(2000);
    expect(calculateReconnectDelay(3, base)).toBe(4000);
  });

  it('封顶 maxDelay', () => {
    expect(calculateReconnectDelay(10, base)).toBe(30_000);
    expect(calculateReconnectDelay(20, { ...base, baseDelay: 5000 })).toBe(30_000);
  });

  it('jitter=0 时不读取随机源，结果精确', () => {
    const spy = vi.spyOn(Math, 'random');
    expect(calculateReconnectDelay(1, base)).toBe(1000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('jitter 偏移范围：random=0 → 下界 delay*(1-jitter)，random=1 → 上界 delay*(1+jitter)', () => {
    const opts: ResolvedReconnectOptions = { ...base, jitter: 0.3 };
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(calculateReconnectDelay(1, opts)).toBe(700);
    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(calculateReconnectDelay(1, opts)).toBe(1300);
  });

  it('jitter 后仍封顶 maxDelay', () => {
    const opts: ResolvedReconnectOptions = { ...base, baseDelay: 25_000, jitter: 0.5 };
    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(calculateReconnectDelay(2, opts)).toBe(30_000);
  });
});

describe('parseRetryAfterHeaders（Retry-After 优先解析）', () => {
  it('retry-after-ms（毫秒）优先', () => {
    const headers = new Headers({ 'retry-after-ms': '250', 'retry-after': '10' });
    expect(parseRetryAfterHeaders(headers)).toBe(250);
  });

  it('仅 Retry-After（秒）→ ×1000 转毫秒', () => {
    expect(parseRetryAfterHeaders(new Headers({ 'retry-after': '2' }))).toBe(2000);
  });

  it('头名大小写不敏感', () => {
    expect(parseRetryAfterHeaders(new Headers({ 'Retry-After': '3' }))).toBe(3000);
    expect(parseRetryAfterHeaders(new Headers({ 'Retry-After-Ms': '80' }))).toBe(80);
  });

  it('均无 → null（回退指数退避）', () => {
    expect(parseRetryAfterHeaders(new Headers())).toBeNull();
  });

  it('非法值（非数字 / 空串）→ null 并回退到另一头', () => {
    expect(parseRetryAfterHeaders(new Headers({ 'retry-after-ms': 'abc' }))).toBeNull();
    expect(
      parseRetryAfterHeaders(new Headers({ 'retry-after-ms': '', 'retry-after': '4' })),
    ).toBe(4000);
  });

  it('负数 → null（不信任负延迟）', () => {
    expect(parseRetryAfterHeaders(new Headers({ 'retry-after-ms': '-5' }))).toBeNull();
  });

  it('0 → 0（允许立即重试）', () => {
    expect(parseRetryAfterHeaders(new Headers({ 'retry-after-ms': '0' }))).toBe(0);
  });
});
