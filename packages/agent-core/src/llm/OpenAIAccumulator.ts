/**
 * OpenAI 流式响应累积器（业务状态层）
 *
 * 三层拆分中的第二层：接收 delta 片段（不认识 chunk / choices 结构），
 * 承载流式过程中的全部有状态累积逻辑：
 * - content 全文累积
 * - tool_calls 按 index 归位、id/name 就位、arguments 增量拼接
 * - 产出部分 toolCalls（tool_call_delta 事件用，arguments 可能不完整）
 * - 流末构建完整 ChatMessage（arguments 统一 JSON.parse，失败保留 _raw fallback）
 *
 * 职责边界：本类只做累积，不做事件翻译（chunk → LLMEvent 归 Provider 编排层）。
 * 纯同步无 IO，可独立单测。
 */

import type { ChatMessage, ToolCall } from '@code-agent/contracts';
import type { OpenAIStreamToolCall } from './openai-types.js';

/**
 * 累积中的工具调用（实现层内部状态）
 *
 * 与协议层 OpenAIStreamToolCall 的区别：
 * - OpenAIStreamToolCall 描述单块增量（字段都可能是片段）
 * - PartialToolCall 是按 index 累积后的中间结果：id/name 通常已就位，
 *   arguments 仍是未完成的 JSON 字符串，需流结束后统一 JSON.parse
 */
export interface PartialToolCall {
  id: string;
  name: string;
  /** 累积拼接中的 JSON 字符串（可能不完整） */
  arguments: string;
}

export class OpenAIAccumulator {
  private content = '';
  private toolCalls: PartialToolCall[] = [];

  /**
   * 累积 content 增量
   * @returns 非空增量本身（供 text_delta 事件）；无增量返回 null
   */
  pushContent(delta: string | null | undefined): string | null {
    if (!delta || delta.length === 0) return null;
    this.content += delta;
    return delta;
  }

  /**
   * 累积 tool_calls 增量：按 index 归位、id/name 后到补齐、arguments 逐段拼接
   * @returns 累积中的全部部分 toolCalls 快照（供 tool_call_delta 事件）；增量非空时返回
   */
  pushToolCalls(deltas: OpenAIStreamToolCall[] | undefined): PartialToolCall[] | null {
    if (!deltas || deltas.length === 0) return null;

    for (const tc of deltas) {
      const idx = tc.index;
      // 确保数组有对应位置（容忍乱序 / 跳 index）
      while (this.toolCalls.length <= idx) {
        this.toolCalls.push({ id: '', name: '', arguments: '' });
      }

      if (tc.id) {
        this.toolCalls[idx].id = tc.id;
      }
      if (tc.function?.name) {
        this.toolCalls[idx].name = tc.function.name;
      }
      if (tc.function?.arguments) {
        this.toolCalls[idx].arguments += tc.function.arguments;
      }
    }

    return this.buildPartialToolCalls();
  }

  /** 是否有任何累积内容（content 非空，或存在 toolCall 条目） */
  hasContent(): boolean {
    return this.content.length > 0 || this.toolCalls.length > 0;
  }

  /**
   * 流末构建完整 ChatMessage
   * - 过滤掉无 name 的不完整 toolCall 项
   * - arguments 统一 JSON.parse；解析失败保留 { _raw } 原始字符串 fallback
   */
  buildMessage(): ChatMessage {
    const msg: ChatMessage = {
      role: 'assistant',
      content: this.content || '',
    };

    if (this.toolCalls.length > 0) {
      msg.toolCalls = this.toolCalls
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

  /** 构建部分工具调用快照（用于实时展示，arguments 可能不完整） */
  private buildPartialToolCalls(): PartialToolCall[] {
    return this.toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    }));
  }
}
