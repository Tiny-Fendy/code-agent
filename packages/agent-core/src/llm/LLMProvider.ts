/**
 * LLM Provider 抽象基类
 *
 * 定义统一的聊天补全接口，支持流式输出。
 * 不同模型提供商（OpenAI 兼容、Anthropic 等）继承此类实现具体逻辑。
 */

import type { ChatMessage, ToolDefinition } from '@code-agent/contracts';

/** 聊天补全参数 */
export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

/**
 * LLM 流式事件类型枚举
 *
 * - TextDelta: 文本增量
 * - ToolCallDelta: 工具调用增量（参数可能是不完整的 JSON 字符串）
 * - MessageComplete: 整条消息组装完成，包含完整的 content 和 toolCalls
 * - Error: 出错
 */
export enum LLMEventType {
  TextDelta = 'text_delta',
  ToolCallDelta = 'tool_call_delta',
  MessageComplete = 'message_complete',
  Error = 'error',
}

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
