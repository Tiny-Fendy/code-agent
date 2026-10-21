/**
 * 对话消息模型（领域实体）
 *
 * 把契约层的 AgentEvent / ChatMessage / SendResult 归并成渲染友好的 UI 模型。
 * 本文件只定义数据结构与枚举，归并逻辑见 eventMerger.ts。
 */

import type { ToolResult } from '@code-agent/contracts';

// ---- 工具调用（值对象） ----

/** 工具调用卡片的生命周期状态 */
export type ToolCallStatus =
  | 'running' // 已开始执行
  | 'awaiting_confirm' // 等待用户确认（高危工具）
  | 'success' // 执行成功
  | 'failed' // 执行失败
  | 'denied'; // 用户拒绝执行

/** UI 层的工具调用实体：由 tool_call_delta / start / result 事件归并而来 */
export interface UIToolCall {
  id: string;
  name: string;
  /** 归并后的参数文本：delta 增量拼接，start 事件以完整对象覆盖 */
  argumentsText: string;
  status: ToolCallStatus;
  result?: ToolResult;
}

// ---- 消息（实体） ----

/**
 * 消息内片段：保持文本与工具调用的原始穿插顺序。
 *
 * 为什么用 parts 而不是 content + toolCalls 两个字段：
 * 一轮 LLM 响应里文本和工具调用会交替出现（如「先说明 → 调工具 → 继续说明」），
 * 拆成两个字段会丢失穿插顺序，工具卡片无法插在正确的文本位置之间。
 */
export type UIMessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; toolCall: UIToolCall };

/** 消息级终态错误：该轮失败 / 中断时挂在最后一条助手消息上，用于渲染失败态与重试入口 */
export interface UIMessageError {
  kind: 'llm_failed' | 'max_steps' | 'rpc_failed' | 'aborted';
  /** 人类可读原因（aborted 无） */
  message?: string;
}

export interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: UIMessagePart[];
  /** 是否仍在流式输出中（最后一条 streaming = true 的消息即「当前流式消息」） */
  streaming: boolean;
  error?: UIMessageError;
}

// ---- 会话（聚合） ----

/** 会话状态机：终局后回到 idle，错误信息挂在消息上而非状态上 */
export type SessionStatus = 'idle' | 'streaming' | 'awaiting_confirm';

/** 对话聚合状态：chatStore 的 state 形状由本模型定义 */
export interface ConversationState {
  messages: UIMessage[];
  /** 等待用户确认的工具调用 id（status = awaiting_confirm 时非空） */
  pendingConfirmId: string | null;
}

/** 初始会话状态 */
export function emptyConversation(): ConversationState {
  return { messages: [], pendingConfirmId: null };
}
