/**
 * OpenAICompatibleProvider 集成测试（chat() 三层编排）
 *
 * 通过 vi.stubGlobal('fetch', ...) 桩掉全局 fetch（SSEClient 默认使用全局 fetch），
 * 构造真实 ReadableStream 形态的 SSE 流式响应，覆盖：
 * 正常文本流 / 工具调用流 / 混合流 / [DONE] 哨兵 / 流异常结束兜底、
 * HTTP 非 2xx / fetch 拒绝 / 畸形 data 严格解析、空 choices 跳过、
 * 生成器提前终止的连接释放、请求组装映射。
 * 与源文件一一对应：src/llm/OpenAICompatible.ts → test/llm/OpenAICompatible.test.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from '../../src/llm/OpenAICompatible';
import { LLMEventType, type LLMEvent, type ChatCompletionParams } from '../../src/llm/LLMProvider';
import type { ChatMessage } from '@code-agent/contracts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const encoder = new TextEncoder();

/** 构造一条 OpenAI 流式 chunk 的 SSE data 消息 */
const sseData = (delta: Record<string, unknown>): string =>
  `data: ${JSON.stringify({ id: 'chatcmpl_1', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;

const DONE = 'data: [DONE]\n\n';

/** 静态 SSE 响应：chunks 全部推送后关闭流 */
function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** 桩全局 fetch，返回固定响应（可传 promise 模拟延迟） */
function stubFetch(response: Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 收集事件流（完全消费） */
async function collect(gen: AsyncGenerator<LLMEvent>): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const provider = () => new OpenAICompatibleProvider('test-key', 'https://api.test.com/v1');

const baseParams: ChatCompletionParams = {
  model: 'gpt-test',
  messages: [{ role: 'user', content: 'hi' }],
};

const textOf = (e: LLMEvent): string => (e.data as { delta: string }).delta;
const messageOf = (e: LLMEvent): ChatMessage => (e.data as { message: ChatMessage }).message;

describe('正常流式事件翻译', () => {
  it('正常文本流：多 chunk content → text_delta 序列 + message_complete 拼接正确', async () => {
    stubFetch(sseResponse([
      sseData({ content: '你好' }),
      sseData({ content: '，世' }),
      sseData({ content: '界' }),
      DONE,
    ]));

    const events = await collect(provider().chat(baseParams));

    const deltas = events.filter(e => e.type === LLMEventType.TextDelta);
    expect(deltas.map(textOf)).toEqual(['你好', '，世', '界']);

    const last = events[events.length - 1];
    expect(last.type).toBe(LLMEventType.MessageComplete);
    expect(messageOf(last)).toEqual({ role: 'assistant', content: '你好，世界' });
  });

  it('工具调用流：tool_calls 增量 → tool_call_delta（部分参数）+ message_complete（arguments 已 parse）', async () => {
    stubFetch(sseResponse([
      sseData({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] }),
      sseData({ tool_calls: [{ index: 0, function: { arguments: 'th":"."}' } }] }),
      DONE,
    ]));

    const events = await collect(provider().chat(baseParams));

    const deltas = events.filter(e => e.type === LLMEventType.ToolCallDelta);
    expect(deltas).toHaveLength(2);
    // 部分参数：arguments 为累积中的原始字符串
    expect((deltas[0].data as any).toolCalls).toEqual([
      { id: 'call_1', name: 'read_file', arguments: '{"pa' },
    ]);
    expect((deltas[1].data as any).toolCalls).toEqual([
      { id: 'call_1', name: 'read_file', arguments: '{"path":"."}' },
    ]);

    const last = events[events.length - 1];
    expect(last.type).toBe(LLMEventType.MessageComplete);
    expect(messageOf(last).toolCalls).toEqual([
      { id: 'call_1', name: 'read_file', arguments: { path: '.' } },
    ]);
  });

  it('content 与 tool_calls 混合流：先文本后工具调用，message_complete 两者齐备', async () => {
    stubFetch(sseResponse([
      sseData({ content: '查一下' }),
      sseData({ tool_calls: [{ index: 0, id: 'call_9', function: { name: 'list_dir', arguments: '{"path":"."}' } }] }),
      DONE,
    ]));

    const events = await collect(provider().chat(baseParams));

    expect(events.map(e => e.type)).toEqual([
      LLMEventType.TextDelta,
      LLMEventType.ToolCallDelta,
      LLMEventType.MessageComplete,
    ]);
    const last = messageOf(events[2]);
    expect(last.content).toBe('查一下');
    expect(last.toolCalls).toEqual([
      { id: 'call_9', name: 'list_dir', arguments: { path: '.' } },
    ]);
  });

  it('[DONE] 哨兵由库消化：不产生额外事件，message_complete 正常产出', async () => {
    stubFetch(sseResponse([
      sseData({ content: 'ok' }),
      DONE,
      // 哨兵之后不应再有事件（库主动关流）
      sseData({ content: 'ignored' }),
    ]));

    const events = await collect(provider().chat(baseParams));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe(LLMEventType.TextDelta);
    expect(events[1].type).toBe(LLMEventType.MessageComplete);
    expect(messageOf(events[1]).content).toBe('ok');
  });
});

describe('流异常结束与错误路径', () => {
  it('流异常结束（无 [DONE]）但有累积内容 → message_complete 兜底', async () => {
    stubFetch(sseResponse([
      sseData({ content: '半截' }),
      // 直接 close，无 [DONE]
    ]));

    const events = await collect(provider().chat(baseParams));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe(LLMEventType.TextDelta);
    expect(events[1].type).toBe(LLMEventType.MessageComplete);
    expect(messageOf(events[1]).content).toBe('半截');
  });

  it('流异常结束且无累积 → 无任何事件', async () => {
    stubFetch(sseResponse([])); // 空流直接 close

    const events = await collect(provider().chat(baseParams));
    expect(events).toEqual([]);
  });

  it('HTTP 非 2xx（401）→ error 事件，message 含 [http] 前缀与状态码', async () => {
    stubFetch(new Response('Unauthorized', { status: 401 }));

    const events = await collect(provider().chat(baseParams));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(LLMEventType.Error);
    const msg = (events[0].data as { message: string }).message;
    expect(msg).toContain('[http]');
    expect(msg).toContain('401');
  });

  it('fetch 拒绝 → error 事件，message 含 [network] 前缀', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = await collect(provider().chat(baseParams));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(LLMEventType.Error);
    const msg = (events[0].data as { message: string }).message;
    expect(msg).toBe('[network] connect ECONNREFUSED');
  });

  it('畸形 data 行 → error 事件终结（严格解析，[parse] 前缀）', async () => {
    stubFetch(sseResponse([
      sseData({ content: '前段' }),
      'data: {not-json}\n\n',
      sseData({ content: '不应到达' }),
    ]));

    const events = await collect(provider().chat(baseParams));

    // 严格策略：畸形 data 为终结错误（行为变化，本用例锁定）
    const last = events[events.length - 1];
    expect(last.type).toBe(LLMEventType.Error);
    const msg = (last.data as { message: string }).message;
    expect(msg).toContain('[parse]');
    expect(msg).toContain('JSON parse failed');
    // 畸形行之后的 data 不再产出
    expect(events.map(e => e.type)).not.toContain(LLMEventType.MessageComplete);
  });
});

describe('chunk 过滤与资源释放', () => {
  it('choices 为空 / delta 无内容的 chunk 跳过，无事件产出', async () => {
    stubFetch(sseResponse([
      `data: ${JSON.stringify({ id: 'x', choices: [] })}\n\n`,
      sseData({}), // delta 无 content 无 tool_calls
      DONE,
    ]));

    const events = await collect(provider().chat(baseParams));
    expect(events).toEqual([]);
  });

  it('生成器提前 break → fetch 收到的 abort 信号被触发（连接释放）', async () => {
    let capturedSignal: AbortSignal | undefined;
    // 挂起流：推送一条后不再产出、不关闭
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseData({ content: '你' })));
      },
    });
    const fetchMock = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      capturedSignal = init?.signal;
      return new Response(stream, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const gen = provider().chat(baseParams);
    for await (const _event of gen) {
      break; // 消费第一个事件后立即终止
    }

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('外部 signal abort → 在途请求立即中断，生成器随之终结', async () => {
    let capturedSignal: AbortSignal | undefined;
    // 挂起流：推送一条后不再产出（模拟长思考停顿）；
    // 按真实 fetch 语义把流与 signal 联动——abort 时 body 读取报错
    const fetchMock = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      capturedSignal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseData({ content: '你' })));
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('The operation was aborted', 'AbortError'));
          });
        },
      });
      return new Response(stream, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const gen = provider().chat({ ...baseParams, signal: controller.signal });
    const first = await gen.next();
    expect(first.done).toBe(false);

    controller.abort();

    // 不等下一个流事件，fetch 连接被立即中断
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);

    // done 哨兵唤醒生成器：已有累积内容 → MessageComplete 兜底，随后终结
    const second = await gen.next();
    expect(second.done).toBe(false);
    expect(second.value.type).toBe(LLMEventType.MessageComplete);
    expect((await gen.next()).done).toBe(true);
  });
});

describe('请求组装（映射保持现状）', () => {
  it('URL / method / headers / body 映射正确', async () => {
    const fetchMock = stubFetch(sseResponse([DONE]));

    const params: ChatCompletionParams = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'read_file', description: '读文件', parameters: { type: 'object' } },
      ],
      temperature: 0.5,
      maxTokens: 1024,
    };
    await collect(provider().chat(params));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://api.test.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: '读文件', parameters: { type: 'object' } },
        },
      ],
      temperature: 0.5,
      max_tokens: 1024,
    });
  });

  it('未提供 tools / temperature / maxTokens 时不写入对应字段', async () => {
    const fetchMock = stubFetch(sseResponse([DONE]));

    await collect(provider().chat(baseParams));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
  });
});
