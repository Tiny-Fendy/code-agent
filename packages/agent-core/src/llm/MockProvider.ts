/**
 * Mock LLM Provider —— 开发态剧本驱动（非正式功能）
 *
 * 用剧本（ChatMessage 序列）合成与真实 Provider 同构的事件流，
 * 驱动除 LLM 本身外的全链路验证（工具链、确认流、压缩、finish），
 * 并用于后期问题复现——不消耗 token、可稳定重放。
 *
 * 切换机制（外部零感知，Agent / 调用方零改动）：
 * - 类 API：setMockProvider(provider) 显式设置，支持动态剧本等完整能力
 * - 环境变量：CODE_AGENT_MOCK_SCRIPT=<path> 指向 JSON 剧本（静态消息数组），
 *   首次调用时惰性加载；加载失败进入错误态，每次调用报错，绝不回退真实 LLM
 * - 优先级：显式 setMockProvider > 环境变量 > 关闭
 * - clearMockProvider() 清除全部 mock 状态（含 env 缓存），供测试隔离
 *
 * 委托点在 OpenAICompatibleProvider.chat() 入口（见 design.md D1/D2）。
 */

import { readFileSync } from 'node:fs';
import {
  LLMProvider,
  LLMEventType,
  type ChatCompletionParams,
  type LLMEvent,
  type LLMRequest,
} from './LLMProvider.js';
import type { ChatMessage } from '@code-agent/contracts';

/** 剧本条目：静态消息，或按请求动态生成（可检查 params.messages 做有状态剧本） */
export type MockTurn =
  | ChatMessage
  | ((params: ChatCompletionParams) => ChatMessage | Promise<ChatMessage>);

export interface MockProviderOptions {
  /** 文本/参数增量切分粒度（字符），默认 4 */
  chunkSize?: number;
  /** 每块之间的延迟（ms），默认 0；手动观察流式效果时用 */
  delay?: number;
  /** 剧本耗尽行为：'error'（默认，yield Error 事件）| 'loop'（重复最后一条） */
  onExhausted?: 'error' | 'loop';
}

/** 默认增量切分粒度 */
const DEFAULT_CHUNK_SIZE = 4;

/** 环境变量名：JSON 剧本文件路径 */
const MOCK_SCRIPT_ENV = 'CODE_AGENT_MOCK_SCRIPT';

export class MockProvider extends LLMProvider {
  /** 收到的全部请求记录，供断言与排查 */
  readonly calls: ChatCompletionParams[] = [];

  private readonly script: MockTurn[];
  private readonly chunkSize: number;
  private readonly delayMs: number;
  private readonly exhaustedMode: 'error' | 'loop';
  private cursor = 0;
  /** 配置错误态：非空时每次调用均 yield Error（env 加载失败专用） */
  private readonly brokenMessage?: string;

  constructor(script: MockTurn[], options: MockProviderOptions = {}) {
    super('mock', 'mock://'); // apiKey/baseUrl 占位，mock 不发网络请求
    this.script = script;
    const chunk = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.chunkSize = chunk > 0 ? chunk : DEFAULT_CHUNK_SIZE;
    this.delayMs = options.delay ?? 0;
    this.exhaustedMode = options.onExhausted ?? 'error';
  }

  /** 配置错误实例：每次调用均 yield Error，绝不回退真实 LLM（防止意外消耗 token） */
  static broken(message: string): MockProvider {
    const instance = new MockProvider([]);
    (instance as unknown as { brokenMessage?: string }).brokenMessage = message;
    return instance;
  }

  chat(params: ChatCompletionParams): LLMRequest {
    // mock 无网络连接，abort 为空操作（句柄形态对齐真实 Provider）
    return { events: this.streamEvents(params), abort: () => {} };
  }

  private async *streamEvents(params: ChatCompletionParams): AsyncGenerator<LLMEvent> {
    this.calls.push(params);

    if (this.brokenMessage) {
      yield { type: LLMEventType.Error, data: { message: this.brokenMessage } };
      return;
    }

    const turn = await this.resolveTurn(params);
    if ('error' in turn) {
      yield { type: LLMEventType.Error, data: { message: turn.error } };
      return;
    }

    yield* this.synthesize(turn.message);
  }

  /** 取剧本条目：消耗静态/动态条目，耗尽按 onExhausted 处理 */
  private async resolveTurn(
    params: ChatCompletionParams,
  ): Promise<{ message: ChatMessage } | { error: string }> {
    if (this.cursor >= this.script.length) {
      if (this.exhaustedMode === 'loop' && this.script.length > 0) {
        return this.materialize(this.script[this.script.length - 1], params);
      }
      return { error: `Mock 剧本已耗尽（第 ${this.calls.length} 次调用）` };
    }
    const turn = this.script[this.cursor++];
    return this.materialize(turn, params);
  }

  /** 静态条目直接使用；动态函数执行（异常转为错误） */
  private async materialize(
    turn: MockTurn,
    params: ChatCompletionParams,
  ): Promise<{ message: ChatMessage } | { error: string }> {
    if (typeof turn === 'function') {
      try {
        return { message: await turn(params) };
      } catch (err) {
        return { error: `Mock 剧本执行失败: ${(err as Error).message}` };
      }
    }
    return { message: turn };
  }

  /**
   * 事件合成：与真实 Provider 输出严格同构（design.md D3 硬约束）
   * content 与 toolCalls 并存时，先文本后工具调用
   */
  private async *synthesize(message: ChatMessage): AsyncGenerator<LLMEvent> {
    // ---- 文本增量 ----
    if (message.content) {
      for (const chunk of chunkString(message.content, this.chunkSize)) {
        yield { type: LLMEventType.TextDelta, data: { delta: chunk } };
        await sleep(this.delayMs);
      }
    }

    // ---- 工具调用增量：arguments JSON 串切分，每次携带全部 toolCall 的累积状态 ----
    if (message.toolCalls && message.toolCalls.length > 0) {
      const argChars = message.toolCalls.map(tc => [...JSON.stringify(tc.arguments ?? {})]);
      const acc = message.toolCalls.map(tc => ({ id: tc.id, name: tc.name, arguments: '' }));
      const maxLen = Math.max(...argChars.map(chars => chars.length));

      for (let i = 0; i < maxLen; i += this.chunkSize) {
        for (let t = 0; t < acc.length; t++) {
          acc[t] = { ...acc[t], arguments: acc[t].arguments + argChars[t].slice(i, i + this.chunkSize).join('') };
        }
        yield { type: LLMEventType.ToolCallDelta, data: { toolCalls: acc.map(tc => ({ ...tc })) } };
        await sleep(this.delayMs);
      }
    }

    // ---- 完整消息（深拷贝，避免同一对象引用被多次加入上下文） ----
    yield {
      type: LLMEventType.MessageComplete,
      data: { message: structuredClone(message) },
    };
  }
}

// ---------------------------------------------------------------------------
// 模块级开关（OpenAICompatible 委托用）
// ---------------------------------------------------------------------------

let explicitMock: MockProvider | null = null;
/** undefined = 尚未初始化；null = 已初始化且未配置 */
let envMock: MockProvider | null | undefined = undefined;

/** 显式设置 mock 单例（类 API 入口，支持动态剧本等完整能力） */
export function setMockProvider(provider: MockProvider): void {
  explicitMock = provider;
}

/** 清除全部 mock 状态（显式单例 + env 惰性缓存），供测试隔离 */
export function clearMockProvider(): void {
  explicitMock = null;
  envMock = undefined;
}

/** mock 是否启用：显式 setMockProvider > 环境变量 > 关闭 */
export function mockEnabled(): boolean {
  return explicitMock !== null || loadEnvMock() !== null;
}

/** 取当前 mock 单例的请求句柄（调用方须先经 mockEnabled() 判断） */
export function mockRequest(params: ChatCompletionParams): LLMRequest {
  const provider = explicitMock ?? loadEnvMock();
  if (!provider) {
    // 防御分支：正常流程不会到达（mockEnabled 先行判断）
    return new MockProvider([]).chat(params);
  }
  return provider.chat(params);
}

/** 惰性加载环境变量剧本：首次调用读盘并缓存，此后不再重复读取 */
function loadEnvMock(): MockProvider | null {
  if (envMock !== undefined) return envMock;

  const path = process.env[MOCK_SCRIPT_ENV];
  if (!path) {
    envMock = null;
    return null;
  }

  envMock = loadScriptFile(path);
  return envMock;
}

/** 读取 JSON 剧本文件；任何失败都返回错误态实例（fail-loud，绝不回退真实 LLM） */
function loadScriptFile(path: string): MockProvider {
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(data)) {
      throw new Error('剧本必须是 ChatMessage 数组');
    }
    const script: MockTurn[] = data.map((item, i) => {
      const msg = item as ChatMessage;
      if (typeof msg?.role !== 'string' || typeof msg?.content !== 'string') {
        throw new Error(`剧本第 ${i + 1} 条缺少 role/content 字段`);
      }
      return msg;
    });
    return new MockProvider(script);
  } catch (err) {
    return MockProvider.broken(`Mock 剧本加载失败（${MOCK_SCRIPT_ENV}=${path}）: ${(err as Error).message}`);
  }
}

/** 按 Unicode 码点切分字符串（不截断多字节字符） */
function* chunkString(str: string, size: number): Generator<string> {
  const chars = [...str];
  for (let i = 0; i < chars.length; i += size) {
    yield chars.slice(i, i + size).join('');
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise<void>(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}
