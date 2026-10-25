import { describe, it, expect, vi, afterEach } from 'vitest';
import { SSEClient } from '@/client';
import { SSEClientError } from '@/errors';
import type { SSEDoneInfo, SSEReconnectingInfo } from '@/types';

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

/** 客户端事件收集结果：done 与 error 互斥，必有且仅有一个终局 */
interface Collected {
  data: unknown[];
  done?: SSEDoneInfo;
  error?: SSEClientError;
}

/** 订阅全部事件，终局（done / error 之一）到达时 resolve */
function collect(client: SSEClient): Promise<Collected> {
  const result: Collected = { data: [] };
  return new Promise((resolve) => {
    client.on('data', (payload) => {
      result.data.push(payload);
    });
    client.on('done', (info) => {
      result.done = info;
      resolve(result);
    });
    client.on('error', (err) => {
      result.error = err;
      resolve(result);
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SSEClient 生命周期状态机', () => {
  it('running 态重复 start() 抛错', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const collected = collect(client);

    client.start();
    expect(() => client.start()).toThrow(/single-use/);

    await collected;
  });

  it('closed 态 start() 抛错（实例一次性）', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const collected = collect(client);
    client.start();
    await collected;

    expect(() => client.start()).toThrow(/single-use/);
  });

  it('idle 态 abort() 为 no-op，不影响后续 start', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const collected = collect(client);

    expect(() => client.abort()).not.toThrow();
    client.start();
    const result = await collected;

    expect(result.done?.reason).toBe('complete');
  });

  it('closed 态 abort() 为 no-op，终局事件只发一次', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    let doneCount = 0;
    let errorCount = 0;
    client.on('done', () => {
      doneCount++;
    });
    client.on('error', () => {
      errorCount++;
    });

    client.start();
    await new Promise<void>((resolve) =>
      client.on('done', () => {
        resolve();
      }),
    );
    client.abort();

    expect(doneCount).toBe(1);
    expect(errorCount).toBe(0);
  });
});

describe('SSEClient data 事件与严格 JSON 解析', () => {
  it('data 事件收到 JSON 解析后的对象，done 携带 eventCount', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['data: {"v":1}\n\n', 'data: {"w":[1,2]}\n\n']),
    );
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(result.data).toEqual([{ v: 1 }, { w: [1, 2] }]);
    expect(result.done).toEqual({ reason: 'complete', eventCount: 2 });
    expect(result.error).toBeUndefined();
  });

  it('事件跨 chunk 拆分时边界正确', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['data: {"a', '":1}\n\ndata: {"b":2}', '\n\n']),
    );
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(result.data).toEqual([{ a: 1 }, { b: 2 }]);
    expect(result.done?.reason).toBe('complete');
  });

  it('非 JSON data → parse 错误终结，不发 done', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: not-json\n\n']));
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(result.data).toEqual([]);
    expect(result.done).toBeUndefined();
    expect(result.error).toBeInstanceOf(SSEClientError);
    expect(result.error?.type).toBe('parse');
  });
});

describe('SSEClient [DONE] 哨兵（严格解析唯一例外）', () => {
  it('收到 [DONE] 即发 done complete：不透传、不计数、忽略后续内容', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['data: {"v":1}\n\n', 'data: [DONE]\n\n', 'data: {"v":2}\n\n']),
    );
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(result.data).toEqual([{ v: 1 }]);
    expect(result.done).toEqual({ reason: 'complete', eventCount: 1 });
    expect(result.error).toBeUndefined();
  });

  it('非精确匹配的 [DONE]x 不享受哨兵例外，走严格解析报 parse 错误', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: [DONE]x\n\n']));
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(result.error?.type).toBe('parse');
    expect(result.done).toBeUndefined();
  });
});

describe('SSEClient done 终局', () => {
  it('服务端关闭连接 → done complete', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(result.done).toEqual({ reason: 'complete', eventCount: 1 });
    expect(result.error).toBeUndefined();
  });

  it('流读取中 abort() → done aborted（携带已发 data 数），不发 error', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"v":1}\n\n'));
          init.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError')),
          );
        },
      });
      return new Response(stream, { status: 200 });
    });
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const received: unknown[] = [];
    client.on('data', (payload) => {
      received.push(payload);
    });
    let errorSeen: SSEClientError | undefined;
    client.on('error', (err) => {
      errorSeen = err;
    });
    const donePromise = new Promise<SSEDoneInfo>((resolve) => client.on('done', resolve));

    client.start();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    client.abort();
    const info = await donePromise;

    expect(info).toEqual({ reason: 'aborted', eventCount: 1 });
    expect(errorSeen).toBeUndefined();
  });

  it('连接阶段 abort() → done aborted，不发 error', async () => {
    const fetchImpl = vi.fn(
      async (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    let errorSeen: SSEClientError | undefined;
    client.on('error', (err) => {
      errorSeen = err;
    });
    const donePromise = new Promise<SSEDoneInfo>((resolve) => client.on('done', resolve));

    client.start();
    client.abort();
    const info = await donePromise;

    expect(info).toEqual({ reason: 'aborted', eventCount: 0 });
    expect(errorSeen).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('SSEClient error 分类', () => {
  it('HTTP 非 2xx → http 错误（status + 响应体入 message）', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(result.done).toBeUndefined();
    expect(result.error?.type).toBe('http');
    expect(result.error?.status).toBe(404);
    expect(result.error?.message).toContain('not found');
  });

  it('onOpen 校验抛错 → http 错误（status 为响应状态码，cause 为原始错误）', async () => {
    const guard = new Error('not an SSE endpoint');
    const fetchImpl = vi.fn(
      async () =>
        new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl,
      onOpen: (response) => {
        if (!response.headers.get('content-type')?.includes('text/event-stream')) {
          throw guard;
        }
      },
    });
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(result.done).toBeUndefined();
    expect(result.error?.type).toBe('http');
    expect(result.error?.status).toBe(200);
    expect(result.error?.message).toBe('not an SSE endpoint');
    expect(result.error?.cause).toBe(guard);
  });

  it('onOpen 校验通过 → 正常消费流', async () => {
    const onOpen = vi.fn(async (_response: Response) => {});
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({ url: 'http://test/s', fetchImpl, onOpen });
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual([{ v: 1 }]);
    expect(result.done?.reason).toBe('complete');
  });

  it('fetch 拒绝 → network 错误（cause 为原始错误）', async () => {
    const cause = new TypeError('fetch failed');
    const fetchImpl = vi.fn(async () => {
      throw cause;
    });
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(result.done).toBeUndefined();
    expect(result.error?.type).toBe('network');
    expect(result.error?.message).toBe('fetch failed');
    expect(result.error?.cause).toBe(cause);
  });

  it('响应体为空 → network 错误', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(result.done).toBeUndefined();
    expect(result.error?.type).toBe('network');
  });

  it('连接超时 → timeout 错误（Connect timeout）', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      async (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl,
      timeouts: { connect: 100 },
    });
    const collected = collect(client);
    client.start();
    await vi.advanceTimersByTimeAsync(100);
    const result = await collected;

    expect(result.done).toBeUndefined();
    expect(result.error?.type).toBe('timeout');
    expect(result.error?.message).toBe('Connect timeout');
  });

  it('读取超时 → timeout 错误（Read timeout），已发 data 不受影响', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"v":1}\n\n'));
          init.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError')),
          );
        },
      });
      return new Response(stream, { status: 200 });
    });
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl,
      timeouts: { read: 500 },
    });
    const collected = collect(client);
    client.start();
    await vi.advanceTimersByTimeAsync(500);
    const result = await collected;

    expect(result.data).toEqual([{ v: 1 }]);
    expect(result.done).toBeUndefined();
    expect(result.error?.type).toBe('timeout');
    expect(result.error?.message).toBe('Read timeout');
  });

  it('总超时 → timeout 错误（Total timeout）', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError')),
          );
        },
      });
      return new Response(stream, { status: 200 });
    });
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl,
      timeouts: { total: 300 },
    });
    const collected = collect(client);
    client.start();
    await vi.advanceTimersByTimeAsync(300);
    const result = await collected;

    expect(result.done).toBeUndefined();
    expect(result.error?.type).toBe('timeout');
    expect(result.error?.message).toBe('Total timeout');
  });
});

describe('SSEClient 事件订阅', () => {
  it('on() 返回退订函数，退订后不再收到事件', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['data: {"v":1}\n\n', 'data: {"v":2}\n\n']),
    );
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const seen: unknown[] = [];
    const off = client.on('data', (payload) => {
      seen.push(payload);
    });
    off();
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(seen).toEqual([]);
    expect(result.data).toEqual([{ v: 1 }, { v: 2 }]);
    expect(result.done?.eventCount).toBe(2);
  });

  it('同一事件支持多个处理器', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const first: unknown[] = [];
    const second: unknown[] = [];
    client.on('data', (payload) => {
      first.push(payload);
    });
    client.on('data', (payload) => {
      second.push(payload);
    });
    const collected = collect(client);
    client.start();
    await collected;

    expect(first).toEqual([{ v: 1 }]);
    expect(second).toEqual([{ v: 1 }]);
  });
});

describe('SSEClient 请求组装', () => {
  it('默认 GET 方法，params 序列化（undefined 忽略，number/boolean 转字符串）', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    const fetchImpl = vi.fn(async (url: unknown, init: RequestInit) => {
      capturedUrl = String(url);
      capturedMethod = init.method ?? '';
      return sseResponse(['data: {"v":1}\n\n']);
    });
    const client = new SSEClient({
      url: 'http://test/api/stream',
      params: { a: 1, b: 'x', c: true, d: undefined },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const collected = collect(client);
    client.start();
    await collected;

    expect(capturedUrl).toBe('http://test/api/stream?a=1&b=x&c=true');
    expect(capturedMethod).toBe('GET');
  });

  it('body 普通对象自动 JSON 序列化并补 Content-Type，headers 函数 start 时求值一次', async () => {
    let capturedInit: RequestInit | undefined;
    const headersFn = vi.fn(() => ({ Authorization: 'Bearer dyn' }));
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      capturedInit = init;
      return sseResponse(['data: {"v":1}\n\n']);
    });
    const client = new SSEClient({
      url: 'http://test/s',
      method: 'POST',
      headers: headersFn,
      body: { q: 'hi' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const collected = collect(client);
    client.start();
    await collected;

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headersFn).toHaveBeenCalledTimes(1);
    expect(headers.Authorization).toBe('Bearer dyn');
    expect(headers['Content-Type']).toBe('application/json');
    expect(capturedInit?.body).toBe(JSON.stringify({ q: 'hi' }));
  });

  it('body 为字符串时原样透传，不补 Content-Type', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      capturedInit = init;
      return sseResponse(['data: {"v":1}\n\n']);
    });
    const client = new SSEClient({
      url: 'http://test/s',
      method: 'POST',
      body: 'raw-text',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const collected = collect(client);
    client.start();
    await collected;

    const headers = capturedInit?.headers as Record<string, string>;
    expect(capturedInit?.body).toBe('raw-text');
    expect(headers['Content-Type']).toBeUndefined();
  });
});

/** 订阅 reconnecting 事件的收集器 */
function collectReconnecting(client: SSEClient): SSEReconnectingInfo[] {
  const infos: SSEReconnectingInfo[] = [];
  client.on('reconnecting', (info) => infos.push(info));
  return infos;
}

describe('SSEClient 自动重连（仅首字节前，默认关闭）', () => {
  it('不配置 reconnect：fetch 拒绝直接 error 终局，无 reconnecting 事件', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = new SSEClient({ url: 'http://test/s', fetchImpl });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reconnecting).toEqual([]);
    expect(result.done).toBeUndefined();
    expect(result.error?.type).toBe('network');
    expect(result.error?.retryable).toBe(true);
  });

  it('fetch 拒绝 → reconnecting（attempt=1 / delay=baseDelay / error）→ 重试成功', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementation(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reconnect: { baseDelay: 5, jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reconnecting).toHaveLength(1);
    expect(reconnecting[0].attempt).toBe(1);
    expect(reconnecting[0].delay).toBe(5);
    expect(reconnecting[0].error).toBeInstanceOf(SSEClientError);
    expect(reconnecting[0].error?.retryable).toBe(true);
    expect(result.done).toEqual({ reason: 'complete', eventCount: 1 });
    expect(result.error).toBeUndefined();
  });

  it('HTTP 429 → 自动重试，Retry-After 头（retry-after-ms）优先作为 delay', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, headers: { 'retry-after-ms': '25' } }),
      )
      .mockImplementation(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reconnect: { baseDelay: 10_000, jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reconnecting[0].delay).toBe(25);
    expect(reconnecting[0].error?.type).toBe('http');
    expect(reconnecting[0].error?.status).toBe(429);
    expect(reconnecting[0].error?.retryable).toBe(true);
    expect(result.done?.reason).toBe('complete');
  });

  it('HTTP 429 无 Retry-After 头 → 回退指数退避 delay', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockImplementation(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reconnect: { baseDelay: 5, jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    await collected;

    expect(reconnecting[0].delay).toBe(5);
  });

  it('Retry-After 超过 maxDelay → 封顶 maxDelay', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('overloaded', { status: 503, headers: { 'retry-after': '120' } }),
      )
      .mockImplementation(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reconnect: { maxDelay: 500, jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    await collected;

    expect(reconnecting[0].delay).toBe(500);
  });

  it('retry-after-ms=0 → delay=0 走快速路径，立即重试成功', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, headers: { 'retry-after-ms': '0' } }),
      )
      .mockImplementation(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reconnect: { jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(reconnecting[0].delay).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.done?.reason).toBe('complete');
  });

  it('HTTP 5xx（503）→ 自动重试成功', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('service unavailable', { status: 503 }))
      .mockImplementation(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reconnect: { baseDelay: 5, jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reconnecting).toHaveLength(1);
    expect(result.done?.reason).toBe('complete');
  });

  it('connect 超时 → 自动重试（timeout 错误 retryable=true）', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      calls++;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }
      return sseResponse(['data: {"v":1}\n\n']);
    });
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeouts: { connect: 20 },
      reconnect: { baseDelay: 5, jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reconnecting[0].error?.type).toBe('timeout');
    expect(reconnecting[0].error?.message).toBe('Connect timeout');
    expect(reconnecting[0].error?.retryable).toBe(true);
    expect(result.done?.reason).toBe('complete');
  });

  it('maxRetries 耗尽 → error 终局，重试次数与 attempt 序列正确', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl,
      reconnect: { maxRetries: 2, baseDelay: 5, jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(fetchImpl).toHaveBeenCalledTimes(3); // 首次 + 2 次重试
    expect(reconnecting.map((info) => info.attempt)).toEqual([1, 2]);
    expect(result.done).toBeUndefined();
    expect(result.error?.type).toBe('network');
    expect(result.error?.retryable).toBe(true);
  });

  it('重试等待期间 abort() → done aborted，不再发起新请求', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl,
      reconnect: { baseDelay: 5_000, jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const donePromise = new Promise<SSEDoneInfo>((resolve) => client.on('done', resolve));
    let errorSeen: SSEClientError | undefined;
    client.on('error', (err) => {
      errorSeen = err;
    });

    client.start();
    await vi.waitFor(() => expect(reconnecting).toHaveLength(1));
    client.abort();
    const info = await donePromise;

    expect(info).toEqual({ reason: 'aborted', eventCount: 0 });
    expect(errorSeen).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 等待期间取消，不发起第二次请求
  });

  it('HTTP 4xx（404）→ 终结 error（retryable=false），不重试', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl,
      reconnect: { baseDelay: 5, jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reconnecting).toEqual([]);
    expect(result.error?.type).toBe('http');
    expect(result.error?.status).toBe(404);
    expect(result.error?.retryable).toBe(false);
  });

  it('流中断（已收到 data）→ 终结不自动重试，retryable=true 仅作提示', async () => {
    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"v":1}\n\n'));
          // 异步报错：同步 error 会清空队列导致首 chunk 被丢弃
          setTimeout(() => controller.error(new Error('connection reset')), 10);
        },
      });
      return new Response(stream, { status: 200 });
    });
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl,
      reconnect: { baseDelay: 5, jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(fetchImpl).toHaveBeenCalledTimes(1); // 流中途失败不重试
    expect(reconnecting).toEqual([]);
    expect(result.data).toEqual([{ v: 1 }]);
    expect(result.done).toBeUndefined();
    expect(result.error?.type).toBe('network');
    expect(result.error?.retryable).toBe(true); // 仅供消费方整体重发提示
  });

  it('流中途 JSON 解析失败 → 终结不自动重试', async () => {
    const fetchImpl = vi.fn(async () => sseResponse(['data: not-json\n\n']));
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl,
      reconnect: { baseDelay: 5, jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reconnecting).toEqual([]);
    expect(result.error?.type).toBe('parse');
  });

  it('read 超时（流中途）→ 终结不自动重试', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError')),
          );
        },
      });
      return new Response(stream, { status: 200 });
    });
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl,
      timeouts: { read: 20 },
      reconnect: { baseDelay: 5, jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reconnecting).toEqual([]);
    expect(result.error?.type).toBe('timeout');
    expect(result.error?.message).toBe('Read timeout');
  });

  it('total 超时 → 终结不自动重试（retryable=false，不可被重试绕过）', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError')),
          );
        },
      });
      return new Response(stream, { status: 200 });
    });
    const client = new SSEClient({
      url: 'http://test/s',
      fetchImpl,
      timeouts: { total: 20 },
      reconnect: { baseDelay: 5, jitter: 0 },
    });
    const reconnecting = collectReconnecting(client);
    const collected = collect(client);
    client.start();
    const result = await collected;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reconnecting).toEqual([]);
    expect(result.error?.type).toBe('timeout');
    expect(result.error?.message).toBe('Total timeout');
    expect(result.error?.retryable).toBe(false);
  });

  it('headers 函数每次尝试求值一次（重连场景支持动态刷新 token）', async () => {
    const headersFn = vi.fn(() => ({ Authorization: 'Bearer dyn' }));
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementation(async () => sseResponse(['data: {"v":1}\n\n']));
    const client = new SSEClient({
      url: 'http://test/s',
      headers: headersFn,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reconnect: { baseDelay: 5, jitter: 0 },
    });
    const collected = collect(client);
    client.start();
    await collected;

    expect(headersFn).toHaveBeenCalledTimes(2);
  });
});

