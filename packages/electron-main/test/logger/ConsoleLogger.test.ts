/**
 * ConsoleLogger 测试（镜像 src/logger/ConsoleLogger.ts）
 *
 * 契约关注点：级别过滤、console 方法映射、输出格式、序列化降级，
 * 以及「任何情况下不向调用方抛异常」的接口硬约束。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleLogger } from '../../src/logger/ConsoleLogger';

afterEach(() => {
  vi.restoreAllMocks();
});

function spyConsole() {
  return {
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
}

describe('ConsoleLogger 级别过滤', () => {
  it('默认 minLevel=info：debug 被过滤，info/warn/error 各自落到对应 console 方法', () => {
    const consoleSpies = spyConsole();
    const logger = new ConsoleLogger();

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(consoleSpies.debug).not.toHaveBeenCalled();
    expect(consoleSpies.info).toHaveBeenCalledTimes(1);
    expect(consoleSpies.warn).toHaveBeenCalledTimes(1);
    expect(consoleSpies.error).toHaveBeenCalledTimes(1);
  });

  it('minLevel=debug 时 debug 也会输出', () => {
    const consoleSpies = spyConsole();

    new ConsoleLogger('debug').debug('d');

    expect(consoleSpies.debug).toHaveBeenCalledTimes(1);
  });

  it('minLevel=error 时只输出 error', () => {
    const consoleSpies = spyConsole();
    const logger = new ConsoleLogger('error');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(consoleSpies.debug).not.toHaveBeenCalled();
    expect(consoleSpies.info).not.toHaveBeenCalled();
    expect(consoleSpies.warn).not.toHaveBeenCalled();
    expect(consoleSpies.error).toHaveBeenCalledTimes(1);
  });
});

describe('ConsoleLogger 输出格式', () => {
  it('无上下文时只拼接时间戳、级别与消息', () => {
    const consoleSpies = spyConsole();

    new ConsoleLogger().info('hello');

    const line = consoleSpies.info.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[INFO\] hello$/);
  });

  it('有上下文时追加 JSON 序列化结果', () => {
    const consoleSpies = spyConsole();

    new ConsoleLogger().warn('careful', { id: 1, ok: true });

    const line = consoleSpies.warn.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[[^\]]+\] \[WARN\] careful \{"id":1,"ok":true\}$/);
  });

  it('上下文循环引用时降级输出且不抛异常', () => {
    const consoleSpies = spyConsole();
    const context: Record<string, unknown> = {};
    context.self = context;

    expect(() => new ConsoleLogger().info('cyclic', context)).not.toThrow();
    expect(consoleSpies.info).toHaveBeenCalledTimes(1);
    expect(consoleSpies.info.mock.calls[0][0]).toContain('cyclic');
  });

  it('console 自身抛异常时静默消化，不影响调用方', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('console broken');
    });

    expect(() => new ConsoleLogger().info('safe')).not.toThrow();
  });
});
