/**
 * SSE 协议解析器
 *
 * 实现 W3C EventSource 规范的解析逻辑：
 * - 处理 LF / CRLF 换行符（支持换行符跨 chunk 拆分）
 * - 注释行（: 开头）忽略
 * - 多行 data 以 \n 拼接
 * - event / id / retry 字段
 * - 空行触发事件分发；无 data 行不分发，且重置 eventType
 * - id 跨事件保留（规范要求），含 NULL 字符的 id 忽略
 *
 * 参考：https://html.spec.whatwg.org/multipage/server-sent-events.html
 */

import type { SSEEvent } from './types.js';

/** 查找行尾：返回行内容结束位置（不含换行符）；找不到返回 -1 */
function findLineEnd(s: string): number {
  const lf = s.indexOf('\n');
  if (lf === -1) return -1;
  // CRLF：行尾不含 \r
  return lf > 0 && s[lf - 1] === '\r' ? lf - 1 : lf;
}

/**
 * SSE 解析器
 *
 * 持续 push 网络字节解码后的文本，收集 push 返回的完整事件。
 * 内部维护跨 chunk 的半行缓冲与字段累积状态。
 */
export class SSEParser {
  /** 未成行的残留文本（半个事件） */
  private buffer = '';
  /** 当前累积中的事件类型 */
  private eventType = '';
  /** 当前累积中的 data 行 */
  private dataLines: string[] = [];
  /** id 按规范跨事件保留（last event ID buffer） */
  private currentId: string | undefined;
  /** 当前事件的 retry 建议值 */
  private currentRetry: number | undefined;

  /** 喂入文本片段，返回本次解析出的完整事件列表 */
  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];

    while (true) {
      const end = findLineEnd(this.buffer);
      if (end === -1) break;

      const line = this.buffer.slice(0, end);
      // 跳过换行符（\n 或 \r\n，支持换行符跨 chunk）
      this.buffer =
        this.buffer.charCodeAt(end) === 13 /* \r */
          ? this.buffer.slice(end + 2)
          : this.buffer.slice(end + 1);

      const event = this.handleLine(line);
      if (event) events.push(event);
    }

    return events;
  }

  /** 空行触发：将累积字段分发为一个完整事件 */
  private dispatch(): SSEEvent | null {
    if (this.dataLines.length === 0) {
      // 规范：无 data 不分发，但 eventType 重置
      this.eventType = '';
      return null;
    }

    const event: SSEEvent = {
      event: this.eventType || 'message',
      data: this.dataLines.join('\n'),
    };
    if (this.currentId !== undefined) event.id = this.currentId;
    if (this.currentRetry !== undefined) event.retry = this.currentRetry;

    // 重置当前事件字段（id 保留）
    this.eventType = '';
    this.dataLines = [];
    this.currentRetry = undefined;
    return event;
  }

  /** 解析单行，返回该行触发的完整事件（若有） */
  private handleLine(line: string): SSEEvent | null {
    // 空行 → 分发事件
    if (line.length === 0) return this.dispatch();
    // 注释行
    if (line.startsWith(':')) return null;

    const colonIdx = line.indexOf(':');
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
    // 规范：字段值的首个空格去除
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        this.eventType = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        // 规范：含 NULL 字符的 id 忽略
        if (!value.includes('\x00')) this.currentId = value;
        break;
      case 'retry': {
        const ms = parseInt(value, 10);
        if (!Number.isNaN(ms)) this.currentRetry = ms;
        break;
      }
      // 未知字段：按规范忽略
    }
    return null;
  }
}
