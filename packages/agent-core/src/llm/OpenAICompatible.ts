/**
 * OpenAI 兼容接口的 LLM Provider（三层编排）
 *
 * 适用面：OpenAI 官方 API、Azure OpenAI、DeepSeek、Moonshot，
 * 以及 vLLM / Ollama 等本地推理服务——只要遵循 /chat/completions 流式协议即可复用。
 *
 * 三层架构（详见 openspec/systems/llm-provider.md §3）：
 * 1. 网络协议层：fetch-sse-client 的 SSEClient——HTTP 请求、SSE 协议解析、
 *    严格 JSON 解析（畸形 data 即 error 终结）、[DONE] 哨兵消化、三层超时与错误分类
 * 2. 业务状态层：OpenAIAccumulator——content 累积、tool_calls 按 index 归位、
 *    arguments 增量拼接、流末统一 JSON.parse（失败 _raw fallback）
 * 3. 编排层（本文件）：组装请求参数，把 SSEClient 事件翻译为 LLMEvent；
 *    事件驱动 API 与 AsyncGenerator 消费模型之间以 push-pull 队列桥接
 *
 * 流式响应格式（SSE）：
 *   data: {"id":"...","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}
 *   data: {"id":"...","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}
 *   ...
 *   data: [DONE]
 *
 * 工具调用时 delta 里是 tool_calls 而非 content：
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xxx","function":{"name":"read_file","arguments":"{"}}]}}]}
 *   ...arguments 是逐段拼接的 JSON 字符串，由 Accumulator 累积
 */

import {
  LLMProvider,
  LLMEventType,
  type ChatCompletionParams,
  type LLMEvent,
} from './LLMProvider.js';
import { mockEnabled, mockStream } from './MockProvider.js';
import { SSEClient, type SSEClientError } from 'fetch-sse-client';
import { OpenAIAccumulator } from './OpenAIAccumulator.js';
import type { OpenAIStreamChunk } from './openai-types.js';

/** SSEClientError → LLMEvent(error) 的 message 映射：分类前缀保留诊断信息 */
function mapError(err: SSEClientError): string {
  return `[${err.type}] ${err.message}`;
}

export class OpenAICompatibleProvider extends LLMProvider {
  constructor(apiKey: string, baseUrl: string) {
    super(apiKey, baseUrl);
  }

  async *chat(params: ChatCompletionParams): AsyncGenerator<LLMEvent> {
    // mock 开关：开发态剧本驱动（详见 openspec/changes/004-mock-provider/design.md），
    // 切换点收在 LLM 层内部，Agent 与调用方零感知
    if (mockEnabled()) {
      yield* mockStream(params);
      return;
    }

    // ---- 请求组装（URL / headers / body 映射保持现状） ----
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const body: Record<string, any> = {
      model: params.model,
      messages: params.messages,
      stream: true,
    };

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map(def => ({
        type: 'function',
        function: {
          name: def.name,
          description: def.description,
          parameters: def.parameters,
        },
      }));
    }
    if (params.temperature !== undefined) {
      body.temperature = params.temperature;
    }
    if (params.maxTokens !== undefined) {
      body.max_tokens = params.maxTokens;
    }

    // ---- 网络协议层：SSEClient（库默认超时 connect 10s / read 30s，不开启 reconnect） ----
    const client = new SSEClient({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    // ---- 业务状态层：累积器 ----
    const accumulator = new OpenAIAccumulator();

    // ---- 桥接：事件 push 入队，生成器 pull 出队；done/error 为终结哨兵 ----
    type QueueItem = { event?: LLMEvent; terminal?: 'done' | 'error'; error?: SSEClientError };
    const queue: QueueItem[] = [];
    let notify: (() => void) | null = null;
    const push = (item: QueueItem) => {
      queue.push(item);
      notify?.();
      notify = null;
    };

    // data 负载已被库 JSON.parse，此处只做 chunk → LLMEvent 翻译
    client.on('data', (payload) => {
      const chunk = payload as OpenAIStreamChunk;
      const choice = chunk.choices?.[0];
      if (!choice) return;

      const { delta } = choice;

      // ---- 文本增量 ----
      const text = accumulator.pushContent(delta.content);
      if (text !== null) {
        push({ event: { type: LLMEventType.TextDelta, data: { delta: text } } });
      }

      // ---- 工具调用增量（arguments 可能不完整，UI 可实时展示） ----
      const partial = accumulator.pushToolCalls(delta.tool_calls);
      if (partial !== null) {
        push({ event: { type: LLMEventType.ToolCallDelta, data: { toolCalls: partial } } });
      }
    });
    client.on('done', () => push({ terminal: 'done' }));
    client.on('error', (err) => push({ terminal: 'error', error: err }));

    // ---- 外部取消：signal 触发即 client.abort()，立即中断在途请求 ----
    const onExternalAbort = () => client.abort();
    params.signal?.addEventListener('abort', onExternalAbort, { once: true });

    client.start();
    // 竞态兜底：信号先于注册触发时 listener 不会再 fire
    if (params.signal?.aborted) client.abort();

    try {
      while (true) {
        while (queue.length === 0) {
          await new Promise<void>((resolve) => { notify = resolve; });
        }
        const item = queue.shift()!;

        if (item.terminal === 'error') {
          yield { type: LLMEventType.Error, data: { message: mapError(item.error!) } };
          return;
        }
        if (item.terminal === 'done') {
          // 流异常结束（无 [DONE]）但有累积内容 → MessageComplete 兜底
          if (accumulator.hasContent()) {
            yield {
              type: LLMEventType.MessageComplete,
              data: { message: accumulator.buildMessage() },
            };
          }
          return;
        }
        yield item.event!;
      }
    } finally {
      // 生成器提前终止（break / return / Agent abort）时释放连接；
      // 流已终结（closed 态）时为 no-op，天然安全
      params.signal?.removeEventListener('abort', onExternalAbort);
      client.abort();
    }
  }
}
