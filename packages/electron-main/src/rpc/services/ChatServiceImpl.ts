/**
 * ChatService 实现：Agent ↔ RPC 的适配层
 *
 * 取消桥接（设计 4.3）：
 *   渲染层 stream.abort()
 *     → invoke('__stream', 'cancel')
 *     → Router 终止泵并触发句柄 onAbort 钩子
 *     → agent.abort()（Agent 循环在下一个检查点停止）
 */

import { Agent } from '@code-agent/agent-core';
import type { AgentEvent, ChatService } from '@code-agent/shared';
import { createRpcStream } from '../Router';
import type { ServerRpcStream } from '../Router';
import type { ConfigServiceImpl } from './ConfigServiceImpl';
import type { WorkspaceState } from './WorkspaceState';

export class ChatServiceImpl implements ChatService {
  constructor(
    private readonly config: ConfigServiceImpl,
    private readonly workspace: WorkspaceState,
  ) {}

  send(_message: string): ServerRpcStream<AgentEvent> {
    const appConfig = this.config.getCached();

    // AppConfig → AgentConfig 显式映射
    const agent = new Agent(
      {
        apiKey: appConfig.api.apiKey,
        baseUrl: appConfig.api.baseUrl,
        model: appConfig.api.model,
        temperature: appConfig.api.temperature,
        maxTokens: appConfig.api.maxTokens,
      },
      // 未打开项目时退化为当前工作目录
      this.workspace.projectPath ?? process.cwd(),
    );

    const stream = createRpcStream<AgentEvent>(agent.run(_message));
    // 句柄 abort → Agent 中断
    stream.onAbort(() => agent.abort());
    return stream;
  }

  async confirmTool(_toolCallId: string, _ok: boolean): Promise<void> {
    // Agent 当前自动执行全部工具，tool_call_confirm 确认门控尚未在引擎落地；
    // 预留契约入口，待 agent-core 支持挂起等待确认后在此回传结果。
  }
}
