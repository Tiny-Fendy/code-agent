/**
 * ChatService 实现：会话 ↔ RPC 的适配层
 *
 * 会话保持与确认门控在 ChatSession 中实现（见 openspec/changes/003-chat-session），
 * 本层只负责：
 * - 创建 RPC 流并桥接取消：句柄 abort → session.abort()
 * - 把忙锁异常翻译为带业务码的失败终局（chat.BUSY）
 * - 把 confirmTool 决议投递给会话
 */

import { Agent } from '@code-agent/agent-core';
import type { AgentEvent, ChatService, Logger, SendResult } from '@code-agent/contracts';
import type { RpcStream } from '@code-agent/rpc/protocol';
import { createRpcStream } from '@code-agent/rpc/main';
import { ChatSession, ChatSessionBusyError } from './ChatSession';
import type { ConfigServiceImpl } from './ConfigServiceImpl';
import type { WorkspaceState } from './WorkspaceState';

/** 业务错误码（服务前缀命名，见 systems/rpc-communication.md §5） */
const CHAT_ERROR_BUSY = 'chat.BUSY';

export class ChatServiceImpl implements ChatService {
  /** 服务注册名（契约 ServiceDef 显式声明，Router.registerAll 读取） */
  readonly serviceName = 'chat' as const;

  private readonly session: ChatSession;

  constructor(
    config: ConfigServiceImpl,
    workspace: WorkspaceState,
    logger: Logger,
  ) {
    this.session = new ChatSession(
      config,
      workspace,
      logger,
      (agentConfig, projectPath, options) => new Agent(agentConfig, projectPath, options),
    );
  }

  send(message: string): RpcStream<AgentEvent, SendResult> {
    let generator: AsyncGenerator<AgentEvent, SendResult>;
    try {
      generator = this.session.start(message);
    } catch (err) {
      // 忙锁用失败流承载业务码；直接 throw 会被 Router 包成 RPC_HANDLER_ERROR
      if (err instanceof ChatSessionBusyError) {
        const failed = createRpcStream<AgentEvent, SendResult>();
        failed.error({ code: CHAT_ERROR_BUSY, message: err.message });
        return failed;
      }
      throw err;
    }

    // 形态 B：拉模式包装，生成器 return 的 SendResult 即流终局结果
    const stream = createRpcStream(generator);
    // 取消链路：先解除确认等待，再让引擎在检查点停止
    stream.onAbort(() => this.session.abort());
    return stream;
  }

  async confirmTool(toolCallId: string, ok: boolean): Promise<void> {
    this.session.confirm(toolCallId, ok);
  }
}
