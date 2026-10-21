import { BaseTool } from '../base.js';
import type { ToolResult, ToolContext } from '@code-agent/contracts';

/**
 * finish 工具：任务完成时由 LLM 主动调用，输出总结并结束循环
 *
 * Agent 检测到 finish 被调用后，不再继续下一轮思考，直接返回 done。
 */
export class FinishTool extends BaseTool {
  name = 'finish';
  description = '任务完成时调用，输出最终总结并结束当前对话循环。仅在确认所有子任务已完成、无遗留问题时使用。';
  parameters = {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: '任务完成情况的简要总结，供用户快速了解结果',
      },
    },
    required: ['summary'],
  } as const;
  requiresConfirmation = false;

  async execute(params: Record<string, any>, _context: ToolContext): Promise<ToolResult> {
    const summary = params.summary as string | undefined;
    if (!summary || summary.trim() === '') {
      return this.error('finish 工具必须提供非空的 summary 参数');
    }
    return this.success(summary);
  }
}
