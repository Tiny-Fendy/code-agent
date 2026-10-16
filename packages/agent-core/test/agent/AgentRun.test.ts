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

import { describe, it, expect } from 'vitest';
import { Agent } from '../../src/agent/Agent';
import { LLMProvider, type ChatCompletionParams, type LLMEvent } from '../../src/llm/LLMProvider';
import type { AgentEvent, ChatMessage, SendResult } from '@code-agent/shared';

/** 假 LLM：每次 chat 调用都按脚本重新生成事件 */
class FakeProvider extends LLMProvider {
  constructor(private readonly script: () => AsyncGenerator<LLMEvent>) {
    super('fake-key', 'http://fake');
  }
  chat(_params: ChatCompletionParams): AsyncGenerator<LLMEvent> {
    return this.script();
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
});
