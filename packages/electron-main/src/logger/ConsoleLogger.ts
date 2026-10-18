import type { Logger, LogLevel } from '@code-agent/contracts';

/** 级别权重：低于 minLevel 的日志被过滤 */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function timestamp(): string {
  const d = new Date();
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function stringify(context: Record<string, unknown>): string {
  try {
    return JSON.stringify(context);
  } catch {
    // 循环引用等序列化失败降级，不抛异常
    return String(context);
  }
}

/**
 * ConsoleLogger：基于 console API 的最简日志实现（暂不落文件）
 *
 * 输出格式：[HH:mm:ss.SSS] [LEVEL] message {contextJson}
 * 映射：debug→console.debug / info→console.info / warn→console.warn / error→console.error
 */
export class ConsoleLogger implements Logger {
  constructor(private readonly minLevel: LogLevel = 'info') {}

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context);
  }

  // 接口契约：任何情况下不得向调用方抛出
  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    try {
      if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return;
      const line =
        context === undefined
          ? `[${timestamp()}] [${level.toUpperCase()}] ${message}`
          : `[${timestamp()}] [${level.toUpperCase()}] ${message} ${stringify(context)}`;
      console[level](line);
    } catch {
      // 日志自身异常静默消化
    }
  }
}
