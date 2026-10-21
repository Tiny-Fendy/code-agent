/**
 * Agent 事件流 → 对话状态归并（领域服务，纯函数）
 *
 * RPC 流上的 AgentEvent 是零散增量，本模块负责把它们折叠成
 * ConversationState（消息列表 + 待确认标记）。纯函数：输入旧状态与事件，
 * 输出新状态，不做任何副作用 —— 可独立单测。
 *
 * 事件 → UI 语义对照：
 * - text_delta        → 当前流式消息追加文本（无则新开一条 streaming 消息）
 * - tool_call_delta   → 工具参数增量拼接（无则新建工具调用，状态 running）
 * - tool_call_start   → 参数以完整对象覆盖（authoritative），状态 running
 * - tool_call_confirm → 工具标记 awaiting_confirm，记入 pendingConfirmId
 * - tool_call_result  → 按 result.success 标记 success / failed
 * - message_complete  → 当前流式消息收口（streaming = false），下个事件新开消息
 * - context_compact   → UI v1 不消费，显式忽略
 */

import type { AgentEvent, SendResult } from '@code-agent/contracts';
import type {
  ConversationState,
  UIToolCall,
  UIMessage,
  UIMessageError,
  UIMessagePart,
} from './message';

/** 消息 id 生成器：进程内自增即可（UI 会话内唯一，无持久化需求） */
let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `msg_${idSeq.toString(36)}`;
}

/** 深拷贝会话状态：归并函数对外保证不可变性（Zustand 依赖新引用触发更新） */
function cloneState(state: ConversationState): ConversationState {
  return structuredClone(state);
}

/** 取当前流式中的助手消息（最后一条且 streaming = true） */
function currentStreamingMessage(state: ConversationState): UIMessage | null {
  const last = state.messages[state.messages.length - 1];
  return last && last.role === 'assistant' && last.streaming ? last : null;
}

/**
 * 按 id 全量查找工具调用（跨消息遍历）。
 *
 * 为什么不做 id → part 的索引表：一次会话内工具调用量级是几十个，
 * 线性查找足够；引入索引反而要维护增删一致性。
 */
function findToolCall(
  state: ConversationState,
  toolCallId: string,
): UIToolCall | null {
  for (const msg of state.messages) {
    for (const part of msg.parts) {
      if (part.kind === 'tool_call' && part.toolCall.id === toolCallId) {
        return part.toolCall;
      }
    }
  }
  return null;
}

/** 向当前流式消息追加文本 part；若末尾已是文本 part 则直接续写（减少 part 碎片） */
function appendText(msg: UIMessage, delta: string): void {
  const lastPart = msg.parts[msg.parts.length - 1];
  if (lastPart && lastPart.kind === 'text') {
    lastPart.text += delta;
  } else {
    msg.parts.push({ kind: 'text', text: delta });
  }
}

/** 新建一条 streaming 助手消息并追加到末尾 */
function appendStreamingAssistant(state: ConversationState): UIMessage {
  const msg: UIMessage = {
    id: nextId(),
    role: 'assistant',
    parts: [],
    streaming: true,
  };
  state.messages.push(msg);
  return msg;
}

/**
 * 归并单个 Agent 事件。入参状态不被修改。
 * 未识别的事件（契约演进新增）安全忽略：UI 对未知事件降级而非崩溃。
 */
export function applyAgentEvent(
  state: ConversationState,
  event: AgentEvent,
): ConversationState {
  const next = cloneState(state);

  switch (event.type) {
    case 'text_delta': {
      const msg = currentStreamingMessage(next) ?? appendStreamingAssistant(next);
      appendText(msg, event.data.delta);
      break;
    }

    case 'tool_call_delta': {
      for (const tc of event.data.toolCalls) {
        let toolCall = findToolCall(next, tc.id);
        if (!toolCall) {
          // 首次出现：挂到当前流式消息的 parts 末尾
          const msg = currentStreamingMessage(next) ?? appendStreamingAssistant(next);
          toolCall = { id: tc.id, name: tc.name, argumentsText: '', status: 'running' };
          msg.parts.push({ kind: 'tool_call', toolCall });
        }
        toolCall.argumentsText += tc.arguments;
      }
      break;
    }

    case 'tool_call_start': {
      // start 事件带完整参数对象，视为权威数据：无则新建，有则覆盖参数文本
      let toolCall = findToolCall(next, event.data.toolCallId);
      if (!toolCall) {
        const msg = currentStreamingMessage(next) ?? appendStreamingAssistant(next);
        toolCall = {
          id: event.data.toolCallId,
          name: event.data.toolName,
          argumentsText: '',
          status: 'running',
        };
        msg.parts.push({ kind: 'tool_call', toolCall });
      }
      toolCall.name = event.data.toolName;
      toolCall.argumentsText = JSON.stringify(event.data.arguments, null, 2);
      toolCall.status = 'running';
      break;
    }

    case 'tool_call_confirm': {
      // 高危工具请求确认：与 start 同构，先落卡片再挂起等待用户决定
      let toolCall = findToolCall(next, event.data.toolCallId);
      if (!toolCall) {
        const msg = currentStreamingMessage(next) ?? appendStreamingAssistant(next);
        toolCall = {
          id: event.data.toolCallId,
          name: event.data.toolName,
          argumentsText: '',
          status: 'awaiting_confirm',
        };
        msg.parts.push({ kind: 'tool_call', toolCall });
      }
      toolCall.name = event.data.toolName;
      toolCall.argumentsText = JSON.stringify(event.data.arguments, null, 2);
      toolCall.status = 'awaiting_confirm';
      next.pendingConfirmId = event.data.toolCallId;
      break;
    }

    case 'tool_call_result': {
      const toolCall = findToolCall(next, event.data.toolCallId);
      if (toolCall && toolCall.status !== 'denied') {
        // denied 是用户决策的终态，不被迟到的结果覆盖
        toolCall.result = event.data.result;
        toolCall.status = event.data.result.success ? 'success' : 'failed';
      }
      break;
    }

    case 'message_complete': {
      // 本段 LLM 响应收口：下个 text_delta / tool_call 会新开一条消息
      const msg = currentStreamingMessage(next);
      if (msg) msg.streaming = false;
      break;
    }

    case 'context_compact':
      // UI v1 不展示压缩详情；后续可在会话里插入一条系统提示
      break;
  }

  return next;
}

/**
 * 一轮对话的起点：追加用户消息 + 预置一条空的 streaming 助手消息。
 *
 * 为什么立即建助手消息：事件到达前有网络 / 思考延迟，
 * 空的 streaming 气泡（渲染为「思考中」）给用户即时反馈。
 */
export function startTurn(
  state: ConversationState,
  userText: string,
): ConversationState {
  const next = cloneState(state);
  next.messages.push({
    id: nextId(),
    role: 'user',
    parts: [{ kind: 'text', text: userText }],
    streaming: false,
  });
  next.messages.push({
    id: nextId(),
    role: 'assistant',
    parts: [],
    streaming: true,
  });
  return next;
}

/** SendResult → 消息终态错误（completed / finished 无错误返回 null） */
function toMessageError(result: SendResult): UIMessageError | null {
  switch (result.status) {
    case 'llmFailed':
      return { kind: 'llm_failed', message: result.message };
    case 'maxSteps':
      return { kind: 'max_steps' };
    case 'aborted':
      return { kind: 'aborted' };
    default:
      return null;
  }
}

/**
 * 一轮对话的终点：收口流式消息，失败 / 中断时在消息上标记错误。
 * 状态机复位由 chatStore 负责（本函数只管消息数据）。
 */
export function finishTurn(
  state: ConversationState,
  result: SendResult,
): ConversationState {
  const next = cloneState(state);
  const error = toMessageError(result);

  // 错误挂在最后一条助手消息上（startTurn 保证本轮必有助手消息；
  // 若状态被异常清空则无挂载点，静默跳过——错误已由全局提示兜底）
  const last = next.messages[next.messages.length - 1];
  if (last && last.role === 'assistant') {
    last.streaming = false;
    if (error) last.error = error;
  }
  return next;
}

/** RPC 层失败（onEnd status = failed，非业务终局）：与业务失败同样挂到消息上 */
export function markRpcFailure(
  state: ConversationState,
  errorMessage: string,
): ConversationState {
  const next = cloneState(state);
  const last = next.messages[next.messages.length - 1];
  if (last && last.role === 'assistant') {
    last.streaming = false;
    last.error = { kind: 'rpc_failed', message: errorMessage };
  }
  return next;
}

/**
 * 回填工具确认结果：ok = true 放行（回到 running），false 拒绝（终态 denied）。
 * 解除挂起（清 pendingConfirmId）由 chatStore 在此基础上复位状态机。
 */
export function resolveToolConfirm(
  state: ConversationState,
  toolCallId: string,
  ok: boolean,
): ConversationState {
  const next = cloneState(state);
  const toolCall = findToolCall(next, toolCallId);
  if (toolCall && toolCall.status === 'awaiting_confirm') {
    toolCall.status = ok ? 'running' : 'denied';
  }
  return next;
}
