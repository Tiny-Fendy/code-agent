/**
 * 对话 store：会话状态与消息列表的唯一写入口
 *
 * 数据变换全部委托领域层（domain/conversation）——本 store 只做两件事：
 * 1. 持有 ConversationState + 会话状态机 status
 * 2. 把 UI 动作翻译成「领域函数调用 + 状态机复位」
 * 流订阅（RPC 副作用）不在这里，由 hooks/useChatStream 接线后调 ingestEvent。
 */

import { create } from 'zustand';
import type { AgentEvent, SendResult } from '@code-agent/contracts';
import {
  applyAgentEvent,
  emptyConversation,
  finishTurn,
  markRpcFailure,
  resolveToolConfirm,
  startTurn,
  type ConversationState,
  type SessionStatus,
} from '@/domain/conversation';

interface ChatState extends ConversationState {
  /** 会话状态机：streaming（含等待事件）→ awaiting_confirm（高危工具挂起）→ idle */
  status: SessionStatus;

  /** 开启新一轮：追加用户消息 + 预置流式助手气泡 */
  beginTurn: (userText: string) => void;
  /** 摄入一个流事件（按到达顺序逐个调用） */
  ingestEvent: (event: AgentEvent) => void;
  /** 业务终局（SendResult）收口 */
  endTurn: (result: SendResult) => void;
  /** RPC 层失败（非业务终局）收口 */
  failTurn: (errorMessage: string) => void;
  /** 回填挂起中的工具确认结果：放行回到 streaming，拒绝后 agent 继续处理 */
  resolvePendingConfirm: (ok: boolean) => void;
  /** 清空会话 */
  clear: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  ...emptyConversation(),
  status: 'idle',

  beginTurn: (userText) => {
    set((s) => ({ ...startTurn(s, userText), status: 'streaming' }));
  },

  ingestEvent: (event) => {
    set((s) => {
      const next = applyAgentEvent(s, event);
      // tool_call_confirm 挂起会话；其余事件不改变状态机
      const status: SessionStatus =
        event.type === 'tool_call_confirm' ? 'awaiting_confirm' : s.status;
      return { ...next, status };
    });
  },

  endTurn: (result) => {
    set((s) => ({ ...finishTurn(s, result), status: 'idle', pendingConfirmId: null }));
  },

  failTurn: (errorMessage) => {
    set((s) => ({ ...markRpcFailure(s, errorMessage), status: 'idle', pendingConfirmId: null }));
  },

  resolvePendingConfirm: (ok) => {
    const { pendingConfirmId } = get();
    if (!pendingConfirmId) return;
    set((s) => ({
      ...resolveToolConfirm(s, pendingConfirmId, ok),
      // 放行 → agent 继续跑，回到 streaming；拒绝 → agent 收到拒绝后也会继续输出
      status: 'streaming',
      pendingConfirmId: null,
    }));
  },

  clear: () => set({ ...emptyConversation(), status: 'idle' }),
}));
