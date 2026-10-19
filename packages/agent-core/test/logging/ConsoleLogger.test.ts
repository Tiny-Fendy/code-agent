/**
 * ConsoleLogger 单元测试
 *
 * 覆盖：minLevel 级别过滤、输出格式（时间戳/级别前缀/context JSON）、
 * warn/error 走 stderr 通道、context 循环引用降级不抛异常。
 * 与源文件一一对应：src/logging/ConsoleLogger.ts → test/logging/ConsoleLogger.test.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConsoleLogger } from '../../src/logging/ConsoleLogger';

afterEach(() => {
  vi.restoreAllMocks();
});

/** 拦截 console 通道，返回按通道分组的输出行 */
function captureConsole() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(' '));
  });
  return { stdout, stderr };
}

describe('minLevel 级别过滤', () => {
  it('默认 info：debug 不输出，info/warn/error 输出', () => {
    const { stdout, stderr } = captureConsole();
    const logger = new ConsoleLogger(); // 默认 info

    logger.debug('debug 消息');
    logger.info('info 消息');
    logger.warn('warn 消息');
    logger.error('error 消息');

    expect(stdout).toHaveLength(1); // 仅 info
    expect(stderr).toHaveLength(2); // warn + error
    expect(stdout[0]).toContain('info 消息');
  });

  it('minLevel debug：全部输出', () => {
    const { stdout } = captureConsole();
    const logger = new ConsoleLogger('debug');

    logger.debug('d');
    logger.info('i');

    expect(stdout).toHaveLength(2);
  });

  it('minLevel error：info/warn 不输出，仅 error', () => {
    const { stdout, stderr } = captureConsole();
    const logger = new ConsoleLogger('error');

    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(stdout).toHaveLength(0);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('e');
  });
});

describe('输出格式与通道', () => {
  it('格式：[HH:mm:ss.SSS] [LEVEL] message {contextJson}', () => {
    const { stdout } = captureConsole();
    const logger = new ConsoleLogger('debug');

    logger.info('请求完成', { tool: 'read_file', count: 3 });

    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[INFO\] 请求完成 \{"tool":"read_file","count":3\}$/);
  });

  it('无 context 时无 JSON 后缀', () => {
    const { stdout } = captureConsole();
    const logger = new ConsoleLogger();

    logger.info('纯消息');

    expect(stdout[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[INFO\] 纯消息$/);
  });

  it('debug 走 stdout，warn/error 走 stderr', () => {
    const { stdout, stderr } = captureConsole();
    const logger = new ConsoleLogger('debug');

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(stdout).toHaveLength(2);
    expect(stderr).toHaveLength(2);
    expect(stderr[0]).toContain('[WARN] w');
    expect(stderr[1]).toContain('[ERROR] e');
  });
});

describe('context 序列化降级（Logger 契约：不向调用方抛异常）', () => {
  it('循环引用降级为 String(value)，不抛异常', () => {
    const { stdout } = captureConsole();
    const logger = new ConsoleLogger();

    const circular: Record<string, unknown> = { name: 'a' };
    circular.self = circular;

    expect(() => logger.info('带坏 context', circular)).not.toThrow();
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain('带坏 context');
  });

  it('undefined context 正常输出', () => {
    const { stdout } = captureConsole();
    const logger = new ConsoleLogger();

    expect(() => logger.info('msg', undefined)).not.toThrow();
    expect(stdout).toHaveLength(1);
  });
});
