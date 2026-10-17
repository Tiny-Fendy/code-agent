import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchSSE } from '@/fetch-sse';
import type { SSEError, SSEStreamEvent } from '@/types';

const encoder = new TextEncoder();

/** 收集生成器产出的全部事件 */
async function collect(gen: AsyncGenerator<SSEStreamEvent>): Promise<SSEStreamEvent[]> {
  const events: SSEStreamEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

/** 构造一次性发送全部内容的 SSE Response */
function sseResponse(parts: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchSSE 基础流式消费', () => {
  it('端到端消费 SSE 流并产出 done', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['data: {"v":1}\n\n', 'event: end\ndata: bye\n\n']),
    );

    const events = await collect(fetchSSE({ url: 'http://test/stream', fetchImpl }));

    expect(events).toEqual([
      { type: 'event', event: { event: 'message', data: '{"v":1}' } },
      { type: 'event', event: { event: 'end', data: 'bye' } },
      { type: 'done' },
    ]);
  });

  it('事件跨 chunk 拆分时边界正确', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['data: hel', 'lo\n\ndata: wo', 'rld\n\n']),
    );

    const events = await collect(fetchSSE({ url: 'http://test/stream', fetchImpl }));

    expect(events).toEqual([
      { type: 'event', event: { event: 'message', data: 'hello' } },
      { type: 'event', event: { event: 'message', data: 'world' } },
      { type: 'done' },
    ]);
  });

  it('传递 method/headers/body/params', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      capturedUrl = url;
      capturedInit = init;
      return sseResponse(['data: ok\n\n']);
    });

    await collect(fetchSSE({
      url: 'http://test/api/stream',
      method: 'POST',
      headers: () => ({ Authorization: 'Bearer t' }),
      body: { q: 'hi' },
      params: { a: 1, b: undefined },
      fetchImpl,
    }));

    expect(capturedUrl).toBe('http://test/api/stream?a=1');
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe('Bearer t');
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(capturedInit?.body).toBe(JSON.stringify({ q: 'hi' }));
  });
});

describe('fetchSSE JSON 解析', () => {
  it('parseJson=true 时产出 json 事件', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"v":1}\n\n']));

    const events = await collect(fetchSSE({
      url: 'http://test/stream', fetchImpl, parseJson: true,
    }));

    expect(events).toEqual([
      { type: 'json', event: { event: 'message', data: { v: 1 } } },
      { type: 'done' },
    ]);
  });

  it('jsonParseErrorStrategy=emit：解析失败产出 parse error', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: not-json\n\n']));

    const events = await collect(fetchSSE({
      url: 'http://test/stream', fetchImpl, parseJson: true, jsonParseErrorStrategy: 'emit',
    }));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('error');
    expect((events[0] as { error: SSEError }).error.type).toBe('parse');
    expect(events[1]).toEqual({ type: 'done' });
  });

  it('jsonParseErrorStrategy=skip：静默跳过', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: not-json\n\n']));

    const events = await collect(fetchSSE({
      url: 'http://test/stream', fetchImpl, parseJson: true, jsonParseErrorStrategy: 'skip',
    }));

    expect(events).toEqual([{ type: 'done' }]);
  });

  it('jsonParseErrorStrategy=raw：回退产出原始事件', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: not-json\n\n']));

    const events = await collect(fetchSSE({
      url: 'http://test/stream', fetchImpl, parseJson: true, jsonParseErrorStrategy: 'raw',
    }));

    expect(events).toEqual([
      { type: 'event', event: { event: 'message', data: 'not-json' } },
      { type: 'done' },
    ]);
  });
});

describe('fetchSSE 错误分类', () => {
  it('HTTP 404 → 终结 error（http，不可重试）', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));

    const events = await collect(fetchSSE({ url: 'http://test/s', fetchImpl }));

    expect(events).toHaveLength(1);
    const err = (events[0] as { error: SSEError }).error;
    expect(err.type).toBe('http');
    expect(err.status).toBe(404);
    expect(err.retryable).toBe(false);
    expect(err.willRetry).toBeUndefined();
  });

  it('fetch 拒绝 → network 错误', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const events = await collect(fetchSSE({ url: 'http://test/s', fetchImpl }));

    expect(events).toHaveLength(1);
    const err = (events[0] as { error: SSEError }).error;
    expect(err.type).toBe('network');
    expect(err.retryable).toBe(true);
  });

  it('响应体为空 → network 错误且不重试', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    const events = await collect(fetchSSE({ url: 'http://test/s', fetchImpl }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect((events[0] as { error: SSEError }).error.type).toBe('network');
  });
});

describe('fetchSSE 自动重连', () => {
  it('默认不自动重连', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const events = await collect(fetchSSE({ url: 'http://test/s', fetchImpl }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });

  it('HTTP 500 触发自动重连，成功后恢复消费', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls <= 2) return new Response('boom', { status: 500 });
      return sseResponse(['data: ok\n\n']);
    });

    const events = await collect(fetchSSE({
      url: 'http://test/s',
      fetchImpl,
      autoReconnect: true,
      maxReconnects: 3,
      baseReconnectDelay: 1,
      reconnectJitter: 0,
    }));

    expect(calls).toBe(3);
    const errors = events.filter(e => e.type === 'error') as { error: SSEError }[];
    expect(errors).toHaveLength(2);
    expect(errors[0].error.willRetry).toBe(true);
    expect(errors[0].error.type).toBe('http');
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });

  it('超过最大重连次数后终结 error', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));

    const events = await collect(fetchSSE({
      url: 'http://test/s',
      fetchImpl,
      autoReconnect: true,
      maxReconnects: 2,
      baseReconnectDelay: 1,
      reconnectJitter: 0,
    }));

    expect(fetchImpl).toHaveBeenCalledTimes(3); // 首次 + 2 次重连
    const last = events[events.length - 1] as { type: string; error?: SSEError };
    expect(last.type).toBe('error');
    expect(last.error?.willRetry).toBeUndefined();
  });

  it('shouldReconnect 返回 false 时不重试', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await collect(fetchSSE({
      url: 'http://test/s',
      fetchImpl,
      autoReconnect: true,
      maxReconnects: 3,
      baseReconnectDelay: 1,
      shouldReconnect: () => false,
    }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('重连时通过 Last-Event-ID 头回传最近的事件 id', async () => {
    const headersSeen: Array<Record<string, string>> = [];
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      calls++;
      headersSeen.push({ ...init.headers });
      if (calls === 1) {
        // 推送带 id 的事件后模拟连接中断
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('id: 42\ndata: hello\n\n'));
            setTimeout(() => controller.error(new Error('connection lost')), 5);
          },
        });
        return new Response(stream, { status: 200 });
      }
      return sseResponse(['data: resumed\n\n']);
    });

    const events = await collect(fetchSSE({
      url: 'http://test/s',
      fetchImpl,
      autoReconnect: true,
      maxReconnects: 3,
      baseReconnectDelay: 1,
      reconnectJitter: 0,
    }));

    expect(headersSeen[0]['Last-Event-ID']).toBeUndefined();
    expect(headersSeen[1]['Last-Event-ID']).toBe('42');
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });
});

describe('fetchSSE 超时与取消', () => {
  it('连接超时 → timeout 错误', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_url: any, init: any) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
    );

    const gen = fetchSSE({ url: 'http://test/s', fetchImpl, connectTimeout: 100 });
    const pending = collect(gen);
    await vi.advanceTimersByTimeAsync(100);
    const events = await pending;

    expect(events).toHaveLength(1);
    expect((events[0] as { error: SSEError }).error.type).toBe('timeout');
  });

  it('读取超时 → timeout 错误', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: first\n\n'));
          // 模拟真实 fetch：signal 取消时流报错
          init.signal.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError')),
          );
        },
      });
      return new Response(stream, { status: 200 });
    });

    const gen = fetchSSE({ url: 'http://test/s', fetchImpl, readTimeout: 500 });
    const pending = collect(gen);
    await vi.advanceTimersByTimeAsync(500);
    const events = await pending;

    expect(events[0].type).toBe('event'); // 首条数据正常消费
    const err = events.find(e => e.type === 'error') as { error: SSEError };
    expect(err.error.type).toBe('timeout');
  });

  it('外部 AbortSignal 取消 → abort 错误，流终结', async () => {
    const external = new AbortController();
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: first\n\n'));
          init.signal.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError')),
          );
        },
      });
      return new Response(stream, { status: 200 });
    });

    const events: SSEStreamEvent[] = [];
    for await (const ev of fetchSSE({ url: 'http://test/s', fetchImpl, signal: external.signal })) {
      events.push(ev);
      if (events.length === 1) external.abort(); // 收到首个事件后取消
    }

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('event');
    expect((events[1] as { error: SSEError }).error.type).toBe('abort');
  });

  it('取消后不再重连（abort 不可重试）', async () => {
    const external = new AbortController();
    external.abort(); // 发起前就已取消
    const fetchImpl = vi.fn(async () => sseResponse(['data: x\n\n']));

    const events = await collect(fetchSSE({
      url: 'http://test/s', fetchImpl, signal: external.signal, autoReconnect: true,
    }));

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: 'error', error: { type: 'abort', message: 'Aborted by signal', retryable: false } },
    ]);
  });
});
