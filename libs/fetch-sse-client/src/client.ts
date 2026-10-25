/**
 * SSEClient：基于 fetch 的 SSE 流式客户端
 *
 * 生命周期状态机：idle → running → closed（对外不变）
 * - start() 仅 idle 态可用（实例一次性），重复调用抛错
 * - abort() 仅 running 态有效，其余状态为 no-op
 * - 开启 reconnect 时，重连是 running 态的内部循环：多次 HTTP 尝试共享一次 start() 生命周期
 *
 * 终局语义：done 与 error 互斥且只发一次
 * - 服务端关闭连接 / 收到 [DONE] 哨兵 → done { reason: 'complete' }
 * - 主动 abort()（含重试等待期间）→ done { reason: 'aborted' }（取消是正常终局）
 * - 其余失败 → error（SSEClientError）；开启 reconnect 时，首字节前的可重试失败
 *   （fetch 拒绝 / connect 超时 / 429 / 5xx）在重试预算耗尽前不发 error，
 *   仅以 reconnecting 事件通知中间态
 *
 * 职责边界：SSEClient 仅负责状态机、事件分发、重连循环编排；
 * 单次 HTTP 尝试的完整生命周期由 ConnectionAttempt 承载。
 */

import { SSEClientError } from './errors.js';
import { ReconnectPolicy } from './reconnect.js';
import { ConnectionAttempt } from './connection.js';
import type { StreamOutcome } from './connection.js';
import type {
  SSEReconnectingInfo,
  SSEClientEvents,
  SSEClientOptions,
  SSEDoneInfo,
} from './types.js';

type ClientState = 'idle' | 'running' | 'closed';

export class SSEClient {
  private state: ClientState = 'idle';
  private readonly handlers: {
    [K in keyof SSEClientEvents]: Set<(payload: SSEClientEvents[K]) => void>;
  } = {
    data: new Set<(payload: unknown) => void>(),
    done: new Set<(payload: SSEDoneInfo) => void>(),
    error: new Set<(payload: SSEClientError) => void>(),
    reconnecting: new Set<(payload: SSEReconnectingInfo) => void>(),
  };
  private abortController: AbortController | null = null;
  private eventCount = 0;

  constructor(private readonly options: SSEClientOptions) {}

  /**
   * 订阅事件，返回退订函数；同一事件可注册多个处理器
   */
  on<K extends keyof SSEClientEvents>(
    event: K,
    handler: (payload: SSEClientEvents[K]) => void,
  ): () => void {
    const set: Set<(payload: SSEClientEvents[K]) => void> = this.handlers[event];
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** 启动流式请求（一次性，非 idle 态调用抛错） */
  start(): void {
    if (this.state !== 'idle') {
      throw new Error(
        `SSEClient: cannot start() in '${this.state}' state (instance is single-use)`,
      );
    }
    this.state = 'running';
    void this.run();
  }

  /**
   * 取消流式请求（idle / closed 态为 no-op）。
   * 重试等待期间调用同样有效，归 done { reason: 'aborted' }。
   */
  abort(): void {
    if (this.state !== 'running') return;
    this.abortController?.abort();
  }

  private emit<K extends keyof SSEClientEvents>(event: K, payload: SSEClientEvents[K]): void {
    for (const handler of this.handlers[event]) {
      handler(payload);
    }
  }

  /**
   * 重连循环编排：每次迭代创建一个 ConnectionAttempt 并 await 其结局。
   * 终局判定（是否自动重试）在此处理；单次尝试的执行细节由 ConnectionAttempt 负责。
   */
  private async run(): Promise<void> {
    const clientController = new AbortController();
    this.abortController = clientController;
    const reconnect = ReconnectPolicy.resolve(this.options.reconnect);

    // 当前已使用的重试次数
    let attempt = 0;

    while (true) {
      const outcome = await this.runAttempt(clientController.signal);

      if (outcome.kind === 'complete') {
        this.finishDone('complete');
        break;
      }
      if (outcome.kind === 'aborted') {
        this.finishDone('aborted');
        break;
      }

      // outcome.kind === 'error'：仅在「首字节前 + 可重试类别 + 预算未耗尽」时自动重试
      if (!outcome.autoRetryable || reconnect === null || attempt >= reconnect.maxRetries) {
        this.finishError(outcome.error);
        break;
      }
      attempt += 1;
      // Retry-After 优先（封顶 maxDelay），无服务端指示才用指数退避 + 抖动
      const delay = reconnect.nextDelay(attempt, outcome.retryAfterMs);
      this.emit('reconnecting', { attempt, delay, error: outcome.error });
      if (await this.delay(delay, clientController.signal)) {
        this.finishDone('aborted'); // 重试等待期间被 abort，归正常终局
        break;
      }
    }
  }

  /** 创建并执行单次连接尝试，data 事件通过 onData 回调回传并在此计数 */
  private runAttempt(clientSignal: AbortSignal): Promise<StreamOutcome> {
    const attempt = new ConnectionAttempt(this.options, clientSignal, {
      onData: (parsed) => {
        this.eventCount++;
        this.emit('data', parsed);
      },
    });
    return attempt.run();
  }

  /** 等待 delay 毫秒，返回 true 表示等待期间被 abort */
  private delay(ms: number, signal: AbortSignal): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(signal.aborted);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        resolve(true);
      };
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort);
    });
  }

  private finishDone(reason: SSEDoneInfo['reason']): void {
    this.state = 'closed';
    this.emit('done', { reason, eventCount: this.eventCount });
  }

  private finishError(err: SSEClientError): void {
    this.state = 'closed';
    this.emit('error', err);
  }
}
