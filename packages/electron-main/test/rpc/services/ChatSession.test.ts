/**
 * ChatSession 会话逻辑测试（镜像 src/rpc/services/ChatSession.ts）
 *
 * 通过伪 Agent 工厂注入可控事件流，不触碰 Electron / 网络 / 文件系统。
 */

import { describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  AgentOptions,
  AppConfig,
  Logger,
  SendResult,
  ToolCall,
} from '@code-agent/contracts';
import {
  ChatSession,
  ChatSessionBusyError,
  type AgentFactory,
  type ChatAgent,
} from '../../../src/rpc/services/ChatSession';

// ---- 测试替身 ----

class FakeLogger implements Logger {
  readonly logs: Array<{ level: string; message: string }> = [];
  debug(message: string): void {
    this.logs.push({ level: 'debug', message });
  }
  info(message: string): void {
    this.logs.push({ level: 'info', message });
  }
  warn(message: string): void {
    this.logs.push({ level: 'warn', message });
  }
  error(message: string): void {
    this.logs.push({ level: 'error', message });
  }
}

type Script = () => AsyncGenerator<AgentEvent, SendResult>;

class FakeAgent implements ChatAgent {
  readonly options: AgentOptions;
  readonly messages: string[] = [];
  aborted = false;
  script: Script = async function* () {
    return { status: 'completed', steps: 1 };
  };

  constructor(options: AgentOptions) {
    this.options = options;
  }

  run(message: string): AsyncGenerator<AgentEvent, SendResult> {
    this.messages.push(message);
    return this.script();
  }

  abort(): void {
    this.aborted = true;
  }
}

const APP_CONFIG: AppConfig = {
  api: {
    apiKey: 'test-key',
    baseUrl: 'http://fake',
    model: 'fake-model',
    temperature: 0.3,
    maxTokens: 1024,
  },
};

const TOOL_CALL: ToolCall = { id: 't1', name: 'write_file', arguments: { path: 'a.txt' } };

/** scriptFor 在每次创建 Agent 时调用，便于按实例定制事件流 */
function createHarness(scriptFor?: (agent: FakeAgent) => Script) {
  const config = { value: structuredClone(APP_CONFIG) };
  const workspace = { projectPath: '/tmp/project' as string | null };
  const agents: FakeAgent[] = [];
  const factory: AgentFactory = (_config, _projectPath, options) => {
    const agent = new FakeAgent(options);
    if (scriptFor) agent.script = scriptFor(agent);
    agents.push(agent);
    return agent;
  };
  const session = new ChatSession(
    { getCached: () => config.value },
    workspace,
    new FakeLogger(),
    factory,
  );
  return { session, config, workspace, agents };
}

async function collect(gen: AsyncGenerator<AgentEvent, SendResult>): Promise<{
  events: AgentEvent[];
  result: SendResult;
}> {
  const events: AgentEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

/** 让出事件循环，确保生成器已推进到 await onConfirm */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 确认门控脚本：先发确认事件，等待宿主决议，再按决议回灌结果 */
const confirmScript = (agent: FakeAgent): Script => async function* () {
  yield {
    type: 'tool_call_confirm',
    data: { toolCallId: TOOL_CALL.id, toolName: TOOL_CALL.name, arguments: TOOL_CALL.arguments },
  };
  const approved = await agent.options.onConfirm!(TOOL_CALL);
  // 与真实引擎一致：确认等待期间被取消则直接退出，不回灌工具结果
  if (agent.aborted) return { status: 'aborted' };
  yield {
    type: 'tool_call_result',
    data: {
      toolCallId: TOOL_CALL.id,
      toolName: TOOL_CALL.name,
      result: { success: approved, content: String(approved) },
    },
  };
  return { status: 'completed', steps: 1 };
};

/** 驱动到确认事件，并返回被挂起的下一次 next() */
async function reachConfirm(gen: AsyncGenerator<AgentEvent, SendResult>) {
  const first = await gen.next();
  expect(first.done).toBe(false);
  if (first.done || first.value.type !== 'tool_call_confirm') {
    throw new Error('expected tool_call_confirm');
  }
  const pending = gen.next();
  await tick();
  // 用对象包装：直接 return promise 会被 async 函数自动 await，导致测试自己锁死
  return { pending };
}

/** 断言下一帧是工具结果并返回其 success */
async function expectToolResult(
  pending: Promise<IteratorResult<AgentEvent, SendResult>>,
): Promise<boolean> {
  const next = await pending;
  if (next.done || next.value.type !== 'tool_call_result') {
    throw new Error('expected tool_call_result');
  }
  return next.value.data.result.success;
}

// ---- 会话保持 ----

describe('ChatSession 会话保持', () => {
  it('连续两轮复用同一 Agent，上下文消息按序累积', async () => {
    const h = createHarness();

    await collect(h.session.start('第一轮'));
    await collect(h.session.start('第二轮'));

    expect(h.agents).toHaveLength(1);
    expect(h.agents[0].messages).toEqual(['第一轮', '第二轮']);
  });

  it('配置变更后重建 Agent', async () => {
    const h = createHarness();
    await collect(h.session.start('one'));

    h.config.value = { api: { ...h.config.value.api, model: 'another-model' } };
    await collect(h.session.start('two'));

    expect(h.agents).toHaveLength(2);
  });

  it('项目路径变更后重建 Agent', async () => {
    const h = createHarness();
    await collect(h.session.start('one'));

    h.workspace.projectPath = '/tmp/another';
    await collect(h.session.start('two'));

    expect(h.agents).toHaveLength(2);
  });

  it('未闭环的工具调用会把会话标记为脏，下次重建', async () => {
    const h = createHarness(() => async function* () {
      yield {
        type: 'message_complete',
        data: {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 't1', name: 'write_file', arguments: {} },
              { id: 't2', name: 'write_file', arguments: {} },
            ],
          },
          step: 1,
        },
      };
      yield {
        type: 'tool_call_result',
        data: {
          toolCallId: 't1',
          toolName: 'write_file',
          result: { success: true, content: 'ok' },
        },
      };
      return { status: 'aborted' };
    });

    await collect(h.session.start('one'));
    expect(h.agents).toHaveLength(1);

    await collect(h.session.start('two'));
    expect(h.agents).toHaveLength(2);
  });

  it('工具调用全部闭环时保持同一 Agent', async () => {
    const h = createHarness(() => async function* () {
      yield {
        type: 'message_complete',
        data: {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 't1', name: 'write_file', arguments: {} }],
          },
          step: 1,
        },
      };
      yield {
        type: 'tool_call_result',
        data: {
          toolCallId: 't1',
          toolName: 'write_file',
          result: { success: true, content: 'ok' },
        },
      };
      return { status: 'completed', steps: 1 };
    });

    await collect(h.session.start('one'));
    await collect(h.session.start('two'));

    expect(h.agents).toHaveLength(1);
  });

  it('流进行中再次发起对话抛忙锁异常，结束后可再次开始', async () => {
    const h = createHarness();
    const gen = h.session.start('one');

    expect(() => h.session.start('two')).toThrow(ChatSessionBusyError);
    await collect(gen);

    await expect(collect(h.session.start('three'))).resolves.toBeDefined();
  });

  it('生成器返回值原样透传', async () => {
    const h = createHarness(() => async function* () {
      yield { type: 'text_delta', data: { delta: 'hi' } };
      return { status: 'finished', steps: 3, summary: 'done' };
    });

    const { result } = await collect(h.session.start('go'));

    expect(result).toEqual({ status: 'finished', steps: 3, summary: 'done' });
  });
});

// ---- 确认门控 ----

describe('ChatSession 确认门控', () => {
  it('onConfirm 挂起，confirm(true) 放行并继续事件流', async () => {
    const h = createHarness((agent) => confirmScript(agent));
    const gen = h.session.start('go');

    const { pending } = await reachConfirm(gen);
    h.session.confirm(TOOL_CALL.id, true);

    expect(await expectToolResult(pending)).toBe(true);
    await collect(gen);
  });

  it('confirm(false) 拒绝后工具结果为失败', async () => {
    const h = createHarness((agent) => confirmScript(agent));
    const gen = h.session.start('go');

    const { pending } = await reachConfirm(gen);
    h.session.confirm(TOOL_CALL.id, false);

    expect(await expectToolResult(pending)).toBe(false);
    await collect(gen);
  });

  it('未知与重复决议均静默，且 first-wins', async () => {
    const h = createHarness((agent) => confirmScript(agent));

    expect(() => h.session.confirm('unknown-id', true)).not.toThrow();

    const gen = h.session.start('go');
    const { pending } = await reachConfirm(gen);
    h.session.confirm(TOOL_CALL.id, true);
    h.session.confirm(TOOL_CALL.id, false); // 重复决议应被忽略

    expect(await expectToolResult(pending)).toBe(true);
    await collect(gen);
  });

  it('abort 时中断引擎并把待决确认按拒绝收口', async () => {
    const h = createHarness((agent) => confirmScript(agent));
    const gen = h.session.start('go');

    const { pending } = await reachConfirm(gen);
    h.session.abort();

    expect(h.agents[0].aborted).toBe(true);
    // 待决确认被 settle 后生成器继续执行并返回中断终局（不回灌工具结果）
    const next = await pending;
    expect(next.done).toBe(true);
    if (!next.done) throw new Error('expected generator to finish');
    expect(next.value).toEqual({ status: 'aborted' });

    // 终局后忙锁复位，可再次开始；待决表已清空，迟到决议不抛错
    h.agents[0].script = async function* () {
      return { status: 'completed', steps: 1 };
    };
    await expect(collect(h.session.start('again'))).resolves.toBeDefined();
    expect(() => h.session.confirm(TOOL_CALL.id, true)).not.toThrow();
  });
});
