/**
 * Agent 类 —— ReAct 循环核心
 *
 * 【核心学习目标】理解 Agent 的思考-行动-观察循环（Reasoning + Acting）
 *
 * ReAct 模式工作原理：
 *   1. 思考(Reason)：LLM 根据对话历史判断下一步该做什么
 *   2. 行动(Act)：如果需要工具，调用工具执行
 *   3. 观察(Observe)：把工具执行结果回灌给 LLM
 *   4. 循环：LLM 基于新信息继续思考，直到给出最终答案
 *
 * 事件流（通过 AsyncGenerator 推送，只含过程数据）：
 *   text_delta       → 流式文本增量
 *   tool_call_delta  → 工具调用增量
 *   tool_call_confirm → 高危工具执行前请求用户确认（注入了确认回调时）
 *   tool_call_start  → 开始执行某个工具
 *   tool_call_result → 工具执行完成，返回结果
 *   message_complete → 一轮 LLM 响应完成
 *   context_compact  → 上下文压缩完成（历史摘要替换）
 *
 * 终局结果（生成器返回值 SendResult，穷尽四个退出点）：
 *   completed  → LLM 给出最终答案
 *   llmFailed  → LLM 调用失败（错误原因随结果带出，不走事件）
 *   maxSteps   → 达到最大思考步数
 *   aborted    → 被 abort() 中断
 */

import type {
  AgentConfig,
  AgentEvent,
  AgentOptions,
  ChatMessage,
  Logger,
  SendResult,
  ToolCall,
  ToolContext,
  ToolResult,
} from '@code-agent/contracts';
import { LLMProvider, LLMEventType } from '../llm/LLMProvider.js';
import { OpenAICompatibleProvider } from '../llm/OpenAICompatible.js';
import { ToolManager } from '../tools/ToolManager.js';
import { ToolEventBuilder } from './ToolEventBuilder.js';
import { ContextManager } from '../context/ContextManager.js';
import { NullLogger } from '../logging/NullLogger.js';

/** 用户拒绝执行工具时回灌给 LLM 的结果 */
const DENIED_RESULT: ToolResult = {
  success: false,
  content: '',
  error: '用户拒绝了本次工具调用',
};

/** 默认系统提示词 */
const DEFAULT_SYSTEM_PROMPT = `你是一个专业的代码开发助手，可以帮助用户编写、修改、审查和解释代码。

你可以使用提供的工具来完成任务。当你需要使用工具时，请直接调用工具，不要询问用户是否可以使用。

使用工具的规则：
1. 先思考需要做什么，然后选择合适的工具
2. 每次调用工具后，根据结果决定下一步
3. 如果工具执行失败，分析原因并尝试修正
4. 当你有足够信息回答用户问题时，直接给出最终答案
5. 当任务全部完成时，调用 finish 工具输出总结并结束循环

finish 工具的使用：
- 仅在确认所有子任务已完成、无遗留问题时调用 finish
- finish 的 summary 应包含：完成了什么、关键变更、遗留问题（如有）
- 不要只回复文字作为结束，必须显式调用 finish 工具

ask_user 工具的使用：
- 信息不足或存在多个合理方案时，先调用 ask_user 征询用户，不要凭空假设
- 能通过工具自行确认的信息（读文件、搜索）不要问用户
- 一次只问一个问题，选项控制在 2-4 个且互斥

回答要求：
- 代码要清晰、有注释
- 解释要简洁明了
- 遵循最佳实践`;

/**
 * 上下文压缩的摘要提示词（五段式结构，参考 OpenHands Condenser）
 * 摘要请求不携带 tools 定义，避免 LLM 在压缩轮再次调用工具
 */
const COMPACT_PROMPT = `你是对话记录压缩器。请把以下历史对话压缩为结构化摘要，供 AI 助手继续工作使用。

摘要按以下部分组织（没有内容的部分省略）：
1. 用户目标
2. 已完成的工作及结果
3. 关键文件与代码位置
4. 重要决策与约束
5. 待办事项

要求：
- 保留具体路径、命令、报错信息等可复用细节
- 简洁精炼，不超过 500 字
- 直接输出摘要内容，不要额外说明`;

/** 摘要输出的 token 上限，防止摘要本身撑爆窗口 */
const COMPACT_SUMMARY_MAX_TOKENS = 800;

export class Agent {
  private config: AgentConfig;
  private llm: LLMProvider;
  private toolManager: ToolManager;
  private contextManager: ContextManager;
  private toolContext: ToolContext;
  private maxSteps: number;
  private aborted = false;
  /** 高危工具确认回调；未注入时自动放行（无 UI 场景） */
  private readonly onConfirm?: AgentOptions['onConfirm'];
  /** 开发者诊断日志；未注入时 NullLogger（库静默，与 AgentEvent 严格分离） */
  private readonly logger: Logger;

  constructor(config: AgentConfig, projectPath: string, options?: AgentOptions) {
    this.config = config;
    this.llm = new OpenAICompatibleProvider(config.apiKey, config.baseUrl);
    this.logger = options?.logger ?? new NullLogger();
    this.onConfirm = options?.onConfirm;
    // 内置工具在 ToolManager 构造时自动注册；同一 logger 实例贯穿全链路
    this.toolManager = new ToolManager(projectPath, this.logger);
    this.toolContext = {
      projectPath,
      logger: this.logger,
      // 未注入时 ask_user 自行降级为错误观察，不在此处兜底
      requestUserInput: options?.onAskUser,
    };
    this.maxSteps = config.maxSteps ?? 10;
    this.contextManager = new ContextManager(
      config.contextTokens,
      ContextManager.DEFAULT_TOOL_RESULT_LIMIT,
      this.logger,
    );

    // 初始化系统提示词
    const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.contextManager.addMessage({
      role: 'system',
      content: systemPrompt,
    });
  }

  /**
   * 发送用户消息，启动 Agent 思考循环
   *
   * 返回 AsyncGenerator：yield 过程事件，return 终局结果 SendResult。
   * 这是 ReAct 模式的核心入口。
   */
  async *run(userMessage: string): AsyncGenerator<AgentEvent, SendResult> {
    this.logger.info('任务开始', { messageLength: userMessage.length, maxSteps: this.maxSteps });

    const result = yield* this.runLoop(userMessage);

    // 终局日志：穷尽四态（completed / finished / llmFailed / maxSteps / aborted）
    const ctx: Record<string, unknown> = { status: result.status };
    if ('steps' in result && result.steps !== undefined) ctx.steps = result.steps;
    if ('summary' in result) ctx.summaryLength = result.summary.length;
    if ('message' in result && result.message) ctx.error = result.message;
    this.logger.info('任务终局', ctx);

    return result;
  }

  /** ReAct 主循环（run 的执行体，开始/终局日志由外壳统一记录） */
  private async *runLoop(userMessage: string): AsyncGenerator<AgentEvent, SendResult> {
    this.aborted = false;

    // 1. 添加用户消息到上下文
    this.contextManager.addMessage({
      role: 'user',
      content: userMessage,
    });

    // 2. ReAct 循环
    for (let step = 0; step < this.maxSteps; step++) {
      if (this.aborted) {
        return { status: 'aborted' };
      }

      // ---- 上下文压缩检查：逼近窗口上限时先压缩再思考 ----
      yield* this.maybeCompactContext();
      if (this.aborted) {
        return { status: 'aborted' };
      }

      // ---- 思考阶段：调用 LLM ----
      const { message: assistantMessage, error } = yield* this.callLLM();

      if (this.aborted) {
        return { status: 'aborted' };
      }
      if (error !== undefined) {
        return { status: 'llmFailed', message: error };
      }
      if (!assistantMessage) {
        // LLM 流既未给出完整消息也未报错（异常的上游行为）
        return { status: 'llmFailed', message: 'LLM 响应异常结束（无完整消息）' };
      }

      // 把 assistant 消息加入上下文
      this.contextManager.addMessage(assistantMessage);

      yield {
        type: 'message_complete',
        data: { message: assistantMessage, step: step + 1 },
      };

      // ---- 判断：是否需要工具调用 ----
      const toolCalls = assistantMessage.toolCalls;
      if (!toolCalls || toolCalls.length === 0) {
        // 没有工具调用 = LLM 给出了最终答案，循环结束
        return { status: 'completed', steps: step + 1 };
      }

      // ---- 行动阶段：执行工具 ----
      for (const toolCall of toolCalls) {
        if (this.aborted) break;

        const toolResult = yield* this.executeToolCall(toolCall, step + 1);
        if (toolResult) {
          return toolResult;
        }
      }

      // 继续下一轮思考（循环回到 LLM 调用）
    }

    // 超出最大步数
    return { status: 'maxSteps', steps: this.maxSteps };
  }

  /**
   * 执行单个工具调用的完整生命周期
   *
   * 包含：确认流（可选）→ 开始 → 执行 → 结果 → 观察回灌 → finish 检测
   * 返回 null 表示继续循环；返回 SendResult 表示任务结束（finished）
   */
  private async *executeToolCall(
    toolCall: ToolCall,
    step: number,
  ): AsyncGenerator<AgentEvent, SendResult | null, unknown> {
    const eventBuilder = new ToolEventBuilder(toolCall);

    // 高危工具：先请求用户确认，拒绝则跳过执行（仍需回灌 tool 消息，协议要求每个 tool_call 都有响应）
    if (this.toolManager.requiresConfirmation(toolCall.name) && this.onConfirm) {
      yield eventBuilder.confirm();
      this.logger.info('确认请求', { tool: toolCall.name });

      // 回调异常按拒绝处理（安全默认）
      const confirmStartAt = Date.now();
      let approved: boolean;
      try {
        approved = await this.onConfirm(toolCall);
      } catch {
        this.logger.warn('确认回调异常，按拒绝处理', { tool: toolCall.name });
        approved = false;
      }
      if (this.aborted) {
        return null;
      }

      if (!approved) {
        this.logger.warn('确认拒绝', {
          tool: toolCall.name,
          durationMs: Date.now() - confirmStartAt,
        });
        yield eventBuilder.result(DENIED_RESULT);
        this.contextManager.addMessage({
          role: 'tool',
          content: `Error: ${DENIED_RESULT.error}`,
          toolCallId: toolCall.id,
          name: toolCall.name,
        });
        return null;
      }
      this.logger.info('确认通过', {
        tool: toolCall.name,
        durationMs: Date.now() - confirmStartAt,
      });
    }

    // 通知：开始执行工具
    yield eventBuilder.start();

    // 执行工具
    const executeStartAt = Date.now();
    const result = await this.toolManager.execute(
      toolCall.name,
      toolCall.arguments,
      this.toolContext,
    );
    this.logger.info('工具执行完成', {
      tool: toolCall.name,
      success: result.success,
      durationMs: Date.now() - executeStartAt,
    });

    // 通知：工具执行完成
    yield eventBuilder.result(result);

    // ---- 观察阶段：把工具结果回灌到上下文 ----
    this.contextManager.addMessage({
      role: 'tool',
      content: result.success ? result.content : `Error: ${result.error}`,
      toolCallId: toolCall.id,
      name: toolCall.name,
    });

    // ---- finish 检测：LLM 主动结束任务，不再进入下一轮 ----
    if (toolCall.name === 'finish' && result.success) {
      this.logger.info('finish 命中', { summary: result.content });
      return { status: 'finished', steps: step, summary: result.content };
    }

    return null;
  }

  /**
   * 调用 LLM，处理流式响应
   *
   * - 转发 text_delta / tool_call_delta 事件给上层
   * - 返回 { message } 累积的完整消息；LLM 失败时返回 { error }（原因不走事件）
   * - 被 abort 打断时 message 为 null，由 run 统一判 aborted
   */
  private async *callLLM(): AsyncGenerator<
    AgentEvent,
    { message: ChatMessage | null; error?: string },
    unknown
  > {
    const messages = this.contextManager.getMessages();
    const tools = this.toolManager.getDefinitions();

    this.logger.info('LLM 请求', {
      model: this.config.model,
      messages: messages.length,
      tokens: this.contextManager.getTokenCount(),
      tools: tools.length,
    });
    this.logger.debug('LLM 请求原文', { messages, tools });

    const startAt = Date.now();
    const stream = this.llm.chat({
      model: this.config.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
    });

    let completeMessage: ChatMessage | null = null;

    for await (const event of stream) {
      if (this.aborted) break;

      switch (event.type) {
        case LLMEventType.TextDelta:
          yield { type: 'text_delta', data: event.data };
          break;

        case LLMEventType.ToolCallDelta:
          // 工具调用的增量也透传给 UI（可以实时展示）
          yield { type: 'tool_call_delta', data: event.data };
          break;

        case LLMEventType.MessageComplete:
          completeMessage = event.data.message;
          break;

        case LLMEventType.Error:
          // LLM 失败不向外 yield 事件，原因随返回值带出
          this.logger.error('LLM 调用失败', { error: event.data.message as string });
          return { message: null, error: event.data.message as string };
      }
    }

    if (completeMessage) {
      this.logger.info('LLM 响应', {
        durationMs: Date.now() - startAt,
        contentLength: completeMessage.content.length,
        toolCalls: completeMessage.toolCalls?.length ?? 0,
      });
      this.logger.debug('LLM 响应原文', { message: completeMessage });
    }

    return { message: completeMessage };
  }

  /**
   * 上下文压缩编排：触发时把摘要区交给 LLM 压缩为结构化摘要并应用
   *
   * - 摘要请求不带 tools（纯文本压缩）
   * - 压缩后预估仍超触发阈值 → 跳过应用（防抖防御，避免反复压缩）
   * - 摘要请求失败/中断 → 跳过本轮压缩，不中断任务
   * - 应用成功 → yield context_compact 事件
   */
  private async *maybeCompactContext(): AsyncGenerator<AgentEvent> {
    const cm = this.contextManager;
    if (!cm.shouldCompact()) return;

    const range = cm.getCompactableRange();
    if (range.length === 0) return;
    const before = cm.getTokenCount();
    this.logger.info('压缩触发', { before, range: range.length });
    const compactStartAt = Date.now();

    // 序列化摘要区为对话记录文本
    const transcript = range
      .map(m => {
        const calls = m.toolCalls
          ?.map(tc => `[调用工具 ${tc.name}] ${JSON.stringify(tc.arguments)}`)
          .join('\n');
        return `[${m.role}] ${m.content}${calls ? `\n${calls}` : ''}`;
      })
      .join('\n\n');

    let summary = '';
    try {
      const stream = this.llm.chat({
        model: this.config.model,
        messages: [
          { role: 'system', content: COMPACT_PROMPT },
          { role: 'user', content: transcript },
        ],
        temperature: 0,
        maxTokens: COMPACT_SUMMARY_MAX_TOKENS,
      });
      for await (const event of stream) {
        if (this.aborted) return;
        if (event.type === LLMEventType.TextDelta) {
          summary += event.data.delta;
        } else if (event.type === LLMEventType.Error) {
          this.logger.warn('压缩摘要请求失败，跳过本轮压缩', {
            error: event.data.message as string,
          });
          return; // 摘要请求出错 → 跳过压缩，任务继续
        }
      }
    } catch {
      this.logger.warn('压缩摘要请求异常，跳过本轮压缩');
      return; // 网络/模型异常 → 跳过压缩，任务继续
    }

    summary = summary.trim();
    if (!summary) return;

    // 防抖防御：压缩后仍超触发阈值（摘要体积过大）→ 跳过应用
    if (cm.estimateAfterCompact(summary) >= cm.getCompactThreshold()) {
      this.logger.warn('压缩后预估仍超阈值，防抖跳过', {
        estimate: cm.estimateAfterCompact(summary),
        threshold: cm.getCompactThreshold(),
      });
      return;
    }

    cm.compact(summary);
    const after = cm.getTokenCount();
    this.logger.info('压缩完成', {
      before,
      after,
      durationMs: Date.now() - compactStartAt,
    });
    yield { type: 'context_compact', data: { before, after } };
  }

  /** 中断当前执行 */
  abort(): void {
    this.aborted = true;
  }

  /** 获取对话历史 */
  getHistory(): ChatMessage[] {
    return this.contextManager.getMessages();
  }

  /** 清空对话历史（保留 system prompt） */
  clearHistory(): void {
    this.contextManager.clear();
    // 重新添加系统提示词
    const systemPrompt = this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.contextManager.addMessage({
      role: 'system',
      content: systemPrompt,
    });
  }
}
