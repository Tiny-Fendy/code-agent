/**
 * 上下文管理器
 *
 * 负责维护对话历史，是 Agent "记忆"的载体。
 *
 * 核心职责：
 * 1. 维护消息列表（system / user / assistant / tool）
 * 2. 提供消息的增删查能力
 * 3. Token 估算（中英分桶）
 * 4. 上下文压缩支持（入口截断、分区切点）——见 openspec/changes/002-context-compaction/
 *
 * 当前为基础版本，压缩/裁剪能力开发中。
 */

import type { ChatMessage, Logger } from '@code-agent/contracts';
import { NullLogger } from '../logging/NullLogger.js';

/** compact 触发阈值（相对 maxTokens） */
const COMPACT_THRESHOLD = 0.8;
/** 尾部保留预算占比（相对 maxTokens） */
const TAIL_BUDGET_RATIO = 0.25;
/** 摘要消息内容前缀 */
const SUMMARY_PREFIX = '[历史摘要]';

export class ContextManager {
  /** 默认最大 token 数（构造函数缺省值，外部可引用避免魔法数字） */
  static readonly DEFAULT_MAX_TOKENS = 8000;
  /** 默认 tool 结果截断上限（字符数，构造函数缺省值） */
  static readonly DEFAULT_TOOL_RESULT_LIMIT = 4000;

  private messages: ChatMessage[] = [];
  private maxTokens: number;
  /** tool 结果截断上限（字符数） */
  private readonly toolResultLimit: number;
  private readonly logger: Logger;

  constructor(
    maxTokens = ContextManager.DEFAULT_MAX_TOKENS,
    toolResultLimit = ContextManager.DEFAULT_TOOL_RESULT_LIMIT,
    logger: Logger = new NullLogger(),
  ) {
    this.maxTokens = maxTokens;
    this.toolResultLimit = toolResultLimit;
    this.logger = logger;
  }

  /** 添加一条消息；超长的 tool 结果自动截断（头 2/3 + 尾 1/3） */
  addMessage(message: ChatMessage): void {
    if (message.role === 'tool' && message.content.length > this.toolResultLimit) {
      this.logger.warn('tool 结果超限截断', {
        length: message.content.length,
        limit: this.toolResultLimit,
      });
      this.messages.push({ ...message, content: this.truncateToolResult(message.content) });
      return;
    }
    this.messages.push(message);
  }

  /**
   * 截断超长的工具结果
   *
   * 头部通常是报错开头/内容起始，尾部通常是退出码、汇总信息，中间是冗余主体。
   */
  private truncateToolResult(content: string): string {
    const headLen = Math.floor(this.toolResultLimit * 2 / 3);
    const tailLen = this.toolResultLimit - headLen;
    const removed = content.length - headLen - tailLen;
    return (
      content.slice(0, headLen) +
      `\n...[已截断 ${removed} 字符]...\n` +
      content.slice(content.length - tailLen)
    );
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
   *
   * 中英分桶估算：CJK 字符约 1.5 字符 ≈ 1 token，其余约 4 字符 ≈ 1 token。
   * 早期单一 /3 的估算对中文内容严重低估（实际 1 token ≈ 1.5 字），会导致裁剪不及时。
   * TODO 后续可以接入 tiktoken 精确计算
   */
  getTokenCount(): number {
    let total = 0;
    for (const msg of this.messages) {
      total += this.messageTokens(msg);
    }
    return total;
  }

  /** 单条消息的 token 估算（content + toolCalls） */
  private messageTokens(msg: ChatMessage): number {
    let total = this.estimateTokens(msg.content);
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += this.estimateTokens(tc.name);
        total += this.estimateTokens(JSON.stringify(tc.arguments));
      }
    }
    return total;
  }

  /** 是否需要压缩：token 超过 maxTokens × 0.8 */
  shouldCompact(): boolean {
    return this.getTokenCount() > this.maxTokens * COMPACT_THRESHOLD;
  }

  /**
   * 获取可压缩区域（摘要区）：system 之后、切点之前的消息切片
   *
   * 切点从尾部按预算（maxTokens × 25%）向前累加确定；
   * 切点落在 tool 消息上时回溯到其 assistant 父消息，
   * 保证不拆散 assistant(toolCalls) ↔ tool 消息对。
   */
  getCompactableRange(): ChatMessage[] {
    const sys = this.systemCount();
    const cut = this.findCutIndex();
    return this.messages.slice(sys, cut);
  }

  /**
   * 应用压缩：摘要区替换为一条 user 摘要消息（content 前缀 [历史摘要]）
   *
   * 压缩后仍超触发阈值的防御由调用方（Agent）负责：先预估摘要体积，超限则不调用本方法。
   */
  compact(summary: string): void {
    const sys = this.systemCount();
    const cut = this.findCutIndex();
    if (cut <= sys) return; // 无可压缩区域
    const summaryMessage: ChatMessage = {
      role: 'user',
      content: `${SUMMARY_PREFIX}\n${summary}`,
    };
    this.messages.splice(sys, cut - sys, summaryMessage);
  }

  /** 预估应用摘要压缩后的 token 数（调用方用于决定是否应用压缩） */
  estimateAfterCompact(summary: string): number {
    const summaryTokens = this.estimateTokens(`${SUMMARY_PREFIX}\n${summary}`);
    const sys = this.systemCount();
    const cut = this.findCutIndex();
    const rangeTokens = this.messages
      .slice(sys, cut)
      .reduce((sum, m) => sum + this.messageTokens(m), 0);
    return this.getTokenCount() - rangeTokens + summaryTokens;
  }

  /** 当前压缩触发阈值（maxTokens × 0.8），供调用方做防御判断 */
  getCompactThreshold(): number {
    return this.maxTokens * COMPACT_THRESHOLD;
  }

  /** 前导 system 消息数量（设计上只有 1 条，防御性支持多条） */
  private systemCount(): number {
    let n = 0;
    while (n < this.messages.length && this.messages[n].role === 'system') n++;
    return n;
  }

  /**
   * 尾部保留区起点（切点）
   *
   * 从尾部向前累加消息 token，预算用尽处即为切点；
   * 切点消息必须是 user/assistant（不能是 tool，也不能把 assistant 与其 tool 响应拆开）。
   */
  private findCutIndex(): number {
    const sys = this.systemCount();
    const budget = this.maxTokens * TAIL_BUDGET_RATIO;

    let acc = 0;
    let cut = this.messages.length;
    let i = this.messages.length - 1;
    while (i >= sys) {
      const t = this.messageTokens(this.messages[i]);
      if (acc + t > budget) break; // 该消息放不进尾部预算 → 切点落在这里（其本身划入尾部之外）
      acc += t;
      cut = i;
      i--;
    }

    // 切点不能是 tool 消息：回溯把 assistant 父消息划入尾部
    while (cut < this.messages.length && cut > sys && this.messages[cut].role === 'tool') {
      cut--;
    }
    return Math.max(cut, sys);
  }

  /**
   * 单段文本的 token 估算（中英分桶）
   *
   * CJK 范围覆盖：日文假名、汉字扩展A、汉字基本区、兼容汉字、韩文
   */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    const cjkChars = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g) || []).length;
    const otherChars = text.length - cjkChars;
    return Math.ceil(cjkChars / 1.5 + otherChars / 4);
  }

  /** 设置最大 Token 数 */
  setMaxTokens(maxTokens: number): void {
    this.maxTokens = maxTokens;
  }
}
