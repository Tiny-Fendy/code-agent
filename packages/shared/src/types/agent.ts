/**
 * Agent 相关共享类型
 */

import type { ToolResult } from './tool';

// 对话角色
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

// 聊天消息
export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

// 工具调用
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/**
 * Agent 事件（可辨识联合，流式输出）
 *
 * 可辨识联合的意义：UI 侧 `stream.on('text_delta', cb)` 时，
 * 回调参数 data 能获得精确类型提示，而不是 any。
 *
 * - text_delta:       文本增量（流式输出）
 * - tool_call_delta:  工具调用增量（流式输出，arguments 可能不完整）
 * - tool_call_start:  开始执行工具
 * - tool_call_confirm: 需要用户确认工具执行（保留）
 * - tool_call_result: 工具执行完成，返回结果
 * - message_complete: 一轮 LLM 响应完成
 * - error:            出错
 * - done:             整个 Agent 任务完成
 */
export type AgentEventType =
  | 'text_delta'
  | 'tool_call_delta'
  | 'tool_call_start'
  | 'tool_call_confirm'
  | 'tool_call_result'
  | 'message_complete'
  | 'error'
  | 'done';

export type AgentEvent =
  | { type: 'text_delta'; data: { delta: string } }
  | { type: 'tool_call_delta'; data: { toolCalls: Array<{ id: string; name: string; arguments: string }> } }
  | { type: 'tool_call_start'; data: { toolCallId: string; toolName: string; arguments: Record<string, any> } }
  | { type: 'tool_call_confirm'; data: { toolCallId: string; toolName: string; arguments: Record<string, any> } }
  | { type: 'tool_call_result'; data: { toolCallId: string; toolName: string; result: ToolResult } }
  | { type: 'message_complete'; data: { message: ChatMessage; step: number } }
  | { type: 'error'; data: { message: string } }
  | { type: 'done'; data: { reason?: string; steps?: number } };

// 对话配置
export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  systemPrompt?: string;
}
