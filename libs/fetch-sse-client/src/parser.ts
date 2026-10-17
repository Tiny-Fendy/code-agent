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

import type { SSEEvent } from './types';

/** 查找行尾：返回行内容结束位置（不含换行符）；找不到返回 -1 */
function findLineEnd(s: string): number {
  const lf = s.indexOf('\n');
  if (lf === -1) return -1;
  // CRLF：行尾不含 \r
  return lf > 0 && s[lf - 1] === '\r' ? lf - 1 : lf;
}

export interface SSEParser {
  /** 喂入文本片段，返回本次解析出的完整事件列表 */
  push(chunk: string): SSEEvent[];
}

/**
 * 创建 SSE 解析器实例
 *
 * 使用方式：持续 push 网络字节解码后的文本，收集 push 返回的完整事件。
 * 解析器内部维护跨 chunk 的半行缓冲与字段累积状态。
 */
export function createSSEParser(): SSEParser {
  // 未成行的残留文本（半个事件）
  let buffer = '';
  // 当前累积中的事件字段
  let eventType = '';
  let dataLines: string[] = [];
  // id 按规范跨事件保留（last event ID buffer）
  let currentId: string | undefined;
  let currentRetry: number | undefined;

  /** 空行触发：将累积字段分发为一个完整事件 */
  function dispatch(): SSEEvent | null {
    if (dataLines.length === 0) {
      // 规范：无 data 不分发，但 eventType 重置
      eventType = '';
      return null;
    }

    const event: SSEEvent = {
      event: eventType || 'message',
      data: dataLines.join('\n'),
    };
    if (currentId !== undefined) event.id = currentId;
    if (currentRetry !== undefined) event.retry = currentRetry;

    // 重置当前事件字段（id 保留）
    eventType = '';
    dataLines = [];
    currentRetry = undefined;
    return event;
  }

  /** 解析单行，返回该行触发的完整事件（若有） */
  function handleLine(line: string): SSEEvent | null {
    // 空行 → 分发事件
    if (line.length === 0) return dispatch();
    // 注释行
    if (line.startsWith(':')) return null;

    const colonIdx = line.indexOf(':');
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
    // 规范：字段值的首个空格去除
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        eventType = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        // 规范：含 NULL 字符的 id 忽略
        if (!value.includes('\x00')) currentId = value;
        break;
      case 'retry': {
        const ms = parseInt(value, 10);
        if (!Number.isNaN(ms)) currentRetry = ms;
        break;
      }
      // 未知字段：按规范忽略
    }
    return null;
  }

  return {
    push(chunk: string): SSEEvent[] {
      buffer += chunk;
      const events: SSEEvent[] = [];

      while (true) {
        const end = findLineEnd(buffer);
        if (end === -1) break;

        const line = buffer.slice(0, end);
        // 跳过换行符（\n 或 \r\n，支持换行符跨 chunk）
        buffer = buffer.charCodeAt(end) === 13 /* \r */ ? buffer.slice(end + 2) : buffer.slice(end + 1);

        const event = handleLine(line);
        if (event) events.push(event);
      }

      return events;
    },
  };
}
