import { BaseTool } from '../base.js';
import type {
  ToolResult,
  ToolContext,
  UserInputOption,
  UserInputRequest,
} from '@code-agent/contracts';

/** 选项数量下限 */
const MIN_OPTIONS = 2;
/** 选项数量上限 */
const MAX_OPTIONS = 4;

/**
 * ask_user 工具：LLM 在信息不足或需要用户决策时向用户提问
 *
 * 交互请求经 ToolContext.requestUserInput 直达宿主 UI，回答作为
 * ToolResult 回灌上下文，Agent 继续 ReAct 循环。
 */
export class AskUserTool extends BaseTool {
  name = 'ask_user';
  description =
    '当信息不足或存在多个合理方案需要用户决策时，向用户提问并等待回答。' +
    '不要用它询问是否可以使用工具；能通过读文件、搜索自行确认的信息不要问用户。';
  parameters = {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '要向用户提出的问题（一次只问一个问题）',
      },
      options: {
        type: 'array',
        description: '供用户选择的选项，2-4 个；省略表示自由文本输入',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '选项文本' },
            description: { type: 'string', description: '选项说明（可选）' },
          },
          required: ['label'],
        },
        minItems: MIN_OPTIONS,
        maxItems: MAX_OPTIONS,
      },
      allowMultiple: {
        type: 'boolean',
        description: '是否允许多选，默认 false（仅 options 存在时有效）',
      },
    },
    required: ['question'],
  } as const;
  requiresConfirmation = false;

  async execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const logger = context.logger;

    // ---- 参数校验：不抛异常，统一以错误观察回灌 LLM ----
    const question = typeof params.question === 'string' ? params.question.trim() : '';
    if (!question) {
      return this.error('ask_user 必须提供非空的 question 参数');
    }

    let options: UserInputOption[] | undefined;
    if (params.options !== undefined && params.options !== null) {
      if (!Array.isArray(params.options)) {
        return this.error('options 必须是数组，或省略表示自由输入');
      }
      // 空数组等价于省略：自由文本输入
      if (params.options.length > 0) {
        if (params.options.length < MIN_OPTIONS || params.options.length > MAX_OPTIONS) {
          return this.error(`options 数量必须为 ${MIN_OPTIONS}-${MAX_OPTIONS} 个，或省略表示自由输入`);
        }
        options = [];
        for (let i = 0; i < params.options.length; i++) {
          const item = params.options[i] ?? {};
          const label = typeof item.label === 'string' ? item.label.trim() : '';
          if (!label) {
            return this.error(`options[${i}].label 不能为空`);
          }
          const description =
            typeof item.description === 'string' && item.description.trim()
              ? item.description.trim()
              : undefined;
          options.push({ label, ...(description ? { description } : {}) });
        }
      }
    }

    const allowMultiple = options !== undefined && params.allowMultiple === true;

    // ---- 宿主能力检查：未接入时明确失败，绝不挂起或猜测 ----
    const requestUserInput = context.requestUserInput;
    if (!requestUserInput) {
      logger?.warn('ask_user 未接入用户交互', { question: question.slice(0, 50) });
      return this.error('当前环境不支持用户交互（未注入 onAskUser 回调）');
    }

    const request: UserInputRequest = { question, options, allowMultiple };
    logger?.info('ask_user 请求', {
      optionCount: options?.length ?? 0,
      allowMultiple,
    });

    const startAt = Date.now();
    let response: Awaited<ReturnType<NonNullable<ToolContext['requestUserInput']>>>;
    try {
      response = await requestUserInput(request);
    } catch (err) {
      logger?.warn('ask_user 回调异常', {
        error: (err as Error).message,
        durationMs: Date.now() - startAt,
      });
      return this.error(`用户交互失败: ${(err as Error).message}`);
    }

    // ---- 回答映射：选项优先，其次自由文本 ----
    const selected = Array.isArray(response?.selected)
      ? response.selected.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      : [];
    const text = typeof response?.text === 'string' ? response.text.trim() : '';

    if (selected.length > 0) {
      if (!allowMultiple && selected.length > 1) {
        logger?.warn('ask_user 单选返回多个选项', { count: selected.length });
        return this.error('单选场景只能返回一个选项');
      }
      logger?.info('ask_user 回答', {
        selectedCount: selected.length,
        durationMs: Date.now() - startAt,
      });
      return this.success(`用户选择：${selected.join('、')}`);
    }

    if (text) {
      logger?.info('ask_user 回答', {
        hasText: true,
        durationMs: Date.now() - startAt,
      });
      return this.success(`用户输入：${text}`);
    }

    logger?.warn('ask_user 空回答', { durationMs: Date.now() - startAt });
    return this.error('用户未作出选择');
  }
}
