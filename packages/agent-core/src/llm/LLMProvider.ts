/**
 * LLM Provider 抽象基类
 *
 * 定义统一的聊天补全接口，支持流式输出。
 * 不同模型提供商（OpenAI 兼容、Anthropic 等）继承此类实现具体逻辑。
 */

import type { ChatMessage, ToolDefinition } from '@code-agent/shared';

/** 聊天补全参数 */
export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

/**
 * LLM 流式事件（LLM 层的原始事件，比 Agent 事件更底层）
 *
 * - text_delta: 文本增量
 * - tool_call_delta: 工具调用增量（参数可能是不完整的 JSON 字符串）
 * - message_complete: 整条消息组装完成，包含完整的 content 和 toolCalls
 * - error: 出错
 */
export type LLMEventType =
  | 'text_delta'
  | 'tool_call_delta'
  | 'message_complete'
  | 'error';

export interface LLMEvent {
  type: LLMEventType;
  data: any;
}

export abstract class LLMProvider {
  protected apiKey: string;
  protected baseUrl: string;

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  /**
   * 流式聊天补全
   *
   * 返回 AsyncGenerator，逐步推送 LLM 事件。
   * 最后一定会推送一条 message_complete（或 error）事件。
   */
  abstract chat(params: ChatCompletionParams): AsyncGenerator<LLMEvent>;
}
