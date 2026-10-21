/**
 * 对话领域模型导出
 */

export type {
  ConversationState,
  SessionStatus,
  ToolCallStatus,
  UIMessage,
  UIMessageError,
  UIMessagePart,
  UIToolCall,
} from './message';
export { emptyConversation } from './message';
export {
  applyAgentEvent,
  finishTurn,
  markRpcFailure,
  resolveToolConfirm,
  startTurn,
} from './eventMerger';
