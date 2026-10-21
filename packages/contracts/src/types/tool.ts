/**
 * 工具相关共享类型
 */

import type { Logger } from './logger.js';
import type { UserInputCallback } from './user-input.js';

// 工具定义（用于传给 LLM 的 schema）
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
}

// 工具执行结果
export interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
}

// 工具执行上下文（宿主环境提供给工具的能力）
export interface ToolContext {
  projectPath: string;
  /** 可选日志器，工具内诊断信息经此输出；缺省由 ToolManager 注入 NullLogger */
  logger?: Logger;
  /** 请求用户输入；未注入时工具应返回「不支持交互」错误 */
  requestUserInput?: UserInputCallback;
}
