/**
 * Agent.run 四退出点测试（v2 深接入）
 *
 * 事件流只含过程数据，终局语义全部由生成器返回值 SendResult 承载：
 * - completed: LLM 给出最终答案（统计信息在 result 中）
 * - llmFailed: LLM 失败（不再外发 error 事件，原因在 result.message）
 * - maxSteps:  达到最大思考步数
 * - aborted:   被 abort() 中断
 *
 * 通过替换私有 llm 字段注入假 Provider，不触碰真实网络与文件系统。
 */

import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../../src/agent/Agent';
import { LLMProvider, type ChatCompletionParams, type LLMEvent, type LLMRequest } from '../../src/llm/LLMProvider';
import type { AgentEvent, ChatMessage, SendResult, UserInputCallback } from '@code-agent/contracts';

/** 假 LLM：每次 chat 调用都按脚本重新生成事件，并记录请求参数与 abort 调用 */
class FakeProvider extends LLMProvider {
  readonly calls: ChatCompletionParams[] = [];
  /** 请求句柄 abort() 的调用次数，供中断链路断言 */
  abortCalls = 0;
  constructor(private readonly script: () => AsyncGenerator<LLMEvent>) {
    super('fake-key', 'http://fake');
  }
  chat(params: ChatCompletionParams): LLMRequest {
    this.calls.push(params);
    return {
      events: this.script(),
      abort: () => {
        this.abortCalls++;
      },
    };
  }
}

/** 假 Logger：记录全部日志调用供断言（Logger 契约：不抛异常） */
class FakeLogger {
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
  messages(level: string): string[] {
    return this.logs.filter((l) => l.level === level).map((l) => l.message);
  }
}

function createAgent(script: () => AsyncGenerator<LLMEvent>, maxSteps = 10): Agent {
  const agent = new Agent(
    { apiKey: 'fake', baseUrl: 'http://fake', model: 'fake', maxSteps },
    process.cwd(),
  );
  // Agent 未提供 Provider 注入点，测试直接替换私有字段
  (agent as unknown as { llm: LLMProvider }).llm = new FakeProvider(script);
  return agent;
}

/** 带 FakeLogger 注入的 createAgent（日志埋点断言用） */
function createAgentWithLogger(
  script: () => AsyncGenerator<LLMEvent>,
  maxSteps = 10,
): { agent: Agent; logger: FakeLogger } {
  const logger = new FakeLogger();
  const agent = new Agent(
    { apiKey: 'fake', baseUrl: 'http://fake', model: 'fake', maxSteps },
    process.cwd(),
    { logger },
  );
  (agent as unknown as { llm: LLMProvider }).llm = new FakeProvider(script);
  return { agent, logger };
}

/** 带 onAskUser 注入的 createAgent，返回 provider 以断言回灌消息 */
function createAgentWithAsk(
  script: () => AsyncGenerator<LLMEvent>,
  onAskUser: UserInputCallback,
  maxSteps = 10,
): { agent: Agent; logger: FakeLogger; provider: FakeProvider } {
  const logger = new FakeLogger();
  const provider = new FakeProvider(script);
  const agent = new Agent(
    { apiKey: 'fake', baseUrl: 'http://fake', model: 'fake', maxSteps },
    process.cwd(),
    { logger, onAskUser },
  );
  (agent as unknown as { llm: LLMProvider }).llm = provider;
  return { agent, logger, provider };
}

/** 手动迭代收集事件与生成器返回值（for-await 会丢弃 return 值） */
async function collect(gen: AsyncGenerator<AgentEvent, SendResult>) {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return { events, result: r.value };
}

const textMessage = (content: string): ChatMessage => ({ role: 'assistant', content });

/** 每轮都返回同一个不存在的工具调用：工具执行失败回灌后继续循环，用于撑满步数 */
const toolCallMessage = (): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id: 'tc-1', name: 'nonexistent_tool', arguments: {} }],
});

describe('Agent.run 终局结果', () => {
  it('正常完成：return completed，统计步数在 result 中', async () => {
    const { events, result } = await collect(
      createAgent(async function* () {
        yield { type: 'text_delta', data: { delta: '你好' } };
        yield { type: 'message_complete', data: { message: textMessage('你好') } };
      }).run('hi'),
    );

    expect(result).toEqual({ status: 'completed', steps: 1 });
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'message_complete']);
  });

  it('finish 工具调用：return finished，携带 summary', async () => {
    const { events, result } = await collect(
      createAgent(async function* () {
        yield {
          type: 'message_complete',
          data: {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'tc-finish', name: 'finish', arguments: { summary: '任务完成，共修改 3 个文件' } }],
            },
          },
        };
      }).run('hi'),
    );

    expect(result).toEqual({
      status: 'finished',
      steps: 1,
      summary: '任务完成，共修改 3 个文件',
    });
    // finish 工具正常执行，有 tool_call_start 和 tool_call_result
    expect(events.map((e) => e.type)).toEqual(['message_complete', 'tool_call_start', 'tool_call_result']);
  });

  it('finish 空 summary：返回 error，Agent 继续循环', async () => {
    let callCount = 0;
    const { events, result } = await collect(
      createAgent(async function* () {
        callCount++;
        if (callCount === 1) {
          // 第一轮：finish 空 summary
          yield {
            type: 'message_complete',
            data: {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'tc-finish', name: 'finish', arguments: { summary: '' } }],
              },
            },
          };
        } else {
          // 第二轮：正常完成
          yield { type: 'message_complete', data: { message: textMessage('完成') } };
        }
      }).run('hi'),
    );

    expect(result).toEqual({ status: 'completed', steps: 2 });
    // 第一轮 finish 返回 error，第二轮正常结束
    const toolResults = events.filter((e) => e.type === 'tool_call_result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].data.result.success).toBe(false);
  });

  it('LLM 失败：return llmFailed，不外发 error 事件', async () => {
    const { events, result } = await collect(
      createAgent(async function* () {
        yield { type: 'text_delta', data: { delta: '残' } };
        yield { type: 'error', data: { message: 'API 错误 (401): unauthorized' } };
      }).run('hi'),
    );

    expect(result).toEqual({ status: 'llmFailed', message: 'API 错误 (401): unauthorized' });
    expect(events.map((e) => e.type)).toEqual(['text_delta']);
  });

  it('超步数：return maxSteps', async () => {
    const { events, result } = await collect(
      createAgent(async function* () {
        yield { type: 'message_complete', data: { message: toolCallMessage() } };
      }, 2).run('hi'),
    );

    expect(result).toEqual({ status: 'maxSteps', steps: 2 });
    // 每步都尝试了工具调用（未知工具 → 失败结果回灌）
    expect(events.filter((e) => e.type === 'tool_call_result')).toHaveLength(2);
  });

  it('中断：abort() 后 return aborted', async () => {
    const agent = createAgent(async function* () {
      yield { type: 'text_delta', data: { delta: 'x' } };
      // 留出窗口让 abort() 先执行
      await new Promise((r) => setTimeout(r, 30));
      yield { type: 'message_complete', data: { message: textMessage('不该到达') } };
    });

    const gen = agent.run('hi');
    const first = await gen.next();
    expect(first.done).toBe(false);

    agent.abort();

    let r = await gen.next();
    while (!r.done) r = await gen.next();
    expect(r.value).toEqual({ status: 'aborted' });
  });

  it('中断：abort() 调用在途请求句柄的 abort()（不等流事件到达）', async () => {
    const provider = new FakeProvider(async function* () {
      yield { type: 'text_delta', data: { delta: 'x' } };
      // 挂起窗口：模拟长思考停顿，句柄 abort 应在等待期间就被调用
      await new Promise((r) => setTimeout(r, 30));
      yield { type: 'message_complete', data: { message: textMessage('不该到达') } };
    });
    const agent = new Agent(
      { apiKey: 'fake', baseUrl: 'http://fake', model: 'fake', maxSteps: 10 },
      process.cwd(),
    );
    (agent as unknown as { llm: LLMProvider }).llm = provider;

    const gen = agent.run('hi');
    await gen.next(); // text_delta

    agent.abort();

    // 在途请求句柄的 abort 随 Agent.abort() 立即调用，不等流事件
    expect(provider.abortCalls).toBe(1);

    let r = await gen.next();
    while (!r.done) r = await gen.next();
    expect(r.value).toEqual({ status: 'aborted' });
  });
});

describe('Agent.run 日志埋点（FakeLogger 注入）', () => {
  it('正常完成：任务开始 → LLM 请求/响应 → 任务终局（completed）全链路 info', async () => {
    const { agent, logger } = createAgentWithLogger(async function* () {
      yield { type: 'text_delta', data: { delta: '你好' } };
      yield { type: 'message_complete', data: { message: textMessage('你好') } };
    });

    await collect(agent.run('列出结构'));

    const infos = logger.messages('info');
    expect(infos[0]).toBe('任务开始');
    expect(logger.logs[0].context).toMatchObject({ messageLength: '列出结构'.length, maxSteps: 10 });

    expect(infos).toContain('LLM 请求');
    expect(infos).toContain('LLM 响应');
    expect(infos[infos.length - 1]).toBe('任务终局');
    expect(logger.logs[logger.logs.length - 1].context).toMatchObject({ status: 'completed', steps: 1 });
  });

  it('finish 工具：工具执行完成 info + finish 命中 info + 终局 finished 含 summaryLength', async () => {
    const { agent, logger } = createAgentWithLogger(async function* () {
      yield {
        type: 'message_complete',
        data: {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc-finish', name: 'finish', arguments: { summary: '全部完成' } }],
          },
        },
      };
    });

    await collect(agent.run('hi'));

    const infos = logger.messages('info');
    expect(infos).toContain('工具执行完成');
    expect(infos).toContain('finish 命中');
    const last = logger.logs[logger.logs.length - 1];
    expect(last.context).toMatchObject({ status: 'finished', steps: 1, summaryLength: '全部完成'.length });
  });

  it('LLM 失败：LLM 调用失败 error + 终局 llmFailed 携带错误信息', async () => {
    const { agent, logger } = createAgentWithLogger(async function* () {
      yield { type: 'error', data: { message: '[network] boom' } };
    });

    await collect(agent.run('hi'));

    expect(logger.messages('error')).toEqual(['LLM 调用失败']);
    const errorLog = logger.logs.find((l) => l.level === 'error');
    expect(errorLog?.context).toMatchObject({ error: '[network] boom' });

    const last = logger.logs[logger.logs.length - 1];
    expect(last.context).toMatchObject({ status: 'llmFailed', error: '[network] boom' });
  });

  it('工具未找到：ToolManager 层 warn（工具不存在时）', async () => {
    // FakeProvider 每轮重新生成脚本：用 callCount 区分轮次，
    // 第一轮返回工具调用（单 yield），第二轮返回纯文本
    let callCount = 0;
    const { agent, logger } = createAgentWithLogger(async function* (): AsyncGenerator<LLMEvent> {
      callCount++;
      if (callCount === 1) {
        yield {
          type: 'message_complete',
          data: { message: toolCallMessage() }, // nonexistent_tool
        };
      } else {
        yield { type: 'message_complete', data: { message: textMessage('结束') } };
      }
    }, 3);

    const { result } = await collect(agent.run('hi'));

    expect(result).toEqual({ status: 'completed', steps: 2 });
    expect(logger.messages('warn')).toContain('工具未找到');
    const warnLog = logger.logs.find((l) => l.message === '工具未找到');
    expect(warnLog?.context).toMatchObject({ tool: 'nonexistent_tool' });
  });

  it('LLM 请求原文与响应原文进 debug 级别', async () => {
    const { agent, logger } = createAgentWithLogger(async function* () {
      yield { type: 'message_complete', data: { message: textMessage('ok') } };
    });

    await collect(agent.run('hi'));

    const debugs = logger.messages('debug');
    expect(debugs).toContain('LLM 请求原文');
    expect(debugs).toContain('LLM 响应原文');
  });
});

describe('Agent.run ask_user 交互', () => {
  /** 第一轮询问用户，第二轮自然结束 */
  const askThenComplete = (): (() => AsyncGenerator<LLMEvent>) => {
    let callCount = 0;
    return async function* () {
      callCount++;
      if (callCount === 1) {
        yield {
          type: 'message_complete',
          data: {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'tc-ask',
                  name: 'ask_user',
                  arguments: {
                    question: '选择哪个方案？',
                    options: [{ label: '方案 A' }, { label: '方案 B', description: '更稳妥' }],
                  },
                },
              ],
            },
          },
        };
      } else {
        yield { type: 'message_complete', data: { message: textMessage('按方案 A 执行') } };
      }
    };
  };

  it('注入 onAskUser：回答作为 tool 消息回灌并继续下一轮', async () => {
    const onAskUser = vi.fn<UserInputCallback>(async () => ({ selected: ['方案 A'] }));
    const { agent, provider } = createAgentWithAsk(askThenComplete(), onAskUser);

    const { events, result } = await collect(agent.run('开始'));

    expect(result).toEqual({ status: 'completed', steps: 2 });
    expect(onAskUser).toHaveBeenCalledTimes(1);
    expect(onAskUser.mock.calls[0][0]).toEqual({
      question: '选择哪个方案？',
      options: [{ label: '方案 A' }, { label: '方案 B', description: '更稳妥' }],
      allowMultiple: false,
    });

    // 事件流：tool_call_start → tool_call_result，无新增事件类型
    const toolEventTypes = events
      .filter((e) => e.type === 'tool_call_start' || e.type === 'tool_call_result')
      .map((e) => e.type);
    expect(toolEventTypes).toEqual(['tool_call_start', 'tool_call_result']);
    const toolResults = events.filter((e) => e.type === 'tool_call_result');
    expect(toolResults[0].data.result).toEqual({ success: true, content: '用户选择：方案 A' });

    // 回灌断言：第二轮请求的最后一条消息是 tool 角色，内容为回答
    expect(provider.calls).toHaveLength(2);
    const secondMessages = provider.calls[1].messages;
    const lastMessage = secondMessages[secondMessages.length - 1];
    expect(lastMessage.role).toBe('tool');
    expect(lastMessage.content).toBe('用户选择：方案 A');
    expect(lastMessage.toolCallId).toBe('tc-ask');
  });

  it('未注入 onAskUser：返回错误观察，Agent 循环继续', async () => {
    const provider = new FakeProvider(askThenComplete());
    const agent = new Agent(
      { apiKey: 'fake', baseUrl: 'http://fake', model: 'fake', maxSteps: 10 },
      process.cwd(),
    );
    (agent as unknown as { llm: LLMProvider }).llm = provider;

    const { events, result } = await collect(agent.run('开始'));

    expect(result).toEqual({ status: 'completed', steps: 2 });
    const toolResults = events.filter((e) => e.type === 'tool_call_result');
    expect(toolResults[0].data.result.success).toBe(false);
    expect(toolResults[0].data.result.error).toContain('不支持用户交互');

    const secondMessages = provider.calls[1].messages;
    const lastMessage = secondMessages[secondMessages.length - 1];
    expect(lastMessage.role).toBe('tool');
    expect(lastMessage.content).toContain('Error: 当前环境不支持用户交互');
  });

  it('回调抛异常：返回错误观察，不中断 Agent', async () => {
    const onAskUser = vi.fn<UserInputCallback>(async () => {
      throw new Error('UI 已关闭');
    });
    const { agent, provider } = createAgentWithAsk(askThenComplete(), onAskUser);

    const { result } = await collect(agent.run('开始'));

    expect(result).toEqual({ status: 'completed', steps: 2 });
    const secondMessages = provider.calls[1].messages;
    const lastMessage = secondMessages[secondMessages.length - 1];
    expect(lastMessage.content).toContain('用户交互失败: UI 已关闭');
  });
});
