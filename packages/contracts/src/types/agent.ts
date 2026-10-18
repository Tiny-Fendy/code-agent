/**
 * Agent 相关共享类型
 */

import type { ToolResult } from './tool.js';

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
 * - context_compact:  上下文压缩完成（历史摘要替换）
 *
 * 注意：事件流只含过程数据。成功 / 失败 / 取消的结束语义不走事件，
 * 由生成器返回值 SendResult（RPC 场景下即流终局帧）承载。
 */
export type AgentEventType =
  | 'text_delta'
  | 'tool_call_delta'
  | 'tool_call_start'
  | 'tool_call_confirm'
  | 'tool_call_result'
  | 'message_complete'
  | 'context_compact';

export type AgentEvent =
  | { type: 'text_delta'; data: { delta: string } }
  | { type: 'tool_call_delta'; data: { toolCalls: Array<{ id: string; name: string; arguments: string }> } }
  | { type: 'tool_call_start'; data: { toolCallId: string; toolName: string; arguments: Record<string, any> } }
  | { type: 'tool_call_confirm'; data: { toolCallId: string; toolName: string; arguments: Record<string, any> } }
  | { type: 'tool_call_result'; data: { toolCallId: string; toolName: string; result: ToolResult } }
  | { type: 'message_complete'; data: { message: ChatMessage; step: number } }
  | { type: 'context_compact'; data: { before: number; after: number } };

/**
 * Agent 任务终局结果（Agent.run 的生成器返回值）
 *
 * 穷尽五个退出点，全部字段为基础类型，可结构化克隆：
 * - completed: LLM 给出最终答案，正常完成；steps 为实际思考步数
 * - finished:  LLM 主动调用 finish 工具结束；summary 为任务总结
 * - llmFailed: LLM 调用失败（网络 / 鉴权 / 上游错误），message 为人类可读原因
 * - maxSteps:  达到最大思考步数，任务未完成
 * - aborted:   被中断（直接消费生成器的场景；RPC 场景下消费端 abort
 *              由协议层 end{aborted} 终局优先表达，见 RPC 设计 D 系列）
 */
export type SendResult =
  | { status: 'completed'; steps: number }
  | { status: 'finished'; steps: number; summary: string }
  | { status: 'llmFailed'; message: string }
  | { status: 'maxSteps'; steps: number }
  | { status: 'aborted' };

/**
 * 工具确认回调
 *
 * Agent 在执行高危工具（requiresConfirmation = true）前调用，
 * 宿主环境负责把确认请求转发给 UI 并等待用户决定。
 * 返回 true 放行执行，false 拒绝。
 */
export type ToolConfirmCallback = (toolCall: ToolCall) => Promise<boolean>;

// 对话配置
export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  systemPrompt?: string;
  /** 上下文窗口预算（token），超过 80% 触发摘要压缩；默认 8000 */
  contextTokens?: number;
}
