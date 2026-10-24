/**
 * 对话会话：Agent 实例复用 + 工具确认桥接
 *
 * 职责（见 openspec/changes/003-chat-session/design.md）：
 * - 会话保持：按「配置 + 项目路径」快照复用 Agent；脏标记命中时重建
 * - 确认门控：把引擎的 onConfirm 挂起回调桥接为「待决表 + confirm 决议」
 * - 生命周期：忙锁、取消收口、终局清理、上下文完整性判定
 *
 * 本类不依赖 Electron / RPC，Agent 通过工厂注入，便于单测。
 */

import type {
  AgentConfig,
  AgentEvent,
  AgentOptions,
  AppConfig,
  ChatMessage,
  Logger,
  SendResult,
  ToolCall,
} from '@code-agent/contracts';

/** ChatSession 只使用 Agent 的这两项能力 */
export interface ChatAgent {
  run(message: string): AsyncGenerator<AgentEvent, SendResult>;
  abort(): void;
}

export type AgentFactory = (
  config: AgentConfig,
  projectPath: string,
  options: AgentOptions,
) => ChatAgent;

/** 配置来源（ConfigServiceImpl 结构满足） */
export interface ConfigSource {
  getCached(): AppConfig;
}

/** 项目来源（WorkspaceState 结构满足） */
export interface ProjectSource {
  readonly projectPath: string | null;
}

/** 流进行中再次发起对话 */
export class ChatSessionBusyError extends Error {
  constructor() {
    super('上一条对话仍在进行中');
    this.name = 'ChatSessionBusyError';
  }
}

export class ChatSession {
  private agent: ChatAgent | null = null;
  /** Agent 创建时的配置快照，用于判定配置变更 */
  private configKey: string | null = null;
  /** Agent 创建时的项目路径快照 */
  private projectPath: string | null = null;
  /** 流进行中（同步置位，避免同一 tick 重入） */
  private busy = false;
  /** 上下文结构不完整，下次 start 必须重建 */
  private dirty = false;
  /** toolCallId → 决议函数 */
  private readonly pendingConfirms = new Map<string, (ok: boolean) => void>();
  /** 本轮 assistant 声明、尚未回灌结果的工具调用 id */
  private readonly openToolCalls = new Set<string>();

  constructor(
    private readonly configSource: ConfigSource,
    private readonly projectSource: ProjectSource,
    private readonly logger: Logger,
    private readonly createAgent: AgentFactory,
  ) {}

  /**
   * 开始一轮对话
   *
   * 同步完成忙锁检查与置位；生成器被 RPC 层泵送，终局清理在 finally 中统一执行。
   */
  start(message: string): AsyncGenerator<AgentEvent, SendResult> {
    if (this.busy) throw new ChatSessionBusyError();
    this.busy = true;
    return this.run(message);
  }

  /** UI 决议：first-wins，未知 / 已过期 id 静默忽略 */
  confirm(toolCallId: string, ok: boolean): void {
    const resolve = this.pendingConfirms.get(toolCallId);
    if (!resolve) {
      this.logger.warn('确认决议未命中（未知或已过期）', { toolCallId, ok });
      return;
    }
    this.pendingConfirms.delete(toolCallId);
    this.logger.info('确认决议', { toolCallId, ok });
    resolve(ok);
  }

  /** 取消：中断引擎并解除确认等待，让生成器得以收尾 */
  abort(): void {
    this.agent?.abort();
    this.settleConfirms(false);
  }

  /** 包装生成器：逐帧转发 + 事件观测 + 终局清理 */
  private async *run(message: string): AsyncGenerator<AgentEvent, SendResult> {
    let inner: AsyncGenerator<AgentEvent, SendResult> | undefined;
    try {
      const agent = this.ensureAgent();
      inner = agent.run(message);
      while (true) {
        const next = await inner.next();
        if (next.done) return next.value;
        this.trackEvent(next.value);
        yield next.value;
      }
    } finally {
      this.busy = false;
      // 未决议项按拒绝收口：唤醒挂在 await onConfirm 的引擎
      this.settleConfirms(false);
      // 包装器被外部强制 return 时，确保内部生成器同步收尾
      if (inner) void inner.return({ status: 'aborted' }).catch(() => {});
      this.evaluateIntegrity();
    }
  }

  /** 按快照决定复用还是重建 */
  private ensureAgent(): ChatAgent {
    const appConfig = this.configSource.getCached();
    const agentConfig: AgentConfig = {
      apiKey: appConfig.api.apiKey,
      baseUrl: appConfig.api.baseUrl,
      model: appConfig.api.model,
      temperature: appConfig.api.temperature,
      maxTokens: appConfig.api.maxTokens,
    };
    const projectPath = this.projectSource.projectPath ?? process.cwd();
    const configKey = JSON.stringify(agentConfig);

    if (
      this.agent &&
      !this.dirty &&
      this.configKey === configKey &&
      this.projectPath === projectPath
    ) {
      return this.agent;
    }

    const reason = !this.agent
      ? 'first'
      : this.dirty
        ? 'dirty'
        : this.configKey !== configKey
          ? 'config-changed'
          : 'project-changed';

    this.agent = this.createAgent(agentConfig, projectPath, {
      logger: this.logger,
      onConfirm: (toolCall) => this.awaitConfirm(toolCall),
    });
    this.configKey = configKey;
    this.projectPath = projectPath;
    this.dirty = false;
    this.openToolCalls.clear();
    this.logger.info('会话 Agent 就绪', { reason, projectPath, model: agentConfig.model });
    return this.agent;
  }

  /** 引擎确认回调：登记待决项并挂起，等待 UI 决议或取消收口 */
  private awaitConfirm(toolCall: ToolCall): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const existing = this.pendingConfirms.get(toolCall.id);
      if (existing) {
        this.logger.warn('确认请求重复，覆盖旧等待', { toolCallId: toolCall.id });
        this.pendingConfirms.delete(toolCall.id);
        existing(false);
      }
      this.pendingConfirms.set(toolCall.id, resolve);
      this.logger.info('等待工具确认', { toolCallId: toolCall.id, tool: toolCall.name });
    });
  }

  /** 观测事件，维护「已声明未回灌」的工具调用集合 */
  private trackEvent(event: AgentEvent): void {
    if (event.type === 'message_complete') {
      this.openToolCalls.clear();
      const toolCalls = (event.data.message as ChatMessage).toolCalls ?? [];
      for (const toolCall of toolCalls) this.openToolCalls.add(toolCall.id);
    } else if (event.type === 'tool_call_result') {
      this.openToolCalls.delete(event.data.toolCallId);
    }
  }

  /**
   * 完整性判定：仍有未回灌结果的工具调用 → 标记脏
   *
   * 上游协议要求 assistant 声明的每个 tool_call 都有 tool 消息，
   * 中断导致的缺口会让下一轮请求失败，因此下次必须重建会话。
   */
  private evaluateIntegrity(): void {
    if (this.openToolCalls.size === 0) return;
    this.dirty = true;
    this.logger.warn('上下文不完整，下次对话将重建会话', {
      openToolCalls: [...this.openToolCalls],
    });
    this.openToolCalls.clear();
  }

  /** 对待决确认统一收口（取消 / 异常 / 正常终局） */
  private settleConfirms(ok: boolean): void {
    if (this.pendingConfirms.size === 0) return;
    const pending = [...this.pendingConfirms.values()];
    this.pendingConfirms.clear();
    this.logger.warn('未决议确认自动收口', { count: pending.length, ok });
    for (const resolve of pending) resolve(ok);
  }
}
