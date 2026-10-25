import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConnectionAttempt } from '@/connection';
import type { StreamOutcome } from '@/connection';
import { SSEClientError } from '@/errors';

const encoder = new TextEncoder();

/** 构造一次性发送全部内容的 SSE Response */
function sseResponse(parts: string[], init?: ResponseInit): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    ...init,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

/** 便捷执行：创建 attempt 并 run，收集 onData 调用 */
async function runAttempt(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  opts: Record<string, unknown> = {},
): Promise<{ outcome: StreamOutcome; data: unknown[] }> {
  const data: unknown[] = [];
  const attempt = new ConnectionAttempt(
    { url: 'http://test/s', fetchImpl: fetchImpl as unknown as typeof fetch, ...opts },
    signal,
    { onData: (parsed) => data.push(parsed) },
  );
  const outcome = await attempt.run();
  return { outcome, data };
}

describe('ConnectionAttempt 结局归类', () => {
  it('正常消费流至终局 → complete，onData 按序回调', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['data: {"v":1}\n\n', 'data: {"v":2}\n\n']),
    );
    const { outcome, data } = await runAttempt(fetchImpl, new AbortController().signal);

    expect(outcome).toEqual({ kind: 'complete' });
    expect(data).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('clientSignal 已 abort → aborted（即使 fetch 成功）', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"v":1}\n\n']));

    const { outcome } = await runAttempt(fetchImpl, controller.signal);

    expect(outcome).toEqual({ kind: 'aborted' });
  });

  it('fetch 拒绝（首字节前）→ error network，autoRetryable=true', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const { outcome } = await runAttempt(fetchImpl, new AbortController().signal);

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.type).toBe('network');
      expect(outcome.error.retryable).toBe(true);
      expect(outcome.autoRetryable).toBe(true);
    }
  });

  it('HTTP 429 → error http，retryable=true，retryAfterMs 解析 retry-after-ms', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('rate limited', { status: 429, headers: { 'retry-after-ms': '250' } }),
    );

    const { outcome } = await runAttempt(fetchImpl, new AbortController().signal);

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.type).toBe('http');
      expect(outcome.error.status).toBe(429);
      expect(outcome.error.retryable).toBe(true);
      expect(outcome.autoRetryable).toBe(true);
      expect(outcome.retryAfterMs).toBe(250);
    }
  });

  it('HTTP 400（非可重试状态）→ error http，retryable=false，autoRetryable=false', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }));

    const { outcome } = await runAttempt(fetchImpl, new AbortController().signal);

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.type).toBe('http');
      expect(outcome.error.status).toBe(400);
      expect(outcome.error.retryable).toBe(false);
      expect(outcome.autoRetryable).toBe(false);
    }
  });

  it('onOpen 抛错 → error http，retryable=false', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"v":1}\n\n']));
    const onOpen = vi.fn(() => {
      throw new Error('content-type mismatch');
    });

    const { outcome } = await runAttempt(fetchImpl, new AbortController().signal, { onOpen });

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.type).toBe('http');
      expect(outcome.error.retryable).toBe(false);
      expect(outcome.autoRetryable).toBe(false);
    }
  });

  it('响应无 body → error network，retryable=true（首字节前）', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    const { outcome } = await runAttempt(fetchImpl, new AbortController().signal);

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.type).toBe('network');
      expect(outcome.error.retryable).toBe(true);
      expect(outcome.autoRetryable).toBe(true);
    }
  });

  it('[DONE] 哨兵不透传、不触发 onData，主动关流归 complete', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['data: {"v":1}\n\n', 'data: [DONE]\n\n', 'data: {"v":2}\n\n']),
    );

    const { outcome, data } = await runAttempt(fetchImpl, new AbortController().signal);

    expect(outcome).toEqual({ kind: 'complete' });
    expect(data).toEqual([{ v: 1 }]); // 哨兵后的数据不消费
  });

  it('data 非 JSON → error parse，retryable=true 但 autoRetryable=false（流中途）', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: not-json\n\n']));

    const { outcome, data } = await runAttempt(fetchImpl, new AbortController().signal);

    expect(data).toEqual([]);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.type).toBe('parse');
      expect(outcome.error.retryable).toBe(true);
      expect(outcome.autoRetryable).toBe(false); // 流中途失败不自动重试
    }
  });

  it('connect 超时 → error timeout，autoRetryable=true（首字节前）', async () => {
    vi.useFakeTimers();
    // mock fetch：监听 signal，abort 时 reject（模拟真实 fetch 行为）
    const fetchImpl = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const signal = new AbortController().signal;

    const attempt = new ConnectionAttempt(
      { url: 'http://test/s', fetchImpl: fetchImpl as unknown as typeof fetch, timeouts: { connect: 100 } },
      signal,
      { onData: () => {} },
    );
    const outcomePromise = attempt.run();
    vi.advanceTimersByTime(100);
    const outcome = await outcomePromise;

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.type).toBe('timeout');
      expect(outcome.error.message).toBe('Connect timeout');
      expect(outcome.autoRetryable).toBe(true);
    }
  });

  it('total 超时 → error timeout，autoRetryable=false（不可被重试绕过）', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const signal = new AbortController().signal;

    const attempt = new ConnectionAttempt(
      { url: 'http://test/s', fetchImpl: fetchImpl as unknown as typeof fetch, timeouts: { total: 50 } },
      signal,
      { onData: () => {} },
    );
    const outcomePromise = attempt.run();
    vi.advanceTimersByTime(50);
    const outcome = await outcomePromise;

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.type).toBe('timeout');
      expect(outcome.autoRetryable).toBe(false);
    }
  });

  it('HTTP 错误 body 为空 → message 回退到 statusText', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 500, statusText: 'Internal Server Error' }),
    );

    const { outcome } = await runAttempt(fetchImpl, new AbortController().signal);

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.type).toBe('http');
      expect(outcome.error.message).toContain('Internal Server Error');
    }
  });

  it('onOpen 抛非 Error 值 → error http，message 用 String() 转换', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"v":1}\n\n']));
    const onOpen = vi.fn(() => {
      throw 'string error from onOpen';
    });

    const { outcome } = await runAttempt(fetchImpl, new AbortController().signal, { onOpen });

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.type).toBe('http');
      expect(outcome.error.message).toContain('string error from onOpen');
    }
  });

  it('fetch 抛非 Error 值 → error network，message 用 String() 转换', async () => {
    const fetchImpl = vi.fn(async () => {
      throw 'fetch failed as string';
    });

    const { outcome } = await runAttempt(fetchImpl, new AbortController().signal);

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.type).toBe('network');
      expect(outcome.error.message).toContain('fetch failed as string');
    }
  });

  it('connect=0（不限）时成功流 → cancelConnectTimer 走空分支无异常', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"v":1}\n\n']));

    const { outcome, data } = await runAttempt(fetchImpl, new AbortController().signal, {
      timeouts: { connect: 0 },
    });

    expect(outcome).toEqual({ kind: 'complete' });
    expect(data).toEqual([{ v: 1 }]);
  });
});
