export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 日志接口（面向开发者的诊断通道，与产品事件严格分离）
 *
 * 契约：实现方必须自行消化异常，任何情况下不得向调用方抛出。
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
