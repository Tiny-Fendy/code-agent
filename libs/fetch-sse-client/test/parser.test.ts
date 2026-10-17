import { describe, it, expect } from 'vitest';
import { createSSEParser } from '@/parser';

describe('createSSEParser', () => {
  it('解析单行 data 事件，默认 message 类型', () => {
    const parser = createSSEParser();
    expect(parser.push('data: hello\n\n')).toEqual([
      { event: 'message', data: 'hello' },
    ]);
  });

  it('解析自定义 event 类型', () => {
    const parser = createSSEParser();
    expect(parser.push('event: foo\ndata: bar\n\n')).toEqual([
      { event: 'foo', data: 'bar' },
    ]);
  });

  it('多行 data 以 \\n 拼接', () => {
    const parser = createSSEParser();
    expect(parser.push('data: line1\ndata: line2\n\n')).toEqual([
      { event: 'message', data: 'line1\nline2' },
    ]);
  });

  it('携带 id 与 retry 字段', () => {
    const parser = createSSEParser();
    expect(parser.push('id: 42\nretry: 5000\ndata: x\n\n')).toEqual([
      { event: 'message', data: 'x', id: '42', retry: 5000 },
    ]);
  });

  it('忽略注释行', () => {
    const parser = createSSEParser();
    expect(parser.push(': keep-alive\ndata: x\n\n')).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  it('处理 CRLF 换行', () => {
    const parser = createSSEParser();
    expect(parser.push('data: a\r\n\r\ndata: b\r\n\r\n')).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
  });

  it('跨 chunk 拆包：半个事件分两次到达', () => {
    const parser = createSSEParser();
    expect(parser.push('data: hel')).toEqual([]);
    expect(parser.push('lo\n\n')).toEqual([
      { event: 'message', data: 'hello' },
    ]);
  });

  it('CRLF 换行符跨 chunk 拆分', () => {
    const parser = createSSEParser();
    // \r 先到，\n 未到：不成行
    expect(parser.push('data: a\r')).toEqual([]);
    // \n 到达后成行，再以空行触发分发
    expect(parser.push('\n\n')).toEqual([
      { event: 'message', data: 'a' },
    ]);
  });

  it('单个 CRLF 分隔的多行 data 拼接为一个事件', () => {
    const parser = createSSEParser();
    // a 与 b 之间是完整 CRLF，属于同一事件的多行 data
    expect(parser.push('data: a\r\ndata: b\r\n\r\n')).toEqual([
      { event: 'message', data: 'a\nb' },
    ]);
  });

  it('单个 chunk 包含多个事件', () => {
    const parser = createSSEParser();
    expect(parser.push('data: a\n\ndata: b\n\n')).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
  });

  it('无 data 行的空行不分发事件，且重置 eventType', () => {
    const parser = createSSEParser();
    expect(parser.push('event: foo\n\n')).toEqual([]);
    // eventType 已被重置，不应残留 foo
    expect(parser.push('data: x\n\n')).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  it('去掉字段值的首个空格，保留后续空格', () => {
    const parser = createSSEParser();
    expect(parser.push('data:  a  b\n\n')).toEqual([
      { event: 'message', data: ' a  b' },
    ]);
  });

  it('无冒号行视为空值字段', () => {
    const parser = createSSEParser();
    expect(parser.push('data\n\n')).toEqual([
      { event: 'message', data: '' },
    ]);
  });

  it('忽略未知字段', () => {
    const parser = createSSEParser();
    expect(parser.push('unknown: v\ndata: x\n\n')).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  it('包含 NULL 字符的 id 被忽略', () => {
    const parser = createSSEParser();
    expect(parser.push('id: a\x00b\ndata: x\n\n')).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  it('非法 retry 值被忽略', () => {
    const parser = createSSEParser();
    expect(parser.push('retry: abc\ndata: x\n\n')).toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  it('id 跨事件保留（W3C last event ID buffer）', () => {
    const parser = createSSEParser();
    expect(parser.push('id: 1\ndata: a\n\n')).toEqual([
      { event: 'message', data: 'a', id: '1' },
    ]);
    // 后续未携带 id 的事件沿用最近一次的 id
    expect(parser.push('data: b\n\n')).toEqual([
      { event: 'message', data: 'b', id: '1' },
    ]);
  });
});
