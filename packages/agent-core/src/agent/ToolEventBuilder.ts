import type { AgentEvent, ToolCall, ToolResult } from '@code-agent/contracts';

/**
 * 工具调用事件构建器
 *
 * 将 ToolCall 的标识字段（id/name/arguments）与事件类型组合，
 * 避免在 Agent 中重复书写相同结构。
 *
 * 使用方式：
 *   const builder = new ToolEventBuilder(toolCall);
 *   yield builder.confirm();
 *   yield builder.start();
 *   yield builder.result(toolResult);
 */
export class ToolEventBuilder {
  constructor(private readonly toolCall: ToolCall) {}

  /** 高危工具确认请求事件 */
  confirm(): AgentEvent {
    return {
      type: 'tool_call_confirm',
      data: {
        toolCallId: this.toolCall.id,
        toolName: this.toolCall.name,
        arguments: this.toolCall.arguments,
      },
    };
  }

  /** 工具执行开始事件 */
  start(): AgentEvent {
    return {
      type: 'tool_call_start',
      data: {
        toolCallId: this.toolCall.id,
        toolName: this.toolCall.name,
        arguments: this.toolCall.arguments,
      },
    };
  }

  /** 工具执行完成事件 */
  result(toolResult: ToolResult): AgentEvent {
    return {
      type: 'tool_call_result',
      data: {
        toolCallId: this.toolCall.id,
        toolName: this.toolCall.name,
        result: toolResult,
      },
    };
  }
}
