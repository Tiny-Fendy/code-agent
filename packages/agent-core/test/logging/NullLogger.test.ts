/**
 * NullLogger 单元测试
 *
 * 覆盖：四个级别方法调用无副作用、不抛异常（库静默原则的缺省实现）。
 * 与源文件一一对应：src/logging/NullLogger.ts → test/logging/NullLogger.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { NullLogger } from '../../src/logging/NullLogger';

describe('NullLogger 调用无副作用', () => {
  it('四个级别方法均不输出、不抛异常（带或不带 context）', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new NullLogger();

    expect(() => {
      logger.debug('d');
      logger.info('i');
      logger.warn('w', { k: 'v' });
      logger.error('e', { k: 'v' });
    }).not.toThrow();

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
