/**
 * 对话事件归并测试
 *
 * 按功能设计覆盖：7 种事件 + startTurn / finishTurn / resolveToolConfirm / markRpcFailure。
 * 每个用例从 emptyConversation() 出发，验证归并后的消息结构与状态流转。
 */

import { describe, it, expect } from 'vitest';
import {
  emptyConversation,
  startTurn,
  applyAgentEvent,
  finishTurn,
  markRpcFailure,
  resolveToolConfirm,
  type ConversationState,
  type UIMessage,
} from './index';

function lastAssistant(state: ConversationState): UIMessage {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') throw new Error('no assistant message');
  return last;
}

function textParts(msg: UIMessage): string[] {
  return msg.parts.filter((p) => p.kind === 'text').map((p) => (p.kind === 'text' ? p.text : ''));
}

function toolParts(msg: UIMessage) {
  return msg.parts.filter((p) => p.kind === 'tool_call');
}

describe('startTurn', () => {
  it('追加用户消息和一条空的 streaming 助手消息', () => {
    const s = startTurn(emptyConversation(), '你好');
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0].role).toBe('user');
    expect(s.messages[0].parts[0]).toEqual({ kind: 'text', text: '你好' });
    expect(s.messages[1].role).toBe('assistant');
    expect(s.messages[1].streaming).toBe(true);
    expect(s.messages[1].parts).toHaveLength(0);
  });
});

describe('text_delta', () => {
  it('向当前流式消息追加文本', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = applyAgentEvent(s, { type: 'text_delta', data: { delta: '你好' } });
    s = applyAgentEvent(s, { type: 'text_delta', data: { delta: '世界' } });
    const msg = lastAssistant(s);
    expect(textParts(msg)).toEqual(['你好世界']);
  });

  it('message_complete 后新 text_delta 新开一条消息', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = applyAgentEvent(s, { type: 'text_delta', data: { delta: '第一段' } });
    s = applyAgentEvent(s, {
      type: 'message_complete',
      data: { message: { role: 'assistant', content: '第一段' }, step: 1 },
    });
    s = applyAgentEvent(s, { type: 'text_delta', data: { delta: '第二段' } });
    expect(s.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });
});

describe('tool_call 生命周期', () => {
  it('tool_call_delta 新建工具调用并追加参数文本', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = applyAgentEvent(s, {
      type: 'tool_call_delta',
      data: { toolCalls: [{ id: 't1', name: 'read', arguments: '{"path":' }] },
    });
    s = applyAgentEvent(s, {
      type: 'tool_call_delta',
      data: { toolCalls: [{ id: 't1', name: 'read', arguments: '"/a.ts"}' }] },
    });
    const tool = toolParts(lastAssistant(s))[0];
    expect(tool.kind).toBe('tool_call');
    if (tool.kind === 'tool_call') {
      expect(tool.toolCall.id).toBe('t1');
      expect(tool.toolCall.argumentsText).toBe('{"path":"/a.ts"}');
      expect(tool.toolCall.status).toBe('running');
    }
  });

  it('tool_call_start 以完整对象覆盖参数文本', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = applyAgentEvent(s, {
      type: 'tool_call_delta',
      data: { toolCalls: [{ id: 't1', name: 'read', arguments: 'partial' }] },
    });
    s = applyAgentEvent(s, {
      type: 'tool_call_start',
      data: { toolCallId: 't1', toolName: 'read', arguments: { path: '/a.ts' } },
    });
    const tool = toolParts(lastAssistant(s))[0];
    if (tool.kind === 'tool_call') {
      expect(tool.toolCall.argumentsText).toBe(JSON.stringify({ path: '/a.ts' }, null, 2));
    }
  });

  it('tool_call_confirm 标记 awaiting_confirm 并写入 pendingConfirmId', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = applyAgentEvent(s, {
      type: 'tool_call_start',
      data: { toolCallId: 't1', toolName: 'read', arguments: {} },
    });
    s = applyAgentEvent(s, {
      type: 'tool_call_confirm',
      data: { toolCallId: 't1', toolName: 'read', arguments: {} },
    });
    const tool = toolParts(lastAssistant(s))[0];
    if (tool.kind === 'tool_call') {
      expect(tool.toolCall.status).toBe('awaiting_confirm');
    }
    expect(s.pendingConfirmId).toBe('t1');
  });

  it('tool_call_result 按 success 标记终态', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = applyAgentEvent(s, {
      type: 'tool_call_start',
      data: { toolCallId: 't1', toolName: 'read', arguments: {} },
    });
    s = applyAgentEvent(s, {
      type: 'tool_call_result',
      data: { toolCallId: 't1', toolName: 'read', result: { success: true, content: 'ok' } },
    });
    let tool = toolParts(lastAssistant(s))[0];
    if (tool.kind === 'tool_call') {
      expect(tool.toolCall.status).toBe('success');
      expect(tool.toolCall.result?.content).toBe('ok');
    }

    // 失败场景
    s = startTurn(emptyConversation(), 'hi');
    s = applyAgentEvent(s, {
      type: 'tool_call_start',
      data: { toolCallId: 't2', toolName: 'write', arguments: {} },
    });
    s = applyAgentEvent(s, {
      type: 'tool_call_result',
      data: { toolCallId: 't2', toolName: 'write', result: { success: false, content: '', error: 'denied' } },
    });
    tool = toolParts(lastAssistant(s))[0];
    if (tool.kind === 'tool_call') {
      expect(tool.toolCall.status).toBe('failed');
    }
  });

  it('denied 状态不被迟到的 tool_call_result 覆盖', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = applyAgentEvent(s, {
      type: 'tool_call_confirm',
      data: { toolCallId: 't1', toolName: 'read', arguments: {} },
    });
    s = resolveToolConfirm(s, 't1', false);
    s = applyAgentEvent(s, {
      type: 'tool_call_result',
      data: { toolCallId: 't1', toolName: 'read', result: { success: false, content: '', error: 'user denied' } },
    });
    const tool = toolParts(lastAssistant(s))[0];
    if (tool.kind === 'tool_call') {
      expect(tool.toolCall.status).toBe('denied');
    }
  });
});

describe('message_complete', () => {
  it('收口当前流式消息', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = applyAgentEvent(s, { type: 'text_delta', data: { delta: 'hi' } });
    s = applyAgentEvent(s, {
      type: 'message_complete',
      data: { message: { role: 'assistant', content: 'hi' }, step: 1 },
    });
    expect(lastAssistant(s).streaming).toBe(false);
  });
});

describe('context_compact', () => {
  it('显式忽略，不抛异常', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = applyAgentEvent(s, { type: 'context_compact', data: { before: 100, after: 50 } });
    expect(s.messages).toHaveLength(2);
  });
});

describe('finishTurn', () => {
  it('completed 终局：消息收口无错误', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = applyAgentEvent(s, { type: 'text_delta', data: { delta: 'ok' } });
    s = finishTurn(s, { status: 'completed', steps: 1 });
    const msg = lastAssistant(s);
    expect(msg.streaming).toBe(false);
    expect(msg.error).toBeUndefined();
  });

  it('llmFailed 终局：消息挂错误', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = finishTurn(s, { status: 'llmFailed', message: '上游错误' });
    expect(lastAssistant(s).error).toEqual({ kind: 'llm_failed', message: '上游错误' });
  });

  it('maxSteps 终局：消息挂错误', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = finishTurn(s, { status: 'maxSteps', steps: 10 });
    expect(lastAssistant(s).error).toEqual({ kind: 'max_steps' });
  });

  it('aborted 终局：消息挂 aborted 错误', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = finishTurn(s, { status: 'aborted' });
    expect(lastAssistant(s).error).toEqual({ kind: 'aborted' });
  });
});

describe('markRpcFailure', () => {
  it('RPC 层失败挂到消息上', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = markRpcFailure(s, '网络断开');
    expect(lastAssistant(s).error).toEqual({ kind: 'rpc_failed', message: '网络断开' });
  });
});

describe('resolveToolConfirm', () => {
  it('放行回到 running，拒绝标记 denied', () => {
    let s = startTurn(emptyConversation(), 'hi');
    s = applyAgentEvent(s, {
      type: 'tool_call_confirm',
      data: { toolCallId: 't1', toolName: 'read', arguments: {} },
    });

    const allowed = resolveToolConfirm(s, 't1', true);
    const tool = toolParts(lastAssistant(allowed))[0];
    if (tool.kind === 'tool_call') {
      expect(tool.toolCall.status).toBe('running');
    }

    const denied = resolveToolConfirm(s, 't1', false);
    const tool2 = toolParts(lastAssistant(denied))[0];
    if (tool2.kind === 'tool_call') {
      expect(tool2.toolCall.status).toBe('denied');
    }
  });
});
