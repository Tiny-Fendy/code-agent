/**
 * useChatStream：把 chatStore 与 RPC 流订阅接线的副作用 hook
 *
 * 职责：
 * 1. 提供 send(text)：建立流、订阅事件、把事件喂给 chatStore
 * 2. 提供 stop()：abort 当前流
 * 3. 提供 confirmTool(ok)：决议挂起的工具确认
 * 4. 提供 retry()：重发上一条用户消息（需调用方保证当前无流式中）
 *
 * 为什么单独抽 hook：流订阅是副作用，组件只关心「发送/停止/确认/重试」四个动作。
 *
 * 为什么流句柄放模块级而非 useRef：ChatInput / MessageItem / ToolCallCard 都会调用本 hook，
 * 若各自持有 ref，「发送方」与「点击停止的组件」不是同一实例时 stop() 会失效。
 * 同一时刻全局只有一条在途流，模块级单例既正确又省去跨组件传递。
 */

import { useCallback } from 'react';
import { useChatStore } from '@/presentation/store/chatStore';
import { rpc } from '@/infrastructure/bridge';
import type { RpcStreamHandle } from '@code-agent/rpc/protocol';
import type { AgentEvent, SendResult } from '@code-agent/contracts';

/** 全局唯一在途流句柄（同一时刻至多一条） */
let activeStream: RpcStreamHandle<AgentEvent, SendResult> | null = null;

export function useChatStream() {
  const beginTurn = useChatStore((s) => s.beginTurn);
  const ingestEvent = useChatStore((s) => s.ingestEvent);
  const endTurn = useChatStore((s) => s.endTurn);
  const failTurn = useChatStore((s) => s.failTurn);
  const resolvePendingConfirm = useChatStore((s) => s.resolvePendingConfirm);
  const status = useChatStore((s) => s.status);
  const messages = useChatStore((s) => s.messages);

  /** 当前是否正在流式中（含 awaiting_confirm） */
  const isStreaming = status === 'streaming' || status === 'awaiting_confirm';

  /** 停止当前流：统一终局由 onEnd(aborted) 收口，这里不直接改 store */
  const stop = useCallback(() => {
    activeStream?.abort();
  }, []);

  /** 发送一条消息 */
  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      // 用 store 实时值判断，避免闭包里的 isStreaming 过期
      const { status: current } = useChatStore.getState();
      if (!trimmed || current !== 'idle') return;

      beginTurn(trimmed);

      const stream = rpc.chat.send(trimmed);
      activeStream = stream;

      stream.on('text_delta', (data) => ingestEvent({ type: 'text_delta', data }));
      stream.on('tool_call_delta', (data) => ingestEvent({ type: 'tool_call_delta', data }));
      stream.on('tool_call_start', (data) => ingestEvent({ type: 'tool_call_start', data }));
      stream.on('tool_call_confirm', (data) => ingestEvent({ type: 'tool_call_confirm', data }));
      stream.on('tool_call_result', (data) => ingestEvent({ type: 'tool_call_result', data }));
      stream.on('message_complete', (data) => ingestEvent({ type: 'message_complete', data }));
      stream.on('context_compact', (data) => ingestEvent({ type: 'context_compact', data }));

      stream.onEnd((end) => {
        if (activeStream === stream) activeStream = null;

        if (end.status === 'aborted') {
          endTurn({ status: 'aborted' });
          return;
        }
        if (end.status === 'failed') {
          failTurn(end.error.message);
          return;
        }
        endTurn(end.result);
      });
    },
    [beginTurn, ingestEvent, endTurn, failTurn],
  );

  /** 决议挂起的工具确认 */
  const confirmTool = useCallback(
    (ok: boolean) => {
      // 先捕获 id：resolvePendingConfirm 会同步清空 pendingConfirmId
      const toolCallId = useChatStore.getState().pendingConfirmId;
      if (!toolCallId) return;
      resolvePendingConfirm(ok);
      rpc.chat.confirmTool(toolCallId, ok).catch((err: unknown) => {
        console.error('confirmTool 失败', err);
      });
    },
    [resolvePendingConfirm],
  );

  /** 重试：重发最后一条用户消息 */
  const retry = useCallback(() => {
    if (useChatStore.getState().status !== 'idle') return;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;
      const text = msg.parts.find((p) => p.kind === 'text');
      if (text && text.kind === 'text') {
        send(text.text);
        return;
      }
    }
  }, [messages, send]);

  return { send, stop, confirmTool, retry, isStreaming, status };
}
