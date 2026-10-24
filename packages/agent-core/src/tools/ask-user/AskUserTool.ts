import Type from 'typebox';
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

/** 参数 schema：唯一事实来源 */
const askUserParams = Type.Object({
  question: Type.String({ minLength: 1, description: '要向用户提出的问题（一次只问一个问题）' }),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        label: Type.String({ minLength: 1, description: '选项文本' }),
        description: Type.Optional(Type.String({ description: '选项说明（可选）' })),
      }),
      {
        minItems: MIN_OPTIONS,
        maxItems: MAX_OPTIONS,
        description: `供用户选择的选项，${MIN_OPTIONS}-${MAX_OPTIONS} 个；省略表示自由文本输入`,
      },
    ),
  ),
  allowMultiple: Type.Optional(
    Type.Boolean({ description: '是否允许多选，默认 false（仅 options 存在时有效）' }),
  ),
});

/**
 * ask_user 工具：LLM 在信息不足或需要用户决策时向用户提问
 *
 * 交互请求经 ToolContext.requestUserInput 直达宿主 UI，回答作为
 * ToolResult 回灌上下文，Agent 继续 ReAct 循环。
 */
export class AskUserTool extends BaseTool<typeof askUserParams> {
  name = 'ask_user';
  description =
    '当信息不足或存在多个合理方案需要用户决策时，向用户提问并等待回答。' +
    '不要用它询问是否可以使用工具；能通过读文件、搜索自行确认的信息不要问用户。';
  readonly parameters = askUserParams;
  requiresConfirmation = false;

  protected async run(
    params: Type.Static<typeof askUserParams>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const logger = context.logger;

    // ---- 语义校验：trim 后空白（schema 的 minLength 不 trim）----
    const question = params.question.trim();
    if (!question) {
      return this.error('ask_user 必须提供非空的 question 参数');
    }

    // 形状（数组、2-4 项、label 非空串）已由 schema 保证；此处只做 trim 规整
    let options: UserInputOption[] | undefined;
    if (params.options !== undefined) {
      options = [];
      for (let i = 0; i < params.options.length; i++) {
        const item = params.options[i];
        const label = item.label.trim();
        if (!label) {
          return this.error(`options[${i}].label 不能为空`);
        }
        const description = item.description?.trim() || undefined;
        options.push({ label, ...(description ? { description } : {}) });
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
