/**
 * ConsoleLogger —— Logger 的控制台实现
 *
 * 输出格式：[HH:mm:ss.SSS] [LEVEL] message {contextJson}
 * - minLevel 过滤：低于该级别的日志不输出（默认 info，debug 原文细节默认关闭）
 * - context 序列化失败（循环引用等）降级为 String(value)，自身不抛异常
 *
 * 宿主要启用日志：new Agent(config, path, { logger: new ConsoleLogger('debug') })
 */

import type { Logger, LogLevel } from '@code-agent/contracts';

/** 级别权重：数值越大越严重 */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** 毫秒精度时间戳，补零到固定宽度 */
function timestamp(): string {
  const d = new Date();
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** context 序列化：失败降级为 String(value)，绝不抛出（Logger 契约） */
function serializeContext(context: Record<string, unknown> | undefined): string {
  if (!context) return '';
  try {
    return ` ${JSON.stringify(context)}`;
  } catch {
    return ` ${String(context)}`;
  }
}

export class ConsoleLogger implements Logger {
  constructor(private readonly minLevel: LogLevel = 'info') {}

  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context);
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;
    const line = `[${timestamp()}] [${level.toUpperCase()}] ${message}${serializeContext(context)}`;
    // warn/error 走 stderr，其余走 stdout
    if (level === 'warn' || level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}
