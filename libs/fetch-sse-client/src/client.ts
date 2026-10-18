/**
 * SSEClient：基于 fetch 的 SSE 流式客户端
 *
 * 生命周期状态机：idle → running → closed
 * - start() 仅 idle 态可用（实例一次性），重复调用抛错
 * - abort() 仅 running 态有效，其余状态为 no-op
 *
 * 终局语义：done 与 error 互斥且只发一次
 * - 服务端关闭连接 / 收到 [DONE] 哨兵 → done { reason: 'complete' }
 * - 主动 abort() → done { reason: 'aborted' }（取消是正常终局，非错误）
 * - 网络失败 / 三层超时 / HTTP 非 2xx / onOpen 抛错 / JSON 解析失败 → error（SSEClientError）
 *
 * data 负载严格 JSON 解析：解析失败即 parse 错误终结；
 * [DONE] 哨兵是唯一例外——库内消化（不透传、不解析、不计数），主动关流并发 done。
 */

import { createSSEParser } from './parser.js';
import { createTimeoutController } from './timeout.js';
import { SSEClientError } from './errors.js';
import type { SSEClientEvents, SSEClientOptions, SSEDoneInfo } from './types.js';

const DEFAULT_TIMEOUTS = { connect: 10_000, read: 30_000, total: 0 } as const;

/** OpenAI 系 API 约定俗成的流结束哨兵（严格解析策略的唯一例外） */
const DONE_SENTINEL = '[DONE]';

type ClientState = 'idle' | 'running' | 'closed';

export class SSEClient {
  private state: ClientState = 'idle';
  private readonly handlers: {
    [K in keyof SSEClientEvents]: Set<(payload: SSEClientEvents[K]) => void>;
  } = {
    data: new Set<(payload: unknown) => void>(),
    done: new Set<(payload: SSEDoneInfo) => void>(),
    error: new Set<(payload: SSEClientError) => void>(),
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
   * 取消归 done { reason: 'aborted' }，非错误。
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
    // 取消封装：内部 AbortController 对消费端零暴露，作为外部信号并入超时控制器
    const abortController = new AbortController();
    this.abortController = abortController;

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
    const timeoutCtrl = createTimeoutController(t.connect, t.read, t.total, abortController.signal);

    try {
      // ---- 请求准备 ----
      const urlObj = new URL(url);
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined) urlObj.searchParams.set(key, String(value));
        }
      }

      const resolvedHeaders: Record<string, string> =
        typeof headers === 'function' ? headers() : { ...headers };

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
        const errorText = await response.text().catch(() => '');
        throw new SSEClientError(
          'http',
          `HTTP ${response.status}: ${errorText || response.statusText}`,
          { status: response.status },
        );
      }

      // 响应头附加校验钩子：抛错即终结（归 http 错误）
      if (onOpen) {
        try {
          await onOpen(response);
        } catch (err) {
          throw new SSEClientError(
            'http',
            err instanceof Error ? err.message : String(err),
            { status: response.status, cause: err },
          );
        }
      }

      if (!response.body) {
        throw new SSEClientError('network', 'Response body is empty');
      }

      // ---- 流式读取 + SSE 解析 + 严格 JSON 解析 ----
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
            let parsed: unknown;
            try {
              parsed = JSON.parse(event.data);
            } catch (parseErr) {
              throw new SSEClientError(
                'parse',
                `JSON parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
                { cause: parseErr },
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

      this.finishDone(abortController.signal.aborted ? 'aborted' : 'complete');
    } catch (err) {
      if (abortController.signal.aborted) {
        // 主动取消是正常终局，归 done 而非 error
        this.finishDone('aborted');
        return;
      }
      this.finishError(this.classifyError(err, timeoutCtrl));
    } finally {
      timeoutCtrl.dispose();
    }
  }

  /** 错误分类：结构化错误优先，其次三层超时，其余归网络错误 */
  private classifyError(
    err: unknown,
    timeoutCtrl: ReturnType<typeof createTimeoutController>,
  ): SSEClientError {
    if (err instanceof SSEClientError) return err;
    if (timeoutCtrl.connectTimedOut) {
      return new SSEClientError('timeout', 'Connect timeout', { cause: err });
    }
    if (timeoutCtrl.readTimedOut) {
      return new SSEClientError('timeout', 'Read timeout', { cause: err });
    }
    if (timeoutCtrl.totalTimedOut) {
      return new SSEClientError('timeout', 'Total timeout', { cause: err });
    }
    return new SSEClientError('network', err instanceof Error ? err.message : String(err), {
      cause: err,
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
