/**
 * NullLogger —— Logger 的空实现（库静默原则的缺省值）
 *
 * 未注入 logger 时各注入点落到本实例：不产生任何输出、无副作用。
 * agent-core 是库不是应用，缺省不污染宿主 stdout。
 */

import type { Logger } from '@code-agent/contracts';

export class NullLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
