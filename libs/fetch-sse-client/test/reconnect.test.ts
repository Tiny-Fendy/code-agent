import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReconnectPolicy, parseRetryAfterHeaders } from '@/reconnect';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReconnectPolicy.resolve', () => {
  it('未配置 → null（即不重试）', () => {
    expect(ReconnectPolicy.resolve(undefined)).toBeNull();
  });

  it('空对象 → 默认值生效（maxRetries 3）', () => {
    const policy = ReconnectPolicy.resolve({});
    expect(policy).not.toBeNull();
    expect(policy!.maxRetries).toBe(3);
  });

  it('部分覆盖 → 覆盖项生效，其余保持默认', () => {
    expect(ReconnectPolicy.resolve({ maxRetries: 5 })!.maxRetries).toBe(5);
    // baseDelay 覆盖通过 nextDelay 行为验证（jitter=0 时精确）
    expect(ReconnectPolicy.resolve({ baseDelay: 100, jitter: 0 })!.nextDelay(1)).toBe(100);
  });
});

describe('ReconnectPolicy.nextDelay（指数退避 + 抖动 + Retry-After 优先）', () => {
  it('attempt 从 1 起：1/2/3 次 → base/2x/4x', () => {
    const policy = ReconnectPolicy.resolve({ baseDelay: 1000, maxDelay: 30_000, jitter: 0 })!;
    expect(policy.nextDelay(1)).toBe(1000);
    expect(policy.nextDelay(2)).toBe(2000);
    expect(policy.nextDelay(3)).toBe(4000);
  });

  it('封顶 maxDelay', () => {
    const policy = ReconnectPolicy.resolve({ baseDelay: 1000, maxDelay: 30_000, jitter: 0 })!;
    expect(policy.nextDelay(10)).toBe(30_000);
    const policy2 = ReconnectPolicy.resolve({ baseDelay: 5000, maxDelay: 30_000, jitter: 0 })!;
    expect(policy2.nextDelay(20)).toBe(30_000);
  });

  it('jitter=0 时不读取随机源，结果精确', () => {
    const spy = vi.spyOn(Math, 'random');
    const policy = ReconnectPolicy.resolve({ baseDelay: 1000, maxDelay: 30_000, jitter: 0 })!;
    expect(policy.nextDelay(1)).toBe(1000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('jitter 偏移范围：random=0 → 下界 delay*(1-jitter)，random=1 → 上界 delay*(1+jitter)', () => {
    const policy = ReconnectPolicy.resolve({ baseDelay: 1000, maxDelay: 30_000, jitter: 0.3 })!;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(policy.nextDelay(1)).toBe(700);
    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(policy.nextDelay(1)).toBe(1300);
  });

  it('jitter 后仍封顶 maxDelay', () => {
    const policy = ReconnectPolicy.resolve({ baseDelay: 25_000, maxDelay: 30_000, jitter: 0.5 })!;
    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(policy.nextDelay(2)).toBe(30_000);
  });

  it('Retry-After 优先于指数退避，且封顶 maxDelay', () => {
    const policy = ReconnectPolicy.resolve({ baseDelay: 1000, maxDelay: 30_000, jitter: 0 })!;
    expect(policy.nextDelay(1, 5000)).toBe(5000);
    expect(policy.nextDelay(1, 60_000)).toBe(30_000); // 封顶
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

  it('Retry-After（秒）负数 → null（不信任负延迟）', () => {
    expect(parseRetryAfterHeaders(new Headers({ 'retry-after': '-1' }))).toBeNull();
  });

  it('0 → 0（允许立即重试）', () => {
    expect(parseRetryAfterHeaders(new Headers({ 'retry-after-ms': '0' }))).toBe(0);
  });
});
