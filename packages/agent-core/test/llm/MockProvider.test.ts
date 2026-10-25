/**
 * MockProvider 单元测试
 *
 * 覆盖：事件合成同构性、剧本消耗、耗尽行为、动态剧本、
 * 深拷贝隔离、模块级开关（类 API + 环境变量）、OpenAICompatible 委托路径。
 * 与源文件一一对应：src/llm/MockProvider.ts → test/llm/MockProvider.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MockProvider,
  setMockProvider,
  clearMockProvider,
  mockEnabled,
} from '../../src/llm/MockProvider';
import { LLMEventType } from '../../src/llm/LLMProvider';
import { OpenAICompatibleProvider } from '../../src/llm/OpenAICompatible';
import type { ChatCompletionParams, LLMEvent, LLMRequest } from '../../src/llm/LLMProvider';
import type { ChatMessage } from '@code-agent/contracts';

afterEach(() => {
  // 全局状态清理：显式单例 + env 惰性缓存 + 环境变量
  clearMockProvider();
  delete process.env.CODE_AGENT_MOCK_SCRIPT;
});

/** 收集请求的事件流为类型数组 */
async function collect(request: LLMRequest): Promise<LLMEvent[]> {
  const events: LLMEvent[] = [];
  for await (const event of request.events) {
    events.push(event);
  }
  return events;
}

const fakeParams: ChatCompletionParams = {
  model: 'fake',
  messages: [{ role: 'user', content: '你好' }],
};

const textMessage = (content: string): ChatMessage => ({ role: 'assistant', content });

const toolCallMessage = (): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id: 'call_1', name: 'list_dir', arguments: { path: '.' } }],
});

describe('MockProvider 事件合成（与真实 Provider 同构）', () => {
  it('纯文本：按默认粒度切分 yield TextDelta，末尾 MessageComplete，拼接结果完整', async () => {
    const provider = new MockProvider([textMessage('你好世界')]);
    const events = await collect(provider.chat(fakeParams));

    // "你好世界" 4 字符，默认 chunkSize=4 → 单块
    const deltas = events.filter(e => e.type === LLMEventType.TextDelta);
    expect(deltas).toHaveLength(1);
    expect((deltas[0].data as { delta: string }).delta).toBe('你好世界');

    const last = events[events.length - 1];
    expect(last.type).toBe(LLMEventType.MessageComplete);
  });

  it('纯文本：TextDelta 拼接 === 剧本 content，最后一条为 MessageComplete', async () => {
    const provider = new MockProvider([textMessage('这是一段测试文本内容')]);
    const events = await collect(provider.chat(fakeParams));

    const joined = events
      .filter(e => e.type === LLMEventType.TextDelta)
      .map(e => (e.data as { delta: string }).delta)
      .join('');
    expect(joined).toBe('这是一段测试文本内容');

    const last = events[events.length - 1];
    expect(last.type).toBe(LLMEventType.MessageComplete);
    expect((last.data as { message: ChatMessage }).message.content).toBe('这是一段测试文本内容');
  });

  it('TextDelta data 形状：仅含 delta 字段', async () => {
    const provider = new MockProvider([textMessage('abc')]);
    const events = await collect(provider.chat(fakeParams));

    for (const event of events.filter(e => e.type === LLMEventType.TextDelta)) {
      expect(Object.keys(event.data)).toEqual(['delta']);
    }
  });

  it('toolCalls：ToolCallDelta 累积形状正确，arguments 逐段变长且最终可解析回原对象', async () => {
    const provider = new MockProvider([toolCallMessage()]);
    const events = await collect(provider.chat(fakeParams));

    const deltas = events.filter(e => e.type === LLMEventType.ToolCallDelta);
    expect(deltas.length).toBeGreaterThan(0);

    let last: { id: string; name: string; arguments: string } | undefined;
    for (const event of deltas) {
      const data = event.data as { toolCalls: Array<{ id: string; name: string; arguments: string }> };
      expect(data.toolCalls).toHaveLength(1);
      expect(data.toolCalls[0].id).toBe('call_1');
      expect(data.toolCalls[0].name).toBe('list_dir');
      // 累积性：每次比上次长
      if (last) {
        expect(data.toolCalls[0].arguments.startsWith(last.arguments)).toBe(true);
      }
      last = data.toolCalls[0];
    }
    // 最终 arguments 可解析回原参数对象
    expect(JSON.parse(last!.arguments)).toEqual({ path: '.' });

    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe(LLMEventType.MessageComplete);
    const message = (lastEvent.data as { message: ChatMessage }).message;
    expect(message.toolCalls).toEqual([{ id: 'call_1', name: 'list_dir', arguments: { path: '.' } }]);
  });

  it('content 与 toolCalls 并存：先文本增量后工具增量，最后 MessageComplete', async () => {
    const message: ChatMessage = {
      role: 'assistant',
      content: '先说明',
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { file_path: 'a.ts' } }],
    };
    const provider = new MockProvider([message]);
    const events = await collect(provider.chat(fakeParams));

    const types = events.map(e => e.type);
    const firstTool = types.indexOf(LLMEventType.ToolCallDelta);
    const lastText = types.lastIndexOf(LLMEventType.TextDelta);
    expect(firstTool).toBeGreaterThan(lastText);
    expect(types[types.length - 1]).toBe(LLMEventType.MessageComplete);
  });

  it('多个 toolCalls：每次 ToolCallDelta 携带全部 toolCall 的累积状态', async () => {
    const message: ChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call_1', name: 'list_dir', arguments: { path: '.' } },
        { id: 'call_2', name: 'read_file', arguments: { file_path: 'a.ts' } },
      ],
    };
    const provider = new MockProvider([message]);
    const events = await collect(provider.chat(fakeParams));

    const deltas = events.filter(e => e.type === LLMEventType.ToolCallDelta);
    for (const event of deltas) {
      const data = event.data as { toolCalls: Array<{ id: string; arguments: string }> };
      expect(data.toolCalls).toHaveLength(2);
    }
    // 最终两条 arguments 均完整
    const last = (deltas[deltas.length - 1].data as { toolCalls: Array<{ id: string; arguments: string }> }).toolCalls;
    expect(JSON.parse(last[0].arguments)).toEqual({ path: '.' });
    expect(JSON.parse(last[1].arguments)).toEqual({ file_path: 'a.ts' });
  });

  it('chunkSize 自定义：控制切分块数', async () => {
    const provider = new MockProvider([textMessage('abcdef')], { chunkSize: 2 });
    const events = await collect(provider.chat(fakeParams));

    const deltas = events.filter(e => e.type === LLMEventType.TextDelta);
    expect(deltas).toHaveLength(3); // 6 字符 / 2 = 3 块
    expect(deltas.map(e => (e.data as { delta: string }).delta)).toEqual(['ab', 'cd', 'ef']);
  });

  it('chunkSize ≤ 0：归一为默认值，不产生空块或死循环', async () => {
    const provider = new MockProvider([textMessage('abcd')], { chunkSize: 0 });
    const events = await collect(provider.chat(fakeParams));

    const deltas = events.filter(e => e.type === LLMEventType.TextDelta);
    expect(deltas).toHaveLength(1); // 归一为 4 → 单块
  });

  it('delay > 0：每块之间等待，流仍完整', async () => {
    const provider = new MockProvider([textMessage('abcdef')], { chunkSize: 3, delay: 1 });
    const events = await collect(provider.chat(fakeParams));

    const deltas = events.filter(e => e.type === LLMEventType.TextDelta);
    expect(deltas).toHaveLength(2);
  });
});

describe('MockProvider 剧本消耗', () => {
  it('多条剧本按顺序消耗，每次 chat() 消耗一条', async () => {
    const provider = new MockProvider([
      toolCallMessage(),
      textMessage('第二轮回复'),
    ]);

    const first = await collect(provider.chat(fakeParams));
    expect(first.some(e => e.type === LLMEventType.ToolCallDelta)).toBe(true);

    const second = await collect(provider.chat(fakeParams));
    expect(second.some(e => e.type === LLMEventType.ToolCallDelta)).toBe(false);
    expect((second[second.length - 1].data as { message: ChatMessage }).message.content).toBe('第二轮回复');
  });

  it('calls 记录每次收到的请求参数', async () => {
    const provider = new MockProvider([textMessage('ok')]);
    await collect(provider.chat(fakeParams));

    const secondParams: ChatCompletionParams = {
      model: 'fake',
      messages: [{ role: 'user', content: '第二条' }],
    };
    await collect(provider.chat(secondParams));

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].messages[0].content).toBe('你好');
    expect(provider.calls[1].messages[0].content).toBe('第二条');
  });
});

describe('MockProvider 耗尽行为', () => {
  it('默认 error：耗尽后 yield Error 事件，说明第几次调用', async () => {
    const provider = new MockProvider([textMessage('仅一条')]);

    await collect(provider.chat(fakeParams));
    const events = await collect(provider.chat(fakeParams));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(LLMEventType.Error);
    expect((events[0].data as { message: string }).message).toContain('已耗尽');
    expect((events[0].data as { message: string }).message).toContain('2');
  });

  it('空剧本 + error：首次调用即报耗尽', async () => {
    const provider = new MockProvider([]);
    const events = await collect(provider.chat(fakeParams));

    expect(events[0].type).toBe(LLMEventType.Error);
  });

  it('loop 模式：耗尽后重复最后一条剧本（内容完整）', async () => {
    const provider = new MockProvider([textMessage('最后一条')], { onExhausted: 'loop' });

    await collect(provider.chat(fakeParams));
    const events = await collect(provider.chat(fakeParams));

    const last = events[events.length - 1];
    expect(last.type).toBe(LLMEventType.MessageComplete);
    expect((last.data as { message: ChatMessage }).message.content).toBe('最后一条');
  });

  it('空剧本 + loop：无条目可重复，仍报耗尽错误', async () => {
    const provider = new MockProvider([], { onExhausted: 'loop' });
    const events = await collect(provider.chat(fakeParams));

    expect(events[0].type).toBe(LLMEventType.Error);
  });
});

describe('MockProvider 动态剧本', () => {
  it('函数条目收到请求参数，可基于上下文生成消息', async () => {
    const seen: ChatCompletionParams[] = [];
    const provider = new MockProvider([
      (params: ChatCompletionParams) => {
        seen.push(params);
        return textMessage('动态生成');
      },
    ]);
    const events = await collect(provider.chat(fakeParams));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(fakeParams);
    expect((events[events.length - 1].data as { message: ChatMessage }).message.content).toBe('动态生成');
  });

  it('异步函数条目：Promise 返回值正常合成', async () => {
    const provider = new MockProvider([
      async () => textMessage('异步动态'),
    ]);
    const events = await collect(provider.chat(fakeParams));

    const last = events[events.length - 1];
    expect((last.data as { message: ChatMessage }).message.content).toBe('异步动态');
  });

  it('动态函数抛异常：转为 Error 事件，不中断调用方', async () => {
    const provider = new MockProvider([
      () => {
        throw new Error('剧本内部错误');
      },
    ]);
    const events = await collect(provider.chat(fakeParams));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(LLMEventType.Error);
    expect((events[0].data as { message: string }).message).toContain('剧本内部错误');
  });
});

describe('MockProvider 深拷贝隔离', () => {
  it('MessageComplete 返回深拷贝：修改返回消息不影响剧本原对象', async () => {
    const original = toolCallMessage();
    const provider = new MockProvider([original]);
    const events = await collect(provider.chat(fakeParams));

    const message = (events[events.length - 1].data as { message: ChatMessage }).message;
    message.toolCalls![0].arguments = { path: '被篡改' };

    expect(original.toolCalls![0].arguments).toEqual({ path: '.' });
  });

  it('loop 模式重复消耗：两次返回的消息不是同一引用', async () => {
    const provider = new MockProvider([textMessage('重复')], { onExhausted: 'loop' });

    const first = await collect(provider.chat(fakeParams));
    const second = await collect(provider.chat(fakeParams));

    const m1 = (first[first.length - 1].data as { message: ChatMessage }).message;
    const m2 = (second[second.length - 1].data as { message: ChatMessage }).message;
    expect(m1).not.toBe(m2);
    expect(m1).toEqual(m2);
  });
});

describe('模块级开关（类 API）', () => {
  it('setMockProvider 后 mockEnabled() 为 true，clearMockProvider 后恢复 false', () => {
    expect(mockEnabled()).toBe(false);

    setMockProvider(new MockProvider([textMessage('ok')]));
    expect(mockEnabled()).toBe(true);

    clearMockProvider();
    expect(mockEnabled()).toBe(false);
  });

  it('OpenAICompatible 委托：mock 启用时产出 mock 事件而非真实请求', async () => {
    const provider = new OpenAICompatibleProvider('fake-key', 'http://localhost:1');
    setMockProvider(new MockProvider([textMessage('来自mock')]));

    const events = await collect(provider.chat(fakeParams));

    const last = events[events.length - 1];
    expect(last.type).toBe(LLMEventType.MessageComplete);
    expect((last.data as { message: ChatMessage }).message.content).toBe('来自mock');
    expect(events.some(e => e.type === LLMEventType.Error)).toBe(false);
  });

  it('clearMockProvider 后 OpenAICompatible 恢复真实请求路径（连不上 → Error 事件）', async () => {
    const provider = new OpenAICompatibleProvider('fake-key', 'http://localhost:1');

    const events = await collect(provider.chat(fakeParams));

    // 未启用 mock 时走真实 fetch，端口不可达 → 网络错误事件
    expect(events[0].type).toBe(LLMEventType.Error);
  });
});

describe('环境变量入口（CODE_AGENT_MOCK_SCRIPT）', () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    for (const file of tmpFiles.splice(0)) {
      rmSync(file, { force: true });
    }
  });

  function writeScript(data: unknown): string {
    const file = join(tmpdir(), `mock-script-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(data));
    tmpFiles.push(file);
    return file;
  }

  it('指向合法 JSON 剧本：惰性启用并按剧本合成事件', async () => {
    process.env.CODE_AGENT_MOCK_SCRIPT = writeScript([
      textMessage('来自env剧本'),
    ]);

    expect(mockEnabled()).toBe(true);

    const provider = new OpenAICompatibleProvider('fake-key', 'http://localhost:1');
    const events = await collect(provider.chat(fakeParams));

    const last = events[events.length - 1];
    expect(last.type).toBe(LLMEventType.MessageComplete);
    expect((last.data as { message: ChatMessage }).message.content).toBe('来自env剧本');
  });

  it('指向不存在的文件：错误态单例，每次调用报错且绝不回退真实 LLM', async () => {
    process.env.CODE_AGENT_MOCK_SCRIPT = '/nonexistent/mock-script.json';

    expect(mockEnabled()).toBe(true); // 启用（错误态），不静默回退

    const provider = new OpenAICompatibleProvider('fake-key', 'http://localhost:1');
    const first = await collect(provider.chat(fakeParams));
    const second = await collect(provider.chat(fakeParams));

    expect(first[0].type).toBe(LLMEventType.Error);
    expect((first[0].data as { message: string }).message).toContain('Mock 剧本加载失败');
    expect(second[0].type).toBe(LLMEventType.Error);
  });

  it('JSON 非数组：报配置错误', async () => {
    process.env.CODE_AGENT_MOCK_SCRIPT = writeScript({ not: 'an array' });

    const provider = new OpenAICompatibleProvider('fake-key', 'http://localhost:1');
    const events = await collect(provider.chat(fakeParams));

    expect(events[0].type).toBe(LLMEventType.Error);
    expect((events[0].data as { message: string }).message).toContain('ChatMessage 数组');
  });

  it('条目缺少 role/content：报配置错误并指出条目序号', async () => {
    process.env.CODE_AGENT_MOCK_SCRIPT = writeScript([{ foo: 'bar' }]);

    const provider = new OpenAICompatibleProvider('fake-key', 'http://localhost:1');
    const events = await collect(provider.chat(fakeParams));

    expect(events[0].type).toBe(LLMEventType.Error);
    expect((events[0].data as { message: string }).message).toContain('第 1 条');
  });

  it('未设置环境变量：mock 关闭', () => {
    expect(mockEnabled()).toBe(false);
  });

  it('显式 setMockProvider 优先于环境变量', async () => {
    process.env.CODE_AGENT_MOCK_SCRIPT = writeScript([textMessage('env剧本')]);
    setMockProvider(new MockProvider([textMessage('显式剧本')]));

    const provider = new OpenAICompatibleProvider('fake-key', 'http://localhost:1');
    const events = await collect(provider.chat(fakeParams));

    const last = events[events.length - 1];
    expect((last.data as { message: ChatMessage }).message.content).toBe('显式剧本');
  });
});
