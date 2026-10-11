/**
 * 上下文管理器
 *
 * 负责维护对话历史，是 Agent "记忆"的载体。
 *
 * 核心职责：
 * 1. 维护消息列表（system / user / assistant / tool）
 * 2. 提供消息的增删查能力
 * 3. 未来：上下文窗口管理（Token 超限自动裁剪）
 *
 * 目前是基础版本，Token 裁剪等高级功能后续迭代。
 */

import type { ChatMessage } from '@code-agent/shared';

export class ContextManager {
  private messages: ChatMessage[] = [];
  private maxTokens: number;

  constructor(maxTokens = 8000) {
    this.maxTokens = maxTokens;
  }

  /** 添加一条消息 */
  addMessage(message: ChatMessage): void {
    this.messages.push(message);
    // TODO: Token 超限裁剪逻辑
  }

  /** 获取所有消息 */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /** 获取消息数量 */
  getMessageCount(): number {
    return this.messages.length;
  }

  /** 获取最后一条消息 */
  getLastMessage(): ChatMessage | null {
    return this.messages.length > 0
      ? this.messages[this.messages.length - 1]
      : null;
  }

  /** 清空所有消息 */
  clear(): void {
    this.messages = [];
  }

  /**
   * 获取当前 token 估算值
   * TODO 目前用简单的字符数估算，后续可以接入 tiktoken 精确计算
   */
  getTokenCount(): number {
    let totalChars = 0;
    for (const msg of this.messages) {
      totalChars += msg.content.length;
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          totalChars += tc.name.length;
          totalChars += JSON.stringify(tc.arguments).length;
        }
      }
    }
    // 粗略估算：中文 1 token ≈ 1.5 字，英文 1 token ≈ 4 字符
    // 这里取个保守的平均值
    return Math.ceil(totalChars / 3);
  }

  /** 设置最大 Token 数 */
  setMaxTokens(maxTokens: number): void {
    this.maxTokens = maxTokens;
  }
}
