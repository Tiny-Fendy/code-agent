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
 * 事件流（通过 AsyncGenerator 推送）：
 *   text_delta       → 流式文本增量
 *   tool_call_delta  → 工具调用增量
 *   tool_call_confirm → 高危工具执行前请求用户确认（注入了确认回调时）
 *   tool_call_start  → 开始执行某个工具
 *   tool_call_result → 工具执行完成，返回结果
 *   message_complete → 一轮 LLM 响应完成
 *   context_compact  → 上下文压缩完成（历史摘要替换）
 *   done             → 整个 Agent 任务完成
 *   error            → 出错
 */

import type {
  AgentConfig,
  AgentEvent,
  ChatMessage,
  ToolCall,
  ToolConfirmCallback,
  ToolContext,
  ToolResult,
} from '@code-agent/shared';
import { LLMProvider } from '../llm/LLMProvider';
import { OpenAICompatibleProvider } from '../llm/OpenAICompatible';
import { ToolManager } from '../tools/ToolManager';
import { ContextManager } from '../context/ContextManager';

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
  private onConfirm?: ToolConfirmCallback;

  constructor(config: AgentConfig, projectPath: string, onConfirm?: ToolConfirmCallback) {
    this.config = config;
    this.llm = new OpenAICompatibleProvider(config.apiKey, config.baseUrl);
    // 内置工具在 ToolManager 构造时自动注册
    this.toolManager = new ToolManager(projectPath);
    this.toolContext = { projectPath };
    this.maxSteps = config.maxSteps ?? 10;
    this.contextManager = new ContextManager(config.contextTokens);
    this.onConfirm = onConfirm;

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
   * 返回 AsyncGenerator，逐步推送 Agent 事件。
   * 这是 ReAct 模式的核心入口。
   */
  async *run(userMessage: string): AsyncGenerator<AgentEvent> {
    this.aborted = false;

    // 1. 添加用户消息到上下文
    this.contextManager.addMessage({
      role: 'user',
      content: userMessage,
    });

    // 2. ReAct 循环
    for (let step = 0; step < this.maxSteps; step++) {
      if (this.aborted) {
        yield { type: 'done', data: { reason: 'aborted' } };
        return;
      }

      // ---- 上下文压缩检查：逼近窗口上限时先压缩再思考 ----
      yield* this.maybeCompactContext();
      if (this.aborted) {
        yield { type: 'done', data: { reason: 'aborted' } };
        return;
      }

      // ---- 思考阶段：调用 LLM ----
      const assistantMessage = yield* this.callLLM();

      if (!assistantMessage) {
        // callLLM 内部已经 yield 了 error 事件
        return;
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
        yield { type: 'done', data: { steps: step + 1 } };
        return;
      }

      // ---- 行动阶段：执行工具 ----
      for (const toolCall of toolCalls) {
        if (this.aborted) break;

        // 高危工具：先请求用户确认，拒绝则跳过执行（仍需回灌 tool 消息，协议要求每个 tool_call 都有响应）
        if (this.toolManager.requiresConfirmation(toolCall.name) && this.onConfirm) {
          yield {
            type: 'tool_call_confirm',
            data: {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              arguments: toolCall.arguments,
            },
          };

          // 回调异常按拒绝处理（安全默认）
          const approved = await this.onConfirm(toolCall).catch(() => false);
          if (this.aborted) break;

          if (!approved) {
            yield {
              type: 'tool_call_result',
              data: {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result: DENIED_RESULT,
              },
            };
            this.contextManager.addMessage({
              role: 'tool',
              content: `Error: ${DENIED_RESULT.error}`,
              toolCallId: toolCall.id,
              name: toolCall.name,
            });
            continue;
          }
        }

        // 通知：开始执行工具
        yield {
          type: 'tool_call_start',
          data: {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            arguments: toolCall.arguments,
          },
        };

        // 执行工具
        const result = await this.toolManager.execute(
          toolCall.name,
          toolCall.arguments,
          this.toolContext,
        );

        // 通知：工具执行完成
        yield {
          type: 'tool_call_result',
          data: {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            result,
          },
        };

        // ---- 观察阶段：把工具结果回灌到上下文 ----
        this.contextManager.addMessage({
          role: 'tool',
          content: result.success ? result.content : `Error: ${result.error}`,
          toolCallId: toolCall.id,
          name: toolCall.name,
        });
      }

      // 继续下一轮思考（循环回到 LLM 调用）
    }

    // 超出最大步数
    yield {
      type: 'error',
      data: { message: `已达到最大思考步数 (${this.maxSteps})，任务未完成` },
    };
    yield { type: 'done', data: { reason: 'max_steps', steps: this.maxSteps } };
  }

  /**
   * 调用 LLM，处理流式响应
   *
   * - 转发 text_delta 事件给上层
   * - 累积完整消息后返回
   * - 出错时 yield error 事件并返回 null
   */
  private async *callLLM(): AsyncGenerator<AgentEvent, ChatMessage | null, unknown> {
    const messages = this.contextManager.getMessages();
    const tools = this.toolManager.getDefinitions();

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
        case 'text_delta':
          yield { type: 'text_delta', data: event.data };
          break;

        case 'tool_call_delta':
          // 工具调用的增量也透传给 UI（可以实时展示）
          yield { type: 'tool_call_delta', data: event.data };
          break;

        case 'message_complete':
          completeMessage = event.data.message;
          break;

        case 'error':
          yield { type: 'error', data: event.data };
          return null;
      }
    }

    return completeMessage;
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
        if (event.type === 'text_delta') {
          summary += event.data.delta;
        } else if (event.type === 'error') {
          return; // 摘要请求出错 → 跳过压缩，任务继续
        }
      }
    } catch {
      return; // 网络/模型异常 → 跳过压缩，任务继续
    }

    summary = summary.trim();
    if (!summary) return;

    // 防抖防御：压缩后仍超触发阈值（摘要体积过大）→ 跳过应用
    if (cm.estimateAfterCompact(summary) >= cm.getCompactThreshold()) return;

    cm.compact(summary);
    yield { type: 'context_compact', data: { before, after: cm.getTokenCount() } };
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
