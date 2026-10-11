/**
 * OpenAI 兼容接口的 LLM Provider
 *
 * 核心学习点：
 * 1. SSE（Server-Sent Events）流式响应解析
 * 2. 工具调用的增量 JSON 拼接（arguments 是逐段来的）
 * 3. AsyncGenerator 模式下的流式事件推送
 *
 * OpenAI 兼容接口的流式响应格式（SSE）：
 *   data: {"id":"...","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}
 *   data: {"id":"...","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}
 *   ...
 *   data: [DONE]
 *
 * 工具调用时 delta 里是 tool_calls 而非 content：
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xxx","function":{"name":"read_file","arguments":"{"}}]}}]}
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"path\":\"/"}}]}}]}
 *   ...arguments 是逐段拼接的 JSON 字符串
 */

import { LLMProvider, type ChatCompletionParams, type LLMEvent } from './LLMProvider';
import type { ChatMessage, ToolCall } from '@code-agent/shared';

/** SSE 解析后的单条数据 */
interface SSEChunk {
  id?: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
}

export class OpenAICompatibleProvider extends LLMProvider {
  constructor(apiKey: string, baseUrl: string) {
    super(apiKey, baseUrl);
  }

  async *chat(params: ChatCompletionParams): AsyncGenerator<LLMEvent> {
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

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      yield {
        type: 'error',
        data: { message: `网络请求失败: ${(err as Error).message}` },
      };
      return;
    }

    if (!response.ok) {
      const errorText = await response.text();
      yield {
        type: 'error',
        data: { message: `API 错误 (${response.status}): ${errorText}` },
      };
      return;
    }

    if (!response.body) {
      yield {
        type: 'error',
        data: { message: '响应体为空' },
      };
      return;
    }

    // ---- 流式解析 SSE ----
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    // 用于累积完整消息
    let fullContent = '';
    const toolCalls: Array<{
      id: string;
      name: string;
      arguments: string; // 累积的 JSON 字符串，最后再 parse
    }> = [];

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE 以 \n\n 分隔每条消息
        const parts = buffer.split('\n\n');
        buffer = parts.pop()!; // 最后一段可能不完整，放回 buffer

        for (const part of parts) {
          const lines = part.split('\n').filter(line => line.trim() !== '');

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const dataStr = line.slice(6).trim();

            if (dataStr === '[DONE]') {
              // 流结束，产出完整消息
              const completeMessage = this.buildCompleteMessage(fullContent, toolCalls);
              yield {
                type: 'message_complete',
                data: { message: completeMessage },
              };
              return;
            }

            let chunk: SSEChunk;
            try {
              chunk = JSON.parse(dataStr);
            } catch {
              // 跳过解析失败的行
              continue;
            }

            const choice = chunk.choices?.[0];
            if (!choice) continue;

            const { delta, finish_reason } = choice;

            // ---- 文本增量 ----
            if (delta.content && delta.content.length > 0) {
              fullContent += delta.content;
              yield {
                type: 'text_delta',
                data: { delta: delta.content },
              };
            }

            // ---- 工具调用增量 ----
            if (delta.tool_calls && delta.tool_calls.length > 0) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                // 确保 toolCalls 数组有对应位置
                while (toolCalls.length <= idx) {
                  toolCalls.push({ id: '', name: '', arguments: '' });
                }

                if (tc.id) {
                  toolCalls[idx].id = tc.id;
                }
                if (tc.function?.name) {
                  toolCalls[idx].name = tc.function.name;
                }
                if (tc.function?.arguments) {
                  toolCalls[idx].arguments += tc.function.arguments;
                }
              }

              // 也推送 tool_call_delta 事件（UI 可以实时展示）
              yield {
                type: 'tool_call_delta',
                data: { toolCalls: this.buildPartialToolCalls(toolCalls) },
              };
            }

            // ---- 结束原因（某些模型在 finish 时才给 tool_calls） ----
            if (finish_reason === 'tool_calls' || finish_reason === 'stop') {
              // 不在这里处理完成，等 [DONE] 标记
            }
          }
        }
      }

      // 理论上应该在 [DONE] 那里 return，如果走到这里说明流异常结束
      if (fullContent || toolCalls.length > 0) {
        const completeMessage = this.buildCompleteMessage(fullContent, toolCalls);
        yield {
          type: 'message_complete',
          data: { message: completeMessage },
        };
      }
    } catch (err) {
      yield {
        type: 'error',
        data: { message: `流式解析失败: ${(err as Error).message}` },
      };
    } finally {
      reader.releaseLock();
    }
  }

  /** 从累积的数据构建完整的 ChatMessage */
  private buildCompleteMessage(
    content: string,
    toolCallsRaw: Array<{ id: string; name: string; arguments: string }>,
  ): ChatMessage {
    const msg: ChatMessage = {
      role: 'assistant',
      content: content || '',
    };

    if (toolCallsRaw.length > 0) {
      msg.toolCalls = toolCallsRaw
        .filter(tc => tc.name) // 过滤掉不完整的
        .map(tc => {
          let args: Record<string, any> = {};
          try {
            args = tc.arguments ? JSON.parse(tc.arguments) : {};
          } catch {
            // 解析失败时保留原始字符串作为 fallback
            args = { _raw: tc.arguments };
          }
          const toolCall: ToolCall = {
            id: tc.id,
            name: tc.name,
            arguments: args,
          };
          return toolCall;
        });
    }

    return msg;
  }

  /** 构建部分工具调用（用于实时展示，arguments 可能不完整） */
  private buildPartialToolCalls(
    toolCallsRaw: Array<{ id: string; name: string; arguments: string }>,
  ): Array<{ id: string; name: string; arguments: string }> {
    return toolCallsRaw.map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    }));
  }
}
