import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTimeoutController } from '@/timeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('createTimeoutController', () => {
  it('connectTimeout 到期触发 abort', () => {
    vi.useFakeTimers();
    const ctrl = createTimeoutController(1000, 0, 0);
    ctrl.startConnectTimer();
    vi.advanceTimersByTime(1000);
    expect(ctrl.controller.signal.aborted).toBe(true);
    expect(ctrl.connectTimedOut).toBe(true);
    ctrl.dispose();
  });

  it('连接建立前取消 connect 计时则不触发', () => {
    vi.useFakeTimers();
    const ctrl = createTimeoutController(1000, 0, 0);
    ctrl.startConnectTimer();
    ctrl.cancelConnectTimer();
    vi.advanceTimersByTime(5000);
    expect(ctrl.controller.signal.aborted).toBe(false);
    expect(ctrl.connectTimedOut).toBe(false);
    ctrl.dispose();
  });

  it('readTimeout 在每次数据到达后重新计时', () => {
    vi.useFakeTimers();
    const ctrl = createTimeoutController(0, 1000, 0);
    ctrl.refreshReadTimer();
    vi.advanceTimersByTime(800);
    ctrl.refreshReadTimer(); // 数据到达，重新计时
    vi.advanceTimersByTime(800);
    expect(ctrl.controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(200); // 距上次数据 1000ms
    expect(ctrl.controller.signal.aborted).toBe(true);
    expect(ctrl.readTimedOut).toBe(true);
    ctrl.dispose();
  });

  it('totalTimeout 到期触发 abort', () => {
    vi.useFakeTimers();
    const ctrl = createTimeoutController(0, 0, 500);
    vi.advanceTimersByTime(500);
    expect(ctrl.controller.signal.aborted).toBe(true);
    expect(ctrl.totalTimedOut).toBe(true);
    ctrl.dispose();
  });

  it('dispose 后所有计时器不再触发', () => {
    vi.useFakeTimers();
    const ctrl = createTimeoutController(100, 100, 100);
    ctrl.startConnectTimer();
    ctrl.refreshReadTimer();
    ctrl.dispose();
    vi.advanceTimersByTime(10000);
    expect(ctrl.controller.signal.aborted).toBe(false);
  });

  it('外部 signal 已取消时立即联动 abort', () => {
    const external = new AbortController();
    external.abort();
    const ctrl = createTimeoutController(0, 0, 0, external.signal);
    expect(ctrl.controller.signal.aborted).toBe(true);
    ctrl.dispose();
  });

  it('外部 signal 之后取消会联动 abort', () => {
    const external = new AbortController();
    const ctrl = createTimeoutController(0, 0, 0, external.signal);
    expect(ctrl.controller.signal.aborted).toBe(false);
    external.abort();
    expect(ctrl.controller.signal.aborted).toBe(true);
    ctrl.dispose();
  });

  it('0 表示不启用对应超时', () => {
    vi.useFakeTimers();
    const ctrl = createTimeoutController(0, 0, 0);
    ctrl.startConnectTimer();
    ctrl.refreshReadTimer();
    vi.advanceTimersByTime(60000);
    expect(ctrl.controller.signal.aborted).toBe(false);
    ctrl.dispose();
  });
});
