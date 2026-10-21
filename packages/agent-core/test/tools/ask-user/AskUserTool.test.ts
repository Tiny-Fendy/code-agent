import { describe, it, expect, vi } from 'vitest';
import { AskUserTool } from '@/tools/ask-user';
import type { Logger, ToolContext, UserInputCallback, UserInputRequest } from '@code-agent/contracts';

/** 记录日志调用，供埋点断言 */
class FakeLogger implements Logger {
  readonly logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  debug(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'debug', message, context });
  }
  info(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'info', message, context });
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'warn', message, context });
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.logs.push({ level: 'error', message, context });
  }
}

const tool = new AskUserTool();

/** 构造带回调的上下文 */
function ctxWith(callback?: UserInputCallback, logger?: Logger): ToolContext {
  return {
    projectPath: '/tmp/test',
    ...(callback ? { requestUserInput: callback } : {}),
    ...(logger ? { logger } : {}),
  };
}

describe('AskUserTool 元数据', () => {
  it('名称、确认策略与参数 schema 正确', () => {
    expect(tool.name).toBe('ask_user');
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.parameters.required).toEqual(['question']);
    expect(tool.parameters.properties.options.minItems).toBe(2);
    expect(tool.parameters.properties.options.maxItems).toBe(4);
  });
});

describe('参数校验', () => {
  it('缺失 question 返回 error', async () => {
    const result = await tool.execute({}, ctxWith(vi.fn()));
    expect(result.success).toBe(false);
    expect(result.error).toContain('question');
  });

  it('空白 question 返回 error', async () => {
    const result = await tool.execute({ question: '   \n ' }, ctxWith(vi.fn()));
    expect(result.success).toBe(false);
  });

  it('options 仅 1 个返回 error', async () => {
    const result = await tool.execute(
      { question: '选哪个？', options: [{ label: 'A' }] },
      ctxWith(vi.fn()),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('2-4');
  });

  it('options 超过 4 个返回 error', async () => {
    const options = ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label }));
    const result = await tool.execute({ question: '选哪个？', options }, ctxWith(vi.fn()));
    expect(result.success).toBe(false);
    expect(result.error).toContain('2-4');
  });

  it('options 非数组返回 error', async () => {
    const result = await tool.execute({ question: '选哪个？', options: 'A,B' }, ctxWith(vi.fn()));
    expect(result.success).toBe(false);
    expect(result.error).toContain('数组');
  });

  it('option.label 空白返回 error 并指明下标', async () => {
    const result = await tool.execute(
      { question: '选哪个？', options: [{ label: 'A' }, { label: '  ' }] },
      ctxWith(vi.fn()),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('options[1].label');
  });

  it('参数非法时不调用宿主回调', async () => {
    const onAsk = vi.fn();
    await tool.execute({ question: '' }, ctxWith(onAsk));
    expect(onAsk).not.toHaveBeenCalled();
  });
});

describe('请求透传', () => {
  it('回调收到裁剪后的 question、规范化 options 与 allowMultiple', async () => {
    const captured: UserInputRequest[] = [];
    const onAsk: UserInputCallback = async (request) => {
      captured.push(request);
      return { selected: ['方案 B'] };
    };

    await tool.execute(
      {
        question: '  选哪个方案？  ',
        options: [
          { label: ' 方案 A ' },
          { label: '方案 B', description: '  更稳妥  ' },
        ],
        allowMultiple: true,
      },
      ctxWith(onAsk),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      question: '选哪个方案？',
      options: [{ label: '方案 A' }, { label: '方案 B', description: '更稳妥' }],
      allowMultiple: true,
    });
  });

  it('省略 options 时按自由输入透传（options undefined）', async () => {
    const captured: UserInputRequest[] = [];
    const onAsk: UserInputCallback = async (request) => {
      captured.push(request);
      return { text: '自定义回答' };
    };

    await tool.execute({ question: '你的偏好？' }, ctxWith(onAsk));

    expect(captured[0]).toEqual({ question: '你的偏好？', options: undefined, allowMultiple: false });
  });

  it('options 为空数组等价于省略', async () => {
    const captured: UserInputRequest[] = [];
    const onAsk: UserInputCallback = async (request) => {
      captured.push(request);
      return { text: '自定义回答' };
    };

    await tool.execute({ question: '你的偏好？', options: [] }, ctxWith(onAsk));

    expect(captured[0].options).toBeUndefined();
  });

  it('无 options 时 allowMultiple 恒为 false', async () => {
    const captured: UserInputRequest[] = [];
    const onAsk: UserInputCallback = async (request) => {
      captured.push(request);
      return { text: 'ok' };
    };

    await tool.execute({ question: '偏好？', allowMultiple: true }, ctxWith(onAsk));

    expect(captured[0].allowMultiple).toBe(false);
  });
});

describe('回答映射', () => {
  it('单选返回 用户选择：A', async () => {
    const result = await tool.execute(
      { question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
      ctxWith(async () => ({ selected: ['A'] })),
    );
    expect(result).toEqual({ success: true, content: '用户选择：A' });
  });

  it('多选返回 用户选择：A、B', async () => {
    const result = await tool.execute(
      { question: '选哪些？', options: [{ label: 'A' }, { label: 'B' }], allowMultiple: true },
      ctxWith(async () => ({ selected: ['A', 'B'] })),
    );
    expect(result).toEqual({ success: true, content: '用户选择：A、B' });
  });

  it('自由输入返回 用户输入：...', async () => {
    const result = await tool.execute(
      { question: '你的偏好？' },
      ctxWith(async () => ({ text: '  用 TypeScript  ' })),
    );
    expect(result).toEqual({ success: true, content: '用户输入：用 TypeScript' });
  });

  it('selected 优先于 text', async () => {
    const result = await tool.execute(
      { question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
      ctxWith(async () => ({ selected: ['A'], text: '补充说明' })),
    );
    expect(result.content).toBe('用户选择：A');
  });

  it('空白 selected 视为未选择，回落到 text', async () => {
    const result = await tool.execute(
      { question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
      ctxWith(async () => ({ selected: ['  '], text: '其他方案' })),
    );
    expect(result.content).toBe('用户输入：其他方案');
  });

  it('空回答返回 error', async () => {
    const result = await tool.execute({ question: '你的偏好？' }, ctxWith(async () => ({})));
    expect(result.success).toBe(false);
    expect(result.error).toContain('未作出选择');
  });

  it('单选场景返回多个选项报错', async () => {
    const result = await tool.execute(
      { question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
      ctxWith(async () => ({ selected: ['A', 'B'] })),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('只能返回一个');
  });
});

describe('降级策略', () => {
  it('未注入回调返回不支持交互错误', async () => {
    const result = await tool.execute({ question: '选哪个？' }, ctxWith());
    expect(result.success).toBe(false);
    expect(result.error).toContain('不支持用户交互');
  });

  it('回调抛异常时返回 用户交互失败 错误，不向上抛', async () => {
    const result = await tool.execute(
      { question: '选哪个？' },
      ctxWith(async () => {
        throw new Error('RPC 断开');
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('用户交互失败');
    expect(result.error).toContain('RPC 断开');
  });
});

describe('日志埋点', () => {
  it('请求与回答记录 info，含选项数量与耗时', async () => {
    const logger = new FakeLogger();
    await tool.execute(
      { question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
      ctxWith(async () => ({ selected: ['A'] }), logger),
    );

    const infoMessages = logger.logs.filter((l) => l.level === 'info').map((l) => l.message);
    expect(infoMessages).toEqual(['ask_user 请求', 'ask_user 回答']);
    expect(logger.logs[0].context).toMatchObject({ optionCount: 2, allowMultiple: false });
    expect(logger.logs[1].context).toMatchObject({ selectedCount: 1 });
    expect(typeof logger.logs[1].context?.durationMs).toBe('number');
  });

  it('未接入交互与空回答记录 warn', async () => {
    const logger = new FakeLogger();
    await tool.execute({ question: '选哪个？' }, ctxWith(undefined, logger));
    await tool.execute({ question: '选哪个？' }, ctxWith(async () => ({}), logger));

    const warnMessages = logger.logs.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(warnMessages).toEqual(['ask_user 未接入用户交互', 'ask_user 空回答']);
  });
});
