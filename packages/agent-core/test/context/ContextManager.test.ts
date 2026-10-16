import { describe, it, expect } from 'vitest';
import { ContextManager } from '../../src/context/ContextManager';
import type { ChatMessage } from '@code-agent/shared';

function countOf(messages: ChatMessage[]): number {
  const cm = new ContextManager();
  for (const m of messages) cm.addMessage(m);
  return cm.getTokenCount();
}

function noOrphanTools(messages: ChatMessage[]): boolean {
  for (let idx = 0; idx < messages.length; idx++) {
    const m = messages[idx];
    if (m.role === 'tool') {
      const parent = messages
        .slice(0, idx)
        .reverse()
        .find(p => p.role === 'assistant' && p.toolCalls?.some(tc => tc.id === m.toolCallId));
      if (!parent) return false;
    }
  }
  return true;
}

describe('ContextManager token 估算', () => {
  it('纯中文 3000 字 ≈ 2000 token', () => {
    const n = countOf([{ role: 'user', content: '中'.repeat(3000) }]);
    expect(n).toBe(2000);
    expect(n).toBeGreaterThan(1000);
  });

  it('纯英文 4000 字符 ≈ 1000 token', () => {
    expect(countOf([{ role: 'user', content: 'a'.repeat(4000) }])).toBe(1000);
  });

  it('混合内容 → 1500', () => {
    const content = '中'.repeat(1500) + 'a'.repeat(2000);
    expect(countOf([{ role: 'user', content }])).toBe(1500);
  });

  it('toolCalls 计入（name + JSON arguments）', () => {
    const args = { command: `echo ${'x'.repeat(600)}` };
    const argsJson = JSON.stringify(args);
    const n = countOf([{
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'run_command', arguments: args }],
    }]);
    const expected = Math.ceil('run_command'.length / 4) + Math.ceil(argsJson.length / 4);
    expect(n).toBe(expected);
  });

  it('空消息列表 → 0', () => expect(countOf([])).toBe(0));
  it('空 content → 0', () => expect(countOf([{ role: 'user', content: '' }])).toBe(0));

  it('多消息累加 → 600', () => {
    const n = countOf([
      { role: 'user', content: 'a'.repeat(2000) },
      { role: 'assistant', content: '中'.repeat(150) },
    ]);
    expect(n).toBe(600);
  });
});

describe('ContextManager tool 结果入口截断', () => {
  it('恰好等于上限不截断', () => {
    const cm = new ContextManager();
    cm.addMessage({ role: 'tool', content: 'x'.repeat(4000), toolCallId: 't1', name: 'run_command' });
    expect(cm.getLastMessage()!.content).toBe('x'.repeat(4000));
  });

  it('未超限原样保留', () => {
    const cm = new ContextManager();
    cm.addMessage({ role: 'tool', content: 'x'.repeat(3000), toolCallId: 't1', name: 'run_command' });
    expect(cm.getLastMessage()!.content).toBe('x'.repeat(3000));
  });

  it('超限截断：头 2/3 + 尾 1/3 + 提示', () => {
    const original = 'A'.repeat(5000) + 'B'.repeat(5000);
    const cm = new ContextManager();
    cm.addMessage({ role: 'tool', content: original, toolCallId: 't1', name: 'run_command' });
    const stored = cm.getLastMessage()!.content;
    const headLen = Math.floor(4000 * 2 / 3);
    const tailLen = 4000 - headLen;
    const removed = 10000 - headLen - tailLen;
    const marker = `...[已截断 ${removed} 字符]...`;
    expect(stored.startsWith('A'.repeat(headLen))).toBe(true);
    expect(stored.endsWith('B'.repeat(tailLen))).toBe(true);
    expect(stored).toContain(marker);
    expect(stored.length).toBeLessThanOrEqual(4000 + marker.length + 2);
  });

  it('user 消息超限也不截断', () => {
    const cm = new ContextManager();
    cm.addMessage({ role: 'user', content: 'x'.repeat(10000) });
    expect(cm.getLastMessage()!.content).toBe('x'.repeat(10000));
  });

  it('自定义上限生效', () => {
    const cm = new ContextManager(8000, 100);
    cm.addMessage({ role: 'tool', content: 'y'.repeat(150), toolCallId: 't1', name: 'run_command' });
    const stored = cm.getLastMessage()!.content;
    expect(stored.length).toBeLessThan(150);
    expect(stored).toContain('已截断');
  });

  it('截断不修改调用方原对象', () => {
    const original = { role: 'tool' as const, content: 'x'.repeat(10000), toolCallId: 't1', name: 't' };
    const cm = new ContextManager();
    cm.addMessage(original);
    expect(original.content.length).toBe(10000);
  });
});

describe('ContextManager shouldCompact', () => {
  it('等于阈值（80%）不触发', () => {
    const cm = new ContextManager(1000);
    cm.addMessage({ role: 'user', content: 'a'.repeat(3200) });
    expect(cm.shouldCompact()).toBe(false);
  });

  it('超过阈值触发', () => {
    const cm = new ContextManager(1000);
    cm.addMessage({ role: 'user', content: 'a'.repeat(3200) });
    cm.addMessage({ role: 'assistant', content: 'a'.repeat(400) });
    expect(cm.shouldCompact()).toBe(true);
  });
});

describe('ContextManager getCompactableRange', () => {
  it('切点基础场景：落在 user/assistant 上', () => {
    const cm = new ContextManager(100);
    cm.addMessage({ role: 'system', content: 'sys' });
    cm.addMessage({ role: 'user', content: 'u'.repeat(10) });
    cm.addMessage({ role: 'assistant', content: 'a'.repeat(10) });
    cm.addMessage({ role: 'user', content: 'U'.repeat(50) });
    cm.addMessage({ role: 'assistant', content: 'A'.repeat(50) });
    const range = cm.getCompactableRange();
    expect(range).toHaveLength(3);
    expect(range.map(m => m.role).join(',')).toBe('user,assistant,user');
    expect(range.some(m => m.content === 'A'.repeat(50))).toBe(false);
  });

  it('切点回溯：落在 tool 上时回溯到 assistant 父消息', () => {
    const cm = new ContextManager(100);
    cm.addMessage({ role: 'system', content: 'sys' });
    cm.addMessage({ role: 'user', content: 'u'.repeat(10) });
    cm.addMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'run_command', arguments: { command: 'x'.repeat(80) } }],
    });
    cm.addMessage({ role: 'tool', content: 'r'.repeat(30), toolCallId: 'c1', name: 'run_command' });
    cm.addMessage({ role: 'assistant', content: 'a'.repeat(40) });
    const range = cm.getCompactableRange();
    expect(range).toHaveLength(1);
    expect(range[0].role).toBe('user');
    expect(range.some(m => m.role === 'tool')).toBe(false);
    expect(noOrphanTools(cm.getMessages())).toBe(true);
  });

  it('平行工具调用组：回溯不拆散一组消息', () => {
    const cm = new ContextManager(100);
    cm.addMessage({ role: 'system', content: 'sys' });
    cm.addMessage({ role: 'user', content: 'u'.repeat(10) });
    cm.addMessage({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'c1', name: 'run_command', arguments: { command: 'x'.repeat(60) } },
        { id: 'c2', name: 'run_command', arguments: { command: 'x'.repeat(60) } },
      ],
    });
    cm.addMessage({ role: 'tool', content: 'r'.repeat(30), toolCallId: 'c1', name: 'run_command' });
    cm.addMessage({ role: 'tool', content: 'r'.repeat(30), toolCallId: 'c2', name: 'run_command' });
    cm.addMessage({ role: 'assistant', content: 'a'.repeat(40) });
    const range = cm.getCompactableRange();
    expect(range).toHaveLength(1);
    expect(range[0].role).toBe('user');
    const msgs = cm.getMessages();
    cm.compact('摘要');
    const after = cm.getMessages();
    expect(after[2].role).toBe('assistant');
    expect(after[2].toolCalls?.map((t) => t.id).join(',')).toBe('c1,c2');
    expect(after[3]?.toolCallId).toBe('c1');
    expect(after[4]?.toolCallId).toBe('c2');
    expect(noOrphanTools(after)).toBe(true);
    expect(msgs).toHaveLength(6);
  });

  it('多条前导 system 消息：摘要区从最后一条 system 之后开始', () => {
    const cmBig = new ContextManager(1000);
    cmBig.addMessage({ role: 'system', content: 's1' });
    cmBig.addMessage({ role: 'system', content: 's2' });
    cmBig.addMessage({ role: 'user', content: 'hello' });
    cmBig.addMessage({ role: 'assistant', content: 'hi' });
    expect(cmBig.getCompactableRange()).toHaveLength(0);
    cmBig.compact('不应生效');
    expect(cmBig.getMessageCount()).toBe(4);

    const cm = new ContextManager(100);
    cm.addMessage({ role: 'system', content: 's1' });
    cm.addMessage({ role: 'system', content: 's2' });
    cm.addMessage({ role: 'user', content: 'u'.repeat(200) });
    cm.addMessage({ role: 'assistant', content: 'a'.repeat(40) });
    const range = cm.getCompactableRange();
    expect(range).toHaveLength(1);
    expect(range[0].content).toBe('u'.repeat(200));
    cm.compact('多 system 场景摘要');
    const msgs = cm.getMessages();
    expect(msgs[0].content).toBe('s1');
    expect(msgs[1].content).toBe('s2');
    expect(msgs[2].content).toContain('[历史摘要]');
  });

  it('返回副本不影响内部状态', () => {
    const cm = new ContextManager(100);
    cm.addMessage({ role: 'system', content: 'sys' });
    cm.addMessage({ role: 'user', content: 'u'.repeat(10) });
    cm.addMessage({ role: 'assistant', content: 'a'.repeat(10) });
    const range = cm.getCompactableRange();
    range.push({ role: 'user', content: 'injected' });
    expect(cm.getMessageCount()).toBe(3);
  });
});

describe('ContextManager compact', () => {
  it('compact 后形态正确 + token 下降 + system 保留', () => {
    const cm = new ContextManager(100);
    cm.addMessage({ role: 'system', content: 'sys' });
    cm.addMessage({ role: 'user', content: 'u'.repeat(200) });
    cm.addMessage({ role: 'assistant', content: 'a'.repeat(200) });
    cm.addMessage({ role: 'user', content: 'u'.repeat(10) });
    cm.addMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'run_command', arguments: { command: 'x'.repeat(80) } }],
    });
    cm.addMessage({ role: 'tool', content: 'r'.repeat(30), toolCallId: 'c1', name: 'run_command' });
    cm.addMessage({ role: 'assistant', content: 'a'.repeat(40) });

    const before = cm.getTokenCount();
    cm.compact('已完成命令调用测试，结果正常');
    const after = cm.getTokenCount();

    const msgs = cm.getMessages();
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toBe('sys');
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('[历史摘要]');
    expect(msgs).toHaveLength(5);
    expect(msgs[2].role).toBe('assistant');
    expect(msgs[2].toolCalls).toBeTruthy();
    expect(msgs[3].role).toBe('tool');
    expect(msgs[3].toolCallId).toBe('c1');
    expect(after).toBeLessThan(before);
    expect(noOrphanTools(msgs)).toBe(true);
  });

  it('无可压缩区域时 compact 不生效', () => {
    const cm = new ContextManager(1000);
    cm.addMessage({ role: 'system', content: 'sys' });
    cm.addMessage({ role: 'user', content: 'hello' });
    cm.compact('不应生效');
    expect(cm.getMessageCount()).toBe(2);
  });
});

describe('ContextManager estimateAfterCompact / getCompactThreshold', () => {
  it('阈值 = maxTokens × 0.8，预估值与实际压缩后一致', () => {
    const cm = new ContextManager(100);
    cm.addMessage({ role: 'system', content: 'sys' });
    cm.addMessage({ role: 'user', content: 'u'.repeat(200) });
    cm.addMessage({ role: 'assistant', content: 'a'.repeat(200) });
    cm.addMessage({ role: 'user', content: 'u'.repeat(10) });
    cm.addMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'run_command', arguments: { command: 'x'.repeat(80) } }],
    });
    cm.addMessage({ role: 'tool', content: 'r'.repeat(30), toolCallId: 'c1', name: 'run_command' });
    cm.addMessage({ role: 'assistant', content: 'a'.repeat(40) });

    expect(cm.getCompactThreshold()).toBe(80);
    const estimated = cm.estimateAfterCompact('测试摘要');
    cm.compact('测试摘要');
    expect(cm.getTokenCount()).toBe(estimated);
  });
});

describe('ContextManager 连续 compact', () => {
  it('二次压缩时旧摘要作为普通历史被再次压缩', () => {
    const cm = new ContextManager(200);
    cm.addMessage({ role: 'system', content: 'sys' });
    cm.addMessage({ role: 'user', content: 'u'.repeat(400) });
    cm.addMessage({ role: 'assistant', content: 'a'.repeat(400) });
    cm.addMessage({ role: 'user', content: 'u'.repeat(200) });
    cm.addMessage({ role: 'assistant', content: 'a'.repeat(100) });
    expect(cm.shouldCompact()).toBe(true);

    cm.compact('第一轮摘要');
    expect(cm.shouldCompact()).toBe(false);

    const before2 = cm.getTokenCount();
    cm.addMessage({ role: 'user', content: 'u'.repeat(800) });
    expect(cm.shouldCompact()).toBe(true);

    cm.compact('第二轮摘要');
    const msgs = cm.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toContain('[历史摘要]');
    expect(msgs[1].content).toContain('第二轮摘要');
    expect(cm.getTokenCount()).toBeLessThan(before2);
    expect(noOrphanTools(msgs)).toBe(true);
  });
});
