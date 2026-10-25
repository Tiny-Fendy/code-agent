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

/**
 * 一次 LLM 请求的句柄
 *
 * Provider 承担发送请求的能力，「取消」是请求与生俱来的基础能力，
 * 随句柄一并返回（对照 EventSource.close()、SSEClient.abort()）。
 * 按请求粒度持有，无共享可变状态，并发安全。
 */
export interface LLMRequest {
  /** 事件流：逐步推送 LLM 事件，最后一定以 message_complete（或 error）收尾 */
  events: AsyncGenerator<LLMEvent>;
  /** 立即中断本次请求：释放连接并终结事件流（幂等；流已终结时为 no-op） */
  abort(): void;
}

export abstract class LLMProvider {
  protected apiKey: string;
  protected baseUrl: string;

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  /**
   * 发起流式聊天补全，返回请求句柄。
   *
   * events 逐步推送 LLM 事件，最后一定会推送一条 message_complete（或 error）事件；
   * abort() 立即中断在途请求。
   */
  abstract chat(params: ChatCompletionParams): LLMRequest;
}
