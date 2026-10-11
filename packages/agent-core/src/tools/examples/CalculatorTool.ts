/**
 * 示例工具：计算器
 *
 * 用来测试 Agent 的工具调用能力。
 * 实际项目中不会有这种工具，这里只是为了验证 ReAct 循环。
 */

import { BaseTool } from '../base';
import type { ToolResult, ToolContext } from '@code-agent/shared';

export class CalculatorTool extends BaseTool {
  name = 'calculator';
  description = '执行数学计算。当你需要计算数学表达式时使用这个工具。';
  parameters = {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: '要计算的数学表达式，例如 "2 + 3 * 4"',
      },
    },
    required: ['expression'],
  };
  requiresConfirmation = false;

  async execute(params: Record<string, any>, _context: ToolContext): Promise<ToolResult> {
    const expression = params.expression as string;

    if (!expression) {
      return this.error('表达式不能为空');
    }

    try {
      // 安全的表达式计算：只允许数字、运算符、括号、小数点
      // 实际生产中应该用 math.js 等库，这里简单处理
      const sanitized = expression.replace(/[^0-9+\-*/().\s]/g, '');
      if (sanitized !== expression.trim()) {
        return this.error('表达式包含非法字符，只允许数字和 + - * / ( )');
      }

      // eslint-disable-next-line no-eval
      const result = eval(sanitized);
      return this.success(String(result));
    } catch (err) {
      return this.error(`计算失败: ${(err as Error).message}`);
    }
  }
}
