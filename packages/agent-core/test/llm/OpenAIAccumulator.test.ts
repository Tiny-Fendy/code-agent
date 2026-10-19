/**
 * OpenAIAccumulator 单元测试
 *
 * 覆盖：content 累积、tool_calls 按 index 归位（乱序/跳 index）、
 * id/name 后到补齐、arguments 逐段拼接、部分 toolCalls 快照、
 * buildMessage 三种形态（纯 content / content+toolCalls / 仅 toolCalls）、
 * 非法 JSON 的 _raw fallback、无 name 不完整项过滤、hasContent 判定。
 * 与源文件一一对应：src/llm/OpenAIAccumulator.ts → test/llm/OpenAIAccumulator.test.ts
 */

import { describe, it, expect } from 'vitest';
import { OpenAIAccumulator } from '../../src/llm/OpenAIAccumulator';
import type { OpenAIStreamToolCall } from '../../src/llm/openai-types';

/** 便捷构造 tool_call 增量片段 */
const tcDelta = (
  index: number,
  fields: {
    id?: string;
    name?: string;
    arguments?: string;
  },
): OpenAIStreamToolCall => ({
  index,
  ...(fields.id !== undefined ? { id: fields.id } : {}),
  ...(fields.name !== undefined || fields.arguments !== undefined
    ? { function: { ...(fields.name !== undefined ? { name: fields.name } : {}), ...(fields.arguments !== undefined ? { arguments: fields.arguments } : {}) } }
    : {}),
});

describe('pushContent：content 累积', () => {
  it('逐段累积并返回非空增量本身', () => {
    const acc = new OpenAIAccumulator();

    expect(acc.pushContent('你')).toBe('你');
    expect(acc.pushContent('好')).toBe('好');

    expect(acc.buildMessage().content).toBe('你好');
  });

  it('空字符串、null 与 undefined 增量返回 null，不影响累积', () => {
    const acc = new OpenAIAccumulator();
    acc.pushContent('abc');

    expect(acc.pushContent('')).toBeNull();
    expect(acc.pushContent(null)).toBeNull();
    expect(acc.pushContent(undefined)).toBeNull();
    expect(acc.buildMessage().content).toBe('abc');
  });
});

describe('pushToolCalls：按 index 归位与增量拼接', () => {
  it('同 index 的 id/name 首片段就位、arguments 逐段拼接', () => {
    const acc = new OpenAIAccumulator();

    // 首片段：id + name + arguments 第一段
    acc.pushToolCalls([
      tcDelta(0, { id: 'call_1', name: 'read_file', arguments: '{"path"' }),
    ]);
    // 后续片段：仅 arguments
    acc.pushToolCalls([tcDelta(0, { arguments: ':"/a.txt"}' })]);

    // 空 arguments 的增量片段不影响累积，仍返回累积快照
    const partial = acc.pushToolCalls([tcDelta(0, { arguments: '' })]);
    expect(partial).toEqual([
      { id: 'call_1', name: 'read_file', arguments: '{"path":"/a.txt"}' },
    ]);

    const msg = acc.buildMessage();
    expect(msg.toolCalls).toEqual([
      { id: 'call_1', name: 'read_file', arguments: { path: '/a.txt' } },
    ]);
  });

  it('乱序到达：index 1 先于 index 0，各自归位互不干扰', () => {
    const acc = new OpenAIAccumulator();

    acc.pushToolCalls([
      tcDelta(1, { id: 'call_b', name: 'write_file', arguments: '{"x":1}' }),
    ]);
    acc.pushToolCalls([
      tcDelta(0, { id: 'call_a', name: 'read_file', arguments: '{"p":2}' }),
    ]);

    const msg = acc.buildMessage();
    expect(msg.toolCalls).toEqual([
      { id: 'call_a', name: 'read_file', arguments: { p: 2 } },
      { id: 'call_b', name: 'write_file', arguments: { x: 1 } },
    ]);
  });

  it('跳 index：index 0 与 index 2 之间自动补占位', () => {
    const acc = new OpenAIAccumulator();

    acc.pushToolCalls([tcDelta(0, { id: 'call_0', name: 'a', arguments: '{}' })]);
    acc.pushToolCalls([tcDelta(2, { id: 'call_2', name: 'c', arguments: '{}' })]);

    const msg = acc.buildMessage();
    // 中间占位项无 name 被过滤，只保留有效项
    expect(msg.toolCalls).toEqual([
      { id: 'call_0', name: 'a', arguments: {} },
      { id: 'call_2', name: 'c', arguments: {} },
    ]);
  });

  it('id/name 后到补齐：占位条目后续片段到达时字段被填充', () => {
    const acc = new OpenAIAccumulator();

    // 首片段仅 arguments（某些 provider 行为）
    acc.pushToolCalls([tcDelta(0, { arguments: '{"a":1}' })]);
    // id/name 后到
    acc.pushToolCalls([tcDelta(0, { id: 'call_late', name: 'late_tool' })]);

    const msg = acc.buildMessage();
    expect(msg.toolCalls).toEqual([
      { id: 'call_late', name: 'late_tool', arguments: { a: 1 } },
    ]);
  });

  it('返回部分 toolCalls：arguments 为累积中的原始字符串（可能不完整）', () => {
    const acc = new OpenAIAccumulator();

    const first = acc.pushToolCalls([
      tcDelta(0, { id: 'call_1', name: 'read_file', arguments: '{"pa' }),
    ]);
    expect(first).toEqual([
      { id: 'call_1', name: 'read_file', arguments: '{"pa' },
    ]);

    const second = acc.pushToolCalls([tcDelta(0, { arguments: 'th":"."}' })]);
    expect(second).toEqual([
      { id: 'call_1', name: 'read_file', arguments: '{"path":"."}' },
    ]);
  });

  it('同一次调用携带多个 index 的增量片段', () => {
    const acc = new OpenAIAccumulator();

    const partial = acc.pushToolCalls([
      tcDelta(0, { id: 'call_a', name: 'tool_a', arguments: '{' }),
      tcDelta(1, { id: 'call_b', name: 'tool_b', arguments: '{"k"' }),
    ]);
    expect(partial).toEqual([
      { id: 'call_a', name: 'tool_a', arguments: '{' },
      { id: 'call_b', name: 'tool_b', arguments: '{"k"' },
    ]);
  });

  it('undefined 与空数组增量返回 null', () => {
    const acc = new OpenAIAccumulator();

    expect(acc.pushToolCalls(undefined)).toBeNull();
    expect(acc.pushToolCalls([])).toBeNull();
    expect(acc.hasContent()).toBe(false);
  });
});

describe('buildMessage：完整消息构建', () => {
  it('纯 content：无 toolCalls 字段', () => {
    const acc = new OpenAIAccumulator();
    acc.pushContent('你好');
    acc.pushContent('世界');

    const msg = acc.buildMessage();
    expect(msg).toEqual({ role: 'assistant', content: '你好世界' });
    expect(msg.toolCalls).toBeUndefined();
  });

  it('content 与 toolCalls 并存', () => {
    const acc = new OpenAIAccumulator();
    acc.pushContent('查一下');
    acc.pushToolCalls([tcDelta(0, { id: 'call_1', name: 'list_dir', arguments: '{"path":"."}' })]);

    const msg = acc.buildMessage();
    expect(msg.content).toBe('查一下');
    expect(msg.toolCalls).toEqual([
      { id: 'call_1', name: 'list_dir', arguments: { path: '.' } },
    ]);
  });

  it('仅 toolCalls：content 为空字符串', () => {
    const acc = new OpenAIAccumulator();
    acc.pushToolCalls([tcDelta(0, { id: 'call_1', name: 'list_dir', arguments: '{"path":"."}' })]);

    const msg = acc.buildMessage();
    expect(msg.content).toBe('');
    expect(msg.toolCalls).toEqual([
      { id: 'call_1', name: 'list_dir', arguments: { path: '.' } },
    ]);
  });

  it('arguments 非法 JSON：保留 { _raw } 原始字符串 fallback', () => {
    const acc = new OpenAIAccumulator();
    acc.pushToolCalls([tcDelta(0, { id: 'call_1', name: 'broken', arguments: '{"path": oops' })]);

    const msg = acc.buildMessage();
    expect(msg.toolCalls).toEqual([
      { id: 'call_1', name: 'broken', arguments: { _raw: '{"path": oops' } },
    ]);
  });

  it('arguments 为空字符串：解析为空对象（非 _raw）', () => {
    const acc = new OpenAIAccumulator();
    acc.pushToolCalls([tcDelta(0, { id: 'call_1', name: 'no_args', arguments: '' })]);

    const msg = acc.buildMessage();
    expect(msg.toolCalls).toEqual([
      { id: 'call_1', name: 'no_args', arguments: {} },
    ]);
  });

  it('无 name 的不完整项被过滤', () => {
    const acc = new OpenAIAccumulator();
    // 收到了 index 0 的 arguments 但 name/id 均未就位
    acc.pushToolCalls([tcDelta(0, { arguments: '{"x":1}' })]);

    const msg = acc.buildMessage();
    expect(msg.toolCalls).toEqual([]);
    expect(msg.content).toBe('');
  });
});

describe('hasContent：累积判定', () => {
  it('初始为 false；content 累积后为 true', () => {
    const acc = new OpenAIAccumulator();
    expect(acc.hasContent()).toBe(false);

    acc.pushContent('hi');
    expect(acc.hasContent()).toBe(true);
  });

  it('仅 toolCall 增量（无 content）也为 true', () => {
    const acc = new OpenAIAccumulator();
    acc.pushToolCalls([tcDelta(0, { id: 'call_1', name: 't', arguments: '{}' })]);
    expect(acc.hasContent()).toBe(true);
  });

  it('空 content 增量（返回 null 的调用）不改变判定', () => {
    const acc = new OpenAIAccumulator();
    acc.pushContent('');
    acc.pushContent(undefined);
    expect(acc.hasContent()).toBe(false);
  });
});
