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
 * - 主动 abort()（含重试等待、可见性暂停期间）→ done { reason: 'aborted' }（取消是正常终局）
 * - 其余失败 → error（SSEClientError）；开启 reconnect 时，首字节前的可重试失败
 *   （fetch 拒绝 / connect 超时 / 429 / 5xx）在重试预算耗尽前不发 error，
 *   仅以 reconnecting 事件通知中间态
 *
 * data 负载严格 JSON 解析：解析失败即 parse 错误终结（retryable 提示，不自动重试）；
 * [DONE] 哨兵是唯一例外——库内消化（不透传、不解析、不计数），主动关流并发 done。
 */

import { createSSEParser } from './parser.js';
import { createTimeoutController } from './timeout.js';
import { SSEClientError } from './errors.js';
import {
  calculateReconnectDelay,
  parseRetryAfterHeaders,
  resolveReconnectOptions,
} from './reconnect.js';
import type { ResolvedReconnectOptions } from './reconnect.js';
import type {
  SSEReconnectingInfo,
  SSEClientEvents,
  SSEClientOptions,
  SSEDoneInfo,
} from './types.js';

const DEFAULT_TIMEOUTS = { connect: 10_000, read: 30_000, total: 0 } as const;

/** OpenAI 系 API 约定俗成的流结束哨兵（严格解析策略的唯一例外） */
const DONE_SENTINEL = '[DONE]';

type ClientState = 'idle' | 'running' | 'closed';

/**
 * 单次连接尝试的结局（终局判定交由 run() 的重连循环处理）
 * - complete / aborted / hidden：本尝试结束，无错误
 * - error：失败；autoRetryable = retryable 且发生在首字节前；
 *   retryAfterMs 为 429/5xx 响应中服务端指示的重试延迟
 */
type StreamOutcome =
  | { kind: 'complete' }
  | { kind: 'aborted' }
  | { kind: 'hidden' }
  | { kind: 'error'; error: SSEClientError; autoRetryable: boolean; retryAfterMs?: number };

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
  /** 当前连接尝试的可见性中止控制器：visibilitychange(hidden) 处理器据此中止当前请求 */
  private hiddenController: AbortController | null = null;
  private eventCount = 0;
  /** 最后一个被分发 SSE 事件的 id（重连时按 W3C 标准回传 Last-Event-ID） */
  private lastEventId: string | null = null;

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
   * 重试等待、可见性暂停期间调用同样有效，归 done { reason: 'aborted' }。
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

  private async run(): Promise<void> {
    const clientController = new AbortController();
    this.abortController = clientController;
    const reconnect = resolveReconnectOptions(this.options.reconnect);

    // 可见性重连：仅浏览器环境生效（typeof document 守卫），Node 下静默 no-op
    const visibilityEnabled =
      reconnect?.reconnectOnVisible === true && typeof document !== 'undefined';
    const onVisibilityChange = () => {
      // 隐藏时中止当前请求（无进行中的尝试时为 no-op），由重连循环转入暂停-恢复流程
      if (document.hidden) this.hiddenController?.abort();
    };
    if (visibilityEnabled) {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    // 当前连接轮次内已使用的重试次数（错误重试共享预算；可见性恢复开启新轮次时归零）
    let attempt = 0;

    try {
      while (true) {
        // start 时或轮次间已处于隐藏状态：先等可见（无流可暂停，不发 reconnecting）
        if (visibilityEnabled && document.hidden) {
          if (await this.waitForVisible(clientController.signal)) break;
        }

        const outcome = await this.runStream(clientController.signal);

        if (outcome.kind === 'complete') {
          this.finishDone('complete');
          break;
        }
        if (outcome.kind === 'aborted') {
          this.finishDone('aborted');
          break;
        }
        if (outcome.kind === 'hidden') {
          // 页面隐藏暂停：不发 done / error，等可见后以新连接轮次恢复
          this.emit('reconnecting', { reason: 'hidden' });
          if (await this.waitForVisible(clientController.signal)) {
            this.finishDone('aborted'); // 暂停期间 abort 照常有效
            break;
          }
          attempt = 0; // 新连接轮次的重试预算独立
          continue;
        }

        // outcome.kind === 'error'：仅在「首字节前 + 可重试类别 + 预算未耗尽」时自动重试
        if (!outcome.autoRetryable || reconnect === null || attempt >= reconnect.maxRetries) {
          this.finishError(outcome.error);
          break;
        }
        attempt += 1;
        // Retry-After 优先（封顶 maxDelay），无服务端指示才用指数退避 + 抖动
        const delay =
          outcome.retryAfterMs !== undefined
            ? Math.min(outcome.retryAfterMs, reconnect.maxDelay)
            : calculateReconnectDelay(attempt, reconnect);
        this.emit('reconnecting', { reason: 'error', attempt, delay, error: outcome.error });
        if (await this.delay(delay, clientController.signal)) {
          this.finishDone('aborted'); // 重试等待期间被 abort，归正常终局
          break;
        }
      }
    } finally {
      if (visibilityEnabled) {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    }
  }

  /** 等待页面可见，返回 true 表示等待期间被 abort */
  private waitForVisible(signal: AbortSignal): Promise<boolean> {
    if (!document.hidden) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const onVisibilityChange = () => {
        if (!document.hidden) {
          cleanup();
          resolve(false);
        }
      };
      const onAbort = () => {
        cleanup();
        resolve(true);
      };
      const cleanup = () => {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        signal.removeEventListener('abort', onAbort);
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      signal.addEventListener('abort', onAbort);
    });
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

  /**
   * 单次连接尝试：请求准备 → fetch → 流式读取。
   * 中止来源：clientSignal（用户 abort）、hiddenController（可见性暂停）、三层超时。
   */
  private async runStream(clientSignal: AbortSignal): Promise<StreamOutcome> {
    const hiddenController = new AbortController();
    this.hiddenController = hiddenController;
    // 失败阶段：prep（请求准备）/ connect（响应头前）/ read（流读取中）——自动重试仅限首字节前
    let phase: 'prep' | 'connect' | 'read' = 'prep';
    let retryAfterMs: number | undefined;

    // 合并外部信号：clientSignal 与 hiddenController 任一触发即中止本尝试。
    // 手动合并以兼容 Node 18（AbortSignal.any 需 Node 20.3+）；once 监听在 finally 中显式清理防泄漏。
    const attemptController = new AbortController();
    const onClientAbort = () => attemptController.abort();
    const onHiddenAbort = () => attemptController.abort();
    clientSignal.addEventListener('abort', onClientAbort, { once: true });
    hiddenController.signal.addEventListener('abort', onHiddenAbort, { once: true });

    const {
      url,
      method = 'GET',
      headers = {},
      body,
      params,
      timeouts,
      onOpen,
      fetchImpl = fetch,
    } = this.options;
    const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
    const timeoutCtrl = createTimeoutController(
      t.connect,
      t.read,
      t.total,
      attemptController.signal,
    );

    try {
      // ---- 请求准备（每次尝试独立求值 headers，重连场景支持动态刷新 token） ----
      const urlObj = new URL(url);
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined) urlObj.searchParams.set(key, String(value));
        }
      }

      const resolvedHeaders: Record<string, string> =
        typeof headers === 'function' ? headers() : { ...headers };
      // W3C EventSource 标准：重连时回传最后收到的事件 id（首字节前的错误重试无 id，不回传）
      if (this.lastEventId !== null) {
        resolvedHeaders['Last-Event-ID'] = this.lastEventId;
      }

      let requestBody: BodyInit | undefined;
      if (body !== undefined) {
        if (
          typeof body === 'string' ||
          body instanceof FormData ||
          body instanceof URLSearchParams ||
          body instanceof Blob ||
          body instanceof ArrayBuffer ||
          body instanceof Uint8Array
        ) {
          requestBody = body as BodyInit;
        } else {
          // 普通对象 → JSON 序列化，并补默认 Content-Type
          requestBody = JSON.stringify(body);
          if (!resolvedHeaders['Content-Type']) {
            resolvedHeaders['Content-Type'] = 'application/json';
          }
        }
      }

      // ---- 发起请求 ----
      phase = 'connect';
      timeoutCtrl.startConnectTimer();

      const response = await fetchImpl(urlObj.toString(), {
        method,
        headers: resolvedHeaders,
        body: requestBody,
        signal: timeoutCtrl.controller.signal,
      });

      timeoutCtrl.cancelConnectTimer();

      // 默认 response.ok 检查（始终先执行）
      if (!response.ok) {
        // 429 / 5xx 可重试（body 未消费，重放安全），优先尊重服务端 Retry-After 指示
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable) {
          retryAfterMs = parseRetryAfterHeaders(response.headers) ?? undefined;
        }
        const errorText = await response.text().catch(() => '');
        throw new SSEClientError(
          'http',
          `HTTP ${response.status}: ${errorText || response.statusText}`,
          { status: response.status, retryable },
        );
      }

      // 响应头附加校验钩子：抛错即终结（归 http 错误，重试无意义）
      if (onOpen) {
        try {
          await onOpen(response);
        } catch (err) {
          throw new SSEClientError(
            'http',
            err instanceof Error ? err.message : String(err),
            { status: response.status, cause: err, retryable: false },
          );
        }
      }

      if (!response.body) {
        // 响应头已到但无 body：首字节前失败，可安全重试
        throw new SSEClientError('network', 'Response body is empty', { retryable: true });
      }

      // ---- 流式读取 + SSE 解析 + 严格 JSON 解析 ----
      phase = 'read';
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const parser = createSSEParser();
      let doneSentinelHit = false;

      try {
        while (true) {
          timeoutCtrl.refreshReadTimer();

          const { done, value } = await reader.read();
          if (done) break;

          const events = parser.push(decoder.decode(value, { stream: true }));
          for (const event of events) {
            if (event.data === DONE_SENTINEL) {
              // [DONE] 哨兵：不透传、不解析、不计数，主动关流
              doneSentinelHit = true;
              break;
            }
            if (event.id !== undefined) {
              // 记录最后被分发事件的 id，重连时按标准回传 Last-Event-ID
              this.lastEventId = event.id;
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(event.data);
            } catch (parseErr) {
              // 流中途解析失败：终结不自动重试，retryable 仅供消费方整体重发提示
              throw new SSEClientError(
                'parse',
                `JSON parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
                { cause: parseErr, retryable: true },
              );
            }
            this.eventCount++;
            this.emit('data', parsed);
          }
          if (doneSentinelHit) break;
        }
      } finally {
        // 主动关流 / 正常结束 / 异常退出：统一取消读取并释放锁
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }

      // abort 可能使 read() 以 done:true 收尾而非 reject，统一归 aborted
      return clientSignal.aborted ? { kind: 'aborted' } : { kind: 'complete' };
    } catch (err) {
      if (clientSignal.aborted) {
        // 主动取消是正常终局，归 done 而非 error
        return { kind: 'aborted' };
      }
      if (timeoutCtrl.totalTimedOut) {
        // total 超时终结，不可被重试绕过，也不被可见性暂停掩盖
        return {
          kind: 'error',
          error: new SSEClientError('timeout', 'Total timeout', { cause: err }),
          autoRetryable: false,
        };
      }
      if (hiddenController.signal.aborted) {
        // 可见性暂停：不发 done / error，由重连循环转入等待-恢复流程
        return { kind: 'hidden' };
      }
      const error = this.classifyError(err, timeoutCtrl, phase);
      // 自动重试仅限首字节前（phase 非 read）的可重试类别错误
      return {
        kind: 'error',
        error,
        autoRetryable: error.retryable && phase !== 'read',
        retryAfterMs,
      };
    } finally {
      this.hiddenController = null;
      timeoutCtrl.dispose();
      clientSignal.removeEventListener('abort', onClientAbort);
      hiddenController.signal.removeEventListener('abort', onHiddenAbort);
    }
  }

  /**
   * 错误分类：结构化错误优先，其次 connect / read 超时，其余按失败阶段归网络错误。
   * retryable：connect 超时与首字节前网络错误可自动重试；read 超时与流中断仅作提示；
   * prep 阶段失败（URL 非法 / headers 函数抛错等）属配置问题，重试无意义。
   */
  private classifyError(
    err: unknown,
    timeoutCtrl: ReturnType<typeof createTimeoutController>,
    phase: 'prep' | 'connect' | 'read',
  ): SSEClientError {
    if (err instanceof SSEClientError) return err;
    if (timeoutCtrl.connectTimedOut) {
      return new SSEClientError('timeout', 'Connect timeout', { cause: err, retryable: true });
    }
    if (timeoutCtrl.readTimedOut) {
      return new SSEClientError('timeout', 'Read timeout', { cause: err, retryable: true });
    }
    return new SSEClientError('network', err instanceof Error ? err.message : String(err), {
      cause: err,
      retryable: phase !== 'prep',
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
