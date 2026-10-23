/**
 * 工具管理器
 *
 * 负责工具的注册、查找和执行调度。
 * Agent 不直接操作单个工具，而是通过 ToolManager 统一调度。
 *
 * 内置工具在构造时自动注册；外部可通过 register() 追加自定义工具。
 */

import type { Tool } from './base.js';
import type { ToolDefinition, ToolResult, ToolContext, Logger } from '@code-agent/contracts';
import { NullLogger } from '../logging/NullLogger.js';
import {
  ListDirTool,
  ReadFileTool,
  SearchByRegexTool,
  WriteFileTool,
  EditFileTool,
} from './file/index.js';
import { RunCommandTool } from './shell/index.js';
import { FinishTool } from './finish/index.js';
import { AskUserTool } from './ask-user/index.js';
import { WebFetchTool } from './web-fetch/index.js';

export class ToolManager {
  private tools = new Map<string, Tool>();
  private readonly logger: Logger;

  constructor(projectPath: string, logger: Logger = new NullLogger()) {
    this.logger = logger;
    this.registerAll(this.createBuiltinTools(projectPath));
  }

  /** 内置工具清单：新增内置工具只需在这里加一行 */
  private createBuiltinTools(projectPath: string): Tool[] {
    return [
      new ListDirTool(projectPath),
      new ReadFileTool(projectPath),
      new SearchByRegexTool(projectPath),
      new WriteFileTool(projectPath),
      new EditFileTool(projectPath),
      new RunCommandTool(projectPath),
      new FinishTool(),
      new AskUserTool(),
      new WebFetchTool(),
    ];
  }

  /** 注册工具（外部注册自定义工具的入口） */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /** 批量注册 */
  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** 获取所有工具的 schema 列表（传给 LLM） */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(tool => tool.toDefinition());
  }

  /** 查找工具 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 获取所有工具名 */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * 执行工具调用
   *
   * 统一的错误处理：工具执行异常不会让整个 Agent 崩溃，而是返回错误结果，
   * Agent 会把错误信息回灌给 LLM，让它自己调整。
   */
  async execute(
    toolName: string,
    params: Record<string, any>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);

    if (!tool) {
      this.logger.warn('工具未找到', { tool: toolName });
      return {
        success: false,
        content: '',
        error: `工具 "${toolName}" 不存在，可用工具: ${this.getToolNames().join(', ')}`,
      };
    }

    try {
      return await tool.execute(params, context);
    } catch (err) {
      this.logger.error('工具执行异常', { tool: toolName, error: (err as Error).message });
      return {
        success: false,
        content: '',
        error: `工具 "${toolName}" 执行失败: ${(err as Error).message}`,
      };
    }
  }

  /** 检查工具是否需要用户确认 */
  requiresConfirmation(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    return tool?.requiresConfirmation ?? false;
  }
}
