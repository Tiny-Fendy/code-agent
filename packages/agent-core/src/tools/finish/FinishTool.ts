import Type from 'typebox';
import { BaseTool } from '../base.js';
import type { ToolResult, ToolContext } from '@code-agent/contracts';

/** 参数 schema：唯一事实来源 */
const finishParams = Type.Object({
  summary: Type.String({
    minLength: 1,
    description: '任务完成情况的简要总结，供用户快速了解结果',
  }),
});

/**
 * finish 工具：任务完成时由 LLM 主动调用，输出总结并结束循环
 *
 * Agent 检测到 finish 被调用后，不再继续下一轮思考，直接返回 done。
 */
export class FinishTool extends BaseTool<typeof finishParams> {
  name = 'finish';
  description = '任务完成时调用，输出最终总结并结束当前对话循环。仅在确认所有子任务已完成、无遗留问题时使用。';
  readonly parameters = finishParams;
  requiresConfirmation = false;

  protected async run(
    params: Type.Static<typeof finishParams>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    // 语义校验：trim 后空白（schema 的 minLength 不 trim）
    if (!params.summary.trim()) {
      return this.error('finish 工具必须提供非空的 summary 参数');
    }
    return this.success(params.summary);
  }
}
