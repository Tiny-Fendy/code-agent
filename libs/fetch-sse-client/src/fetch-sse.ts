/**
 * 核心函数：fetchSSE
 *
 * 发起 SSE 流式请求，返回 AsyncGenerator<SSEStreamEvent>。
 * 包含流式解析、错误分类、自动重连、三层超时控制。
 *
 * 取消机制：直接使用原生 fetch 的 AbortSignal——外部 signal 与内部
 * 超时 signal 合并后传给 fetch，任何一方触发都会中断请求与流读取。
 *
 * 分层定位：
 * - 网络协议层：本函数，与具体业务无关
 * - 业务协议层：调用方（如 agent-core 的 OpenAICompatibleProvider）消费本函数产出的事件
 */

import type { FetchSSEOptions, SSEError, SSEStreamEvent } from './types';
import { createSSEParser } from './parser';
import { calculateReconnectDelay } from './reconnect';
import { createTimeoutController } from './timeout';

const DEFAULT_CONNECT_TIMEOUT = 10000;
const DEFAULT_READ_TIMEOUT = 30000;
const DEFAULT_TOTAL_TIMEOUT = 0;
const DEFAULT_MAX_RECONNECTS = 3;
const DEFAULT_RECONNECT_STRATEGY = 'exponential' as const;
const DEFAULT_BASE_RECONNECT_DELAY = 1000;
const DEFAULT_MAX_RECONNECT_DELAY = 30000;
const DEFAULT_RECONNECT_JITTER = 0.3;

/**
 * 发起 SSE 流式请求
 *
 * @param options 配置选项
 * @returns AsyncGenerator，逐步推送 SSEStreamEvent，流正常结束时产出 done
 */
export async function* fetchSSE(
  options: FetchSSEOptions,
): AsyncGenerator<SSEStreamEvent, void, unknown> {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    params,
    connectTimeout = DEFAULT_CONNECT_TIMEOUT,
    readTimeout = DEFAULT_READ_TIMEOUT,
    totalTimeout = DEFAULT_TOTAL_TIMEOUT,
    autoReconnect = false,
    maxReconnects = DEFAULT_MAX_RECONNECTS,
    reconnectStrategy = DEFAULT_RECONNECT_STRATEGY,
    baseReconnectDelay = DEFAULT_BASE_RECONNECT_DELAY,
    maxReconnectDelay = DEFAULT_MAX_RECONNECT_DELAY,
    reconnectJitter = DEFAULT_RECONNECT_JITTER,
    shouldReconnect,
    signal,
    fetchImpl = fetch,
    parseJson = false,
    jsonParseErrorStrategy = 'emit',
  } = options;

  // ---- 请求准备（整个生命周期只做一次） ----
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

  // 跨重连保留的最近事件 ID（断线续传）
  let lastEventId: string | undefined;
  let reconnectAttempt = 0;

  // ---- 主循环（含重连） ----
  while (true) {
    if (signal?.aborted) {
      yield { type: 'error', error: { type: 'abort', message: 'Aborted by signal', retryable: false } };
      return;
    }

    // 重连时通过请求头回传最近的事件 ID
    if (reconnectAttempt > 0 && lastEventId) {
      resolvedHeaders['Last-Event-ID'] = lastEventId;
    }

    const timeoutCtrl = createTimeoutController(connectTimeout, readTimeout, totalTimeout, signal);

    try {
      timeoutCtrl.startConnectTimer();

      const response = await fetchImpl(urlObj.toString(), {
        method,
        headers: resolvedHeaders,
        body: requestBody,
        signal: timeoutCtrl.controller.signal,
      });

      timeoutCtrl.cancelConnectTimer();

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const httpError: SSEError = {
          type: 'http',
          message: `HTTP ${response.status}: ${errorText || response.statusText}`,
          status: response.status,
          retryable: response.status >= 500 || response.status === 429,
        };
        throw httpError;
      }

      if (!response.body) {
        throw { type: 'network', message: 'Response body is empty', retryable: false } as SSEError;
      }

      // ---- 流式读取 + SSE 解析 ----
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const parser = createSSEParser();

      try {
        while (true) {
          timeoutCtrl.refreshReadTimer();

          const readResult = await reader.read();
          if (readResult.done) break;

          const events = parser.push(decoder.decode(readResult.value, { stream: true }));

          for (const event of events) {
            if (event.id) lastEventId = event.id;

            if (parseJson) {
              try {
                yield {
                  type: 'json',
                  event: { event: event.event, data: JSON.parse(event.data), id: event.id, retry: event.retry },
                };
              } catch (parseErr) {
                switch (jsonParseErrorStrategy) {
                  case 'emit':
                    yield {
                      type: 'error',
                      error: {
                        type: 'parse',
                        message: `JSON parse failed: ${(parseErr as Error).message}`,
                        cause: parseErr,
                        retryable: false,
                      },
                    };
                    break;
                  case 'raw':
                    // 回退为原始事件
                    yield { type: 'event', event };
                    break;
                  case 'skip':
                    break;
                }
              }
            } else {
              yield { type: 'event', event };
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // 流正常结束
      yield { type: 'done' };
      return;

    } catch (err) {
      const sseError = classifyError(err, timeoutCtrl, signal);

      // 是否重试：显式 shouldReconnect 优先，否则按 retryable 判断
      const canRetry =
        autoReconnect &&
        reconnectAttempt < maxReconnects &&
        !signal?.aborted &&
        (shouldReconnect ? shouldReconnect(sseError, reconnectAttempt) : sseError.retryable);

      if (!canRetry) {
        yield { type: 'error', error: sseError };
        return;
      }

      const delay = calculateReconnectDelay(
        reconnectAttempt,
        reconnectStrategy,
        baseReconnectDelay,
        maxReconnectDelay,
        reconnectJitter,
      );
      reconnectAttempt++;

      // 通知消费端即将重连（willRetry: true 表示流未终结）
      yield {
        type: 'error',
        error: { ...sseError, message: `Reconnecting in ${Math.round(delay)}ms: ${sseError.message}`, willRetry: true },
      };

      await sleep(delay);
    } finally {
      timeoutCtrl.dispose();
    }
  }
}

/** 错误分类：外部取消 > 三层超时 > 结构化错误 > 网络错误 */
function classifyError(
  err: unknown,
  timeoutCtrl: ReturnType<typeof createTimeoutController>,
  signal?: AbortSignal,
): SSEError {
  if (signal?.aborted) {
    return { type: 'abort', message: 'Aborted by signal', retryable: false };
  }
  if (timeoutCtrl.connectTimedOut) {
    return { type: 'timeout', message: 'Connect timeout', retryable: true };
  }
  if (timeoutCtrl.readTimedOut) {
    return { type: 'timeout', message: 'Read timeout', retryable: true };
  }
  if (timeoutCtrl.totalTimedOut) {
    return { type: 'timeout', message: 'Total timeout', retryable: true };
  }

  // 结构化错误（HTTP 错误等主动 throw 的 SSEError）
  if (typeof err === 'object' && err !== null && 'type' in err && 'retryable' in err) {
    return err as SSEError;
  }

  return {
    type: 'network',
    message: err instanceof Error ? err.message : String(err),
    cause: err,
    retryable: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
