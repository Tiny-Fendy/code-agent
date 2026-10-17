/**
 * 工具基类与接口
 *
 * 工具系统是 Agent 能力的延伸——Agent 通过调用工具来与外部世界交互。
 * 每个工具就是一个"函数"，有名称、描述、参数 schema，LLM 决定什么时候调用它。
 */

import type { ToolDefinition, ToolResult, ToolContext } from '@code-agent/contracts';

/**
 * Tool 接口
 *
 * 所有工具都必须实现这个接口。Agent 通过 ToolManager 统一调度。
 */
export interface Tool {
  /** 工具名称（唯一标识，只能是字母数字下划线） */
  name: string;

  /** 工具描述（指导模型何时使用，越精准越好） */
  description: string;

  /** 参数 schema（JSON Schema 格式，type: object + properties） */
  parameters: Record<string, any>;

  /** 是否需要用户确认后才能执行 */
  requiresConfirmation: boolean;

  /**
   * 执行工具
   * @param params LLM 解析出的参数
   * @param context 工具执行上下文（项目路径等宿主环境信息）
   */
  execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult>;

  /** 转换为 LLM 需要的 tool definition 格式 */
  toDefinition(): ToolDefinition;
}

/**
 * BaseTool 抽象基类
 *
 * 提供 toDefinition 的默认实现，子类只需填 name/description/parameters + 实现 execute。
 */
export abstract class BaseTool implements Tool {
  abstract name: string;
  abstract description: string;
  abstract parameters: Record<string, any>;
  abstract requiresConfirmation: boolean;

  abstract execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult>;

  toDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    };
  }

  /** 工具：成功返回 */
  protected success(content: string): ToolResult {
    return { success: true, content };
  }

  /** 工具：失败返回 */
  protected error(message: string): ToolResult {
    return { success: false, content: '', error: message };
  }
}
