/**
 * 单次连接尝试（ConnectionAttempt）
 *
 * 承载一次 HTTP 尝试的完整生命周期：
 * 请求准备 → fetch 发起 → 响应校验 → 流式读取（SSE 解析 + [DONE] 哨兵 + 严格 JSON）→ 结局归类。
 *
 * 中止来源：clientSignal（用户 abort）、三层超时。
 * 终局判定（是否自动重试）交由 SSEClient 的重连循环处理，本类只输出 StreamOutcome。
 */

import { SSEParser } from './parser.js';
import { TimeoutController } from './timeout.js';
import { SSEClientError } from './errors.js';
import { parseRetryAfterHeaders } from './reconnect.js';
import { prepareRequest, type RequestOptions } from './request.js';
import type { SSEClientOptions } from './types.js';

const DEFAULT_TIMEOUTS = { connect: 10_000, read: 30_000, total: 0 } as const;

/** OpenAI 系 API 约定俗成的流结束哨兵（严格解析策略的唯一例外） */
const DONE_SENTINEL = '[DONE]';

/** 单次连接尝试的失败阶段（自动重试仅限首字节前，即非 Read） */
export enum StreamPhase {
  Prep = 'prep',
  Connect = 'connect',
  Read = 'read',
}

/**
 * 单次连接尝试的结局（终局判定交由 SSEClient 重连循环处理）
 * - complete / aborted：本尝试结束，无错误
 * - error：失败；autoRetryable = retryable 且发生在首字节前；
 *   retryAfterMs 为 429/5xx 响应中服务端指示的重试延迟
 */
export type StreamOutcome =
  | { kind: 'complete' }
  | { kind: 'aborted' }
  | { kind: 'error'; error: SSEClientError; autoRetryable: boolean; retryAfterMs?: number };

/** ConnectionAttempt 的回调钩子 */
export interface ConnectionAttemptHooks {
  /** 每个成功解析的 data 负载回调（SSEClient 在此累加 eventCount 并 emit data） */
  onData: (parsed: unknown) => void;
}

/** ConnectionAttempt 所需的 options 子集 */
type AttemptOptions = RequestOptions &
  Pick<SSEClientOptions, 'timeouts' | 'onOpen' | 'fetchImpl'>;

export class ConnectionAttempt {
  private phase: StreamPhase = StreamPhase.Prep;
  private retryAfterMs: number | undefined;

  constructor(
    private readonly options: AttemptOptions,
    private readonly clientSignal: AbortSignal,
    private readonly hooks: ConnectionAttemptHooks,
  ) {}

  /** 执行单次连接尝试，返回结局（编排层：信号合并 + 超时 + 分段执行 + 结局归类） */
  async run(): Promise<StreamOutcome> {
    // 合并外部信号：clientSignal 触发即中止本尝试。
    // 手动合并以兼容 Node 18（AbortSignal.any 需 Node 20.3+）；once 监听在 finally 中显式清理防泄漏。
    const attemptController = new AbortController();
    const onClientAbort = () => attemptController.abort();
    this.clientSignal.addEventListener('abort', onClientAbort, { once: true });

    const { timeouts, fetchImpl = fetch } = this.options;
    const t = { ...DEFAULT_TIMEOUTS, ...timeouts };
    const timeoutCtrl = new TimeoutController(t.connect, t.read, t.total, attemptController.signal);

    try {
      const response = await this.fetchResponse(timeoutCtrl, fetchImpl);
      await this.assertResponseUsable(response);
      await this.readStream(response, timeoutCtrl);
      // abort 可能使 read() 以 done:true 收尾而非 reject，统一归 aborted
      return this.clientSignal.aborted ? { kind: 'aborted' } : { kind: 'complete' };
    } catch (err) {
      return this.handleError(err, timeoutCtrl);
    } finally {
      timeoutCtrl.dispose();
      this.clientSignal.removeEventListener('abort', onClientAbort);
    }
  }

  /** 请求准备（每次尝试独立求值 headers，重连场景支持动态刷新 token）+ 发起 fetch */
  private async fetchResponse(
    timeoutCtrl: TimeoutController,
    fetchImpl: typeof fetch,
  ): Promise<Response> {
    const { url, init } = prepareRequest(this.options);
    this.phase = StreamPhase.Connect;
    timeoutCtrl.startConnectTimer();
    const response = await fetchImpl(url, { ...init, signal: timeoutCtrl.controller.signal });
    timeoutCtrl.cancelConnectTimer();
    return response;
  }

  /** 响应可用性校验：response.ok → onOpen → body 存在，任一步失败抛 SSEClientError */
  private async assertResponseUsable(response: Response): Promise<void> {
    if (!response.ok) {
      // 429 / 5xx 可重试（body 未消费，重放安全），优先尊重服务端 Retry-After 指示
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable) {
        this.retryAfterMs = parseRetryAfterHeaders(response.headers) ?? undefined;
      }
      const errorText = await response.text().catch(() => '');
      throw new SSEClientError(
        'http',
        `HTTP ${response.status}: ${errorText || response.statusText}`,
        { status: response.status, retryable },
      );
    }

    // 响应头附加校验钩子：抛错即终结（归 http 错误，重试无意义）
    if (this.options.onOpen) {
      try {
        await this.options.onOpen(response);
      } catch (err) {
        throw new SSEClientError('http', err instanceof Error ? err.message : String(err), {
          status: response.status,
          cause: err,
          retryable: false,
        });
      }
    }

    // 响应头已到但无 body：首字节前失败，可安全重试
    if (!response.body) {
      throw new SSEClientError('network', 'Response body is empty', { retryable: true });
    }
  }

  /** 流式读取循环：SSE 解析 → [DONE] 哨兵判定 → 严格 JSON 解析 → onData 回调 */
  private async readStream(response: Response, timeoutCtrl: TimeoutController): Promise<void> {
    this.phase = StreamPhase.Read;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder('utf-8');
    const parser = new SSEParser();
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
            // 流中途解析失败：终结不自动重试，retryable 仅供消费方整体重发提示
            throw new SSEClientError(
              'parse',
              `JSON parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
              { cause: parseErr, retryable: true },
            );
          }
          this.hooks.onData(parsed);
        }
        if (doneSentinelHit) break;
      }
    } finally {
      // 主动关流 / 正常结束 / 异常退出：统一取消读取并释放锁
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  /** catch 分支结局归类：abort 归正常终局；total 超时不可重试；其余按 classifyError 分类 */
  private handleError(err: unknown, timeoutCtrl: TimeoutController): StreamOutcome {
    if (this.clientSignal.aborted) {
      return { kind: 'aborted' }; // 主动取消是正常终局，归 done 而非 error
    }
    if (timeoutCtrl.totalTimedOut) {
      // total 超时终结，不可被重试绕过
      return {
        kind: 'error',
        error: new SSEClientError('timeout', 'Total timeout', { cause: err }),
        autoRetryable: false,
      };
    }
    const error = this.classifyError(err, timeoutCtrl);
    // 自动重试仅限首字节前（phase 非 Read）的可重试类别错误
    return {
      kind: 'error',
      error,
      autoRetryable: error.retryable && this.phase !== StreamPhase.Read,
      retryAfterMs: this.retryAfterMs,
    };
  }

  /**
   * 错误分类：结构化错误优先，其次 connect / read 超时，其余按失败阶段归网络错误。
   * retryable：connect 超时与首字节前网络错误可自动重试；read 超时与流中断仅作提示；
   * prep 阶段失败（URL 非法 / headers 函数抛错等）属配置问题，重试无意义。
   */
  private classifyError(err: unknown, timeoutCtrl: TimeoutController): SSEClientError {
    if (err instanceof SSEClientError) return err;
    if (timeoutCtrl.connectTimedOut) {
      return new SSEClientError('timeout', 'Connect timeout', { cause: err, retryable: true });
    }
    if (timeoutCtrl.readTimedOut) {
      return new SSEClientError('timeout', 'Read timeout', { cause: err, retryable: true });
    }
    return new SSEClientError('network', err instanceof Error ? err.message : String(err), {
      cause: err,
      retryable: this.phase !== StreamPhase.Prep,
    });
  }
}
