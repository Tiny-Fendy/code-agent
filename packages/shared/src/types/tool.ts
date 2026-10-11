/**
 * 工具相关共享类型
 */

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
}
