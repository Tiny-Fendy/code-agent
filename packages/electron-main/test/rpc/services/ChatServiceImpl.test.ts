/**
 * ChatServiceImpl 测试（镜像 src/rpc/services/ChatServiceImpl.ts）
 *
 * 契约关注点：send 把会话生成器包装成流并桥接取消、忙锁翻译为 chat.BUSY 失败终局、
 * confirmTool 把 UI 决议送进会话。rpc 工厂与 Agent 用测试替身替换，
 * 这里只验证适配层行为，不重复 ChatSession 的会话逻辑用例。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  type AgentEvent,
  type AppConfig,
  type Logger,
  type SendResult,
} from '@code-agent/contracts';
import type { ConfigServiceImpl } from '../../../src/rpc/services/ConfigServiceImpl';

const h = vi.hoisted(() => {
  const agents: Array<any> = [];
  const streams: Array<any> = [];
  const state = {
    script: async function* (): AsyncGenerator<AgentEvent, SendResult> {
      return { status: 'completed', steps: 0 };
    } as (agent: any) => AsyncGenerator<AgentEvent, SendResult>,
    confirmResult: undefined as boolean | undefined,
  };

  class Agent {
    readonly messages: string[] = [];
    aborted = false;

    constructor(
      readonly config: any,
      readonly projectPath: string,
      readonly options: any,
    ) {
      agents.push(this);
    }

    run(message: string): AsyncGenerator<AgentEvent, SendResult> {
      this.messages.push(message);
      return state.script(this);
    }

    abort(): void {
      this.aborted = true;
    }
  }

  function createRpcStream(gen?: AsyncGenerator<AgentEvent, SendResult>): any {
    const stream = {
      gen,
      abortHooks: [] as Array<() => void>,
      onAbort(cb: () => void) {
        stream.abortHooks.push(cb);
      },
      error: vi.fn(),
      emit: vi.fn(),
      end: vi.fn(),
    };
    streams.push(stream);
    return stream;
  }

  return { agents, streams, state, Agent, createRpcStream };
});

vi.mock('@code-agent/agent-core', () => ({ Agent: h.Agent }));
vi.mock('@code-agent/rpc/main', () => ({ createRpcStream: h.createRpcStream }));

import { ChatServiceImpl } from '../../../src/rpc/services/ChatServiceImpl';
import { WorkspaceState } from '../../../src/rpc/services/WorkspaceState';

type FakeStream = {
  gen?: AsyncGenerator<AgentEvent, SendResult>;
  abortHooks: Array<() => void>;
  error: ReturnType<typeof vi.fn>;
};

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createService(config: AppConfig = DEFAULT_CONFIG) {
  const workspace = new WorkspaceState();
  workspace.setProjectPath('/tmp/project');
  const configSource = {
    getCached: () => structuredClone(config),
  } as unknown as ConfigServiceImpl;
  return new ChatServiceImpl(configSource, workspace, logger);
}

beforeEach(() => {
  h.agents.length = 0;
  h.streams.length = 0;
  h.state.script = async function* () {
    return { status: 'completed', steps: 0 };
  };
  h.state.confirmResult = undefined;
  vi.clearAllMocks();
});

describe('ChatServiceImpl.send', () => {
  it('包装会话生成器：事件逐帧转发，终局透传 SendResult', async () => {
    h.state.script = async function* () {
      yield { type: 'text_delta', data: { delta: 'hi' } };
      return { status: 'completed', steps: 1 };
    };
    const service = createService();

    const stream = service.send('hello') as unknown as FakeStream;

    await expect(stream.gen!.next()).resolves.toEqual({
      done: false,
      value: { type: 'text_delta', data: { delta: 'hi' } },
    });
    await expect(stream.gen!.next()).resolves.toEqual({
      done: true,
      value: { status: 'completed', steps: 1 },
    });
  });

  it('用当前配置与项目路径创建 Agent，并注册取消钩子', async () => {
    const config: AppConfig = {
      api: { ...DEFAULT_CONFIG.api, model: 'test-model', apiKey: 'test-key' },
    };
    const service = createService(config);

    const stream = service.send('hello') as unknown as FakeStream;
    await stream.gen!.next();

    expect(h.agents).toHaveLength(1);
    expect(h.agents[0].config).toMatchObject({ model: 'test-model', apiKey: 'test-key' });
    expect(h.agents[0].projectPath).toBe('/tmp/project');
    expect(stream.abortHooks).toHaveLength(1);
  });

  it('上一条流未终局时再次 send 返回 chat.BUSY 失败流', () => {
    const service = createService();

    service.send('first');
    const second = service.send('second') as unknown as FakeStream;

    expect(second.error).toHaveBeenCalledWith({
      code: 'chat.BUSY',
      message: '上一条对话仍在进行中',
    });
  });

  it('取消钩子中断 Agent 并解除确认等待，生成器正常收尾', async () => {
    h.state.script = async function* (agent: any) {
      await agent.options.onConfirm({ id: 'call-1', name: 'write_file', arguments: {} });
      return { status: 'aborted' };
    };
    const service = createService();

    const stream = service.send('write file') as unknown as FakeStream;
    const pending = stream.gen!.next();

    stream.abortHooks[0]();

    await expect(pending).resolves.toEqual({ done: true, value: { status: 'aborted' } });
    expect(h.agents[0].aborted).toBe(true);
  });
});

describe('ChatServiceImpl.confirmTool', () => {
  it('把 UI 决议送入会话，挂起的确认得到放行', async () => {
    h.state.script = async function* (agent: any) {
      h.state.confirmResult = await agent.options.onConfirm({
        id: 'call-1',
        name: 'write_file',
        arguments: {},
      });
      return { status: 'completed', steps: 1 };
    };
    const service = createService();

    const stream = service.send('write file') as unknown as FakeStream;
    const pending = stream.gen!.next();

    await service.confirmTool('call-1', true);

    await expect(pending).resolves.toEqual({
      done: true,
      value: { status: 'completed', steps: 1 },
    });
    expect(h.state.confirmResult).toBe(true);
  });
});
