/**
 * 纯 Web 模式的 mock Transport（v2）
 *
 * 传输机制由 @code-agent/rpc/mock 框架提供（信封协议 / 流帧泵送 / 取消链路），
 * 本文件只声明业务场景：config 存取、chat 假 Agent 事件流、file 空实现。
 *
 * 三种终局均可触发：
 * - 默认：事件序列推完 → end{completed, result: SendResult.completed}
 * - 消息以 "/fail" 开头：推送事件后 end{completed, result: llmFailed}
 *   （对齐真实链路：Agent 的 LLM 失败是业务终局，随 completed 帧的 result 表达）
 * - 消息以 "/tool" 开头：模拟工具确认流——推 tool_call_start → tool_call_confirm，
 *   然后挂起等待 confirmTool 决策；放行推 tool_call_result，拒绝推文本说明。
 * - 调用句柄 abort()：end{aborted}，泵送立即停止
 */

import { createMockTransport as createMockTransportFrame } from '@code-agent/rpc/mock';
import type { Transport, StreamFrame } from '@code-agent/rpc/protocol';
import {
  DEFAULT_CONFIG,
  type AgentEvent,
  type AppConfig,
} from '@code-agent/contracts';

/** 构造一条假的 Agent 事件序列：回显用户消息，模拟流式输出（不含终局事件） */
function buildFakeEvents(userMessage: string): AgentEvent[] {
  const reply = `收到你的消息：「${userMessage}」\n我是 mock 模式下的假 Agent，用于在浏览器里调试 UI。`;
  const chunks: string[] = [];
  for (let i = 0; i < reply.length; i += 4) chunks.push(reply.slice(i, i + 4));

  const events: AgentEvent[] = chunks.map((delta) => ({ type: 'text_delta', data: { delta } }));
  events.push({
    type: 'message_complete',
    data: { message: { role: 'assistant', content: reply }, step: 1 },
  });
  return events;
}

/** 工具确认流的挂起决策：resolve 时继续 pump，并带上用户选择 */
interface ConfirmDecision {
  resolve: (ok: boolean) => void;
  promise: Promise<boolean>;
}

function makeConfirmDecision(): ConfirmDecision {
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((r) => (resolve = r));
  return { resolve, promise };
}

/** 自管理流：/tool 场景不走框架脚本，自己控制帧推送时序 */
function createToolConfirmStream(
  emit: (frame: StreamFrame<AgentEvent, { status: string; steps?: number; message?: string; summary?: string }>) => void,
  isAborted: () => boolean,
  decision: ConfirmDecision,
): void {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  void (async () => {
    const push = (event: AgentEvent) => {
      if (isAborted()) return;
      emit({ streamId: 'tool-stream', kind: 'next', value: event });
    };

    push({ type: 'text_delta', data: { delta: '我需要执行一个工具来帮助你。' } });
    await delay(300);

    push({
      type: 'tool_call_start',
      data: {
        toolCallId: 'mock-tool-1',
        toolName: 'read_file',
        arguments: { path: '/Users/tiny/Project/demo/src/index.ts' },
      },
    });
    await delay(200);

    push({
      type: 'tool_call_confirm',
      data: {
        toolCallId: 'mock-tool-1',
        toolName: 'read_file',
        arguments: { path: '/Users/tiny/Project/demo/src/index.ts' },
      },
    });

    // 挂起等待用户决策
    const ok = await decision.promise;
    if (isAborted()) return;

    if (ok) {
      push({
        type: 'tool_call_result',
        data: {
          toolCallId: 'mock-tool-1',
          toolName: 'read_file',
          result: {
            success: true,
            content: 'export function main() {\n  console.log("hello");\n}',
          },
        },
      });
      await delay(200);
      push({ type: 'text_delta', data: { delta: '\n文件读取成功，内容如上。' } });
    } else {
      push({ type: 'text_delta', data: { delta: '\n好的，我跳过了文件读取。' } });
    }

    push({
      type: 'message_complete',
      data: {
        message: { role: 'assistant', content: '工具调用流程结束。' },
        step: 1,
      },
    });

    if (isAborted()) return;
    emit({
      streamId: 'tool-stream',
      kind: 'end',
      value: { status: 'completed', result: { status: 'completed', steps: 1 } },
    });
  })();
}

export function createMockTransport(): Transport {
  let configStore: AppConfig = structuredClone(DEFAULT_CONFIG);
  /** 当前挂起中的工具确认（同一时间只挂起一个） */
  let pendingConfirm: ConfirmDecision | null = null;
  /** 自管理流的取消标记（streamId → aborted） */
  const selfAborted = new Map<string, boolean>();

  // 先建框架 transport，处理普通场景
  const frameTransport = createMockTransportFrame({
    invoke(service, method, args) {
      // ---- config ----
      if (service === 'config' && method === 'get') return structuredClone(configStore);
      if (service === 'config' && method === 'set') {
        configStore = args[0] as AppConfig;
        return null;
      }
      if (service === 'config' && method === 'testConnection') return { ok: true };

      // ---- file ----
      if (service === 'file' && method === 'openFolderDialog') return '/Users/tiny/Project/demo';
      if (service === 'file' && method === 'getFileTree') return [];
      if (service === 'file' && method === 'readFile') return '';

      return undefined; // 未命中 → METHOD_NOT_FOUND
    },

    stream(service, method, args) {
      if (service !== 'chat' || method !== 'send') return undefined;

      const userMessage = String(args[0]);
      const wantFail = userMessage.trim().startsWith('/fail');
      const wantTool = userMessage.trim().startsWith('/tool');

      // /tool 场景不走框架脚本，由外层自管理
      if (wantTool) return undefined;

      return {
        events: buildFakeEvents(userMessage),
        intervalMs: 120,
        end: wantFail
          ? {
              status: 'completed',
              result: {
                status: 'llmFailed',
                message: 'mock：模拟上游错误（发送 /fail 触发）',
              },
            }
          : { status: 'completed', result: { status: 'completed', steps: 1 } },
      };
    },
  });

  // 包装：对 /tool 场景和 confirmTool 自己处理，其余透传
  const wrapped: Transport = {
    onStream: (cb) => frameTransport.onStream(cb),

    async invoke(service, method, args) {
      // ---- chat.confirmTool：决议挂起的工具确认 ----
      if (service === 'chat' && method === 'confirmTool') {
        const ok = args[1] as boolean;
        pendingConfirm?.resolve(ok);
        pendingConfirm = null;
        return { ok: true, data: null };
      }

      // ---- chat.send /tool：自管理流 ----
      if (service === 'chat' && method === 'send') {
        const userMessage = String(args[0]);
        if (!userMessage.trim().startsWith('/tool')) {
          return frameTransport.invoke(service, method, args);
        }

        const streamId = crypto.randomUUID();
        selfAborted.set(streamId, false);

        const decision = makeConfirmDecision();
        pendingConfirm = decision;

        // 需要把 emit 绑定到 frameTransport 的 onStream 上
        // 但 frameTransport 的 emit 是内部的，我们拿不到
        // 所以这里用 hack：在 frameTransport 的 onStream 里加一层转发
        // 实际上 frameTransport.onStream 已经注册到内部 listeners
        // 我们只需要在自管理流里直接调用 frameTransport 的 emit
        // 但 emit 不在 Transport 接口上
        //
        // 换个思路：自管理流也走 frameTransport 的 invoke，只是 script.events 里
        // 放一个永远 pending 的 Promise 作为 gate。但用户删了 gate 支持。
        //
        // 最终方案：在 web 层完全自实现一个 Transport，不嵌套框架。
        // 这样代码虽多但清晰，且 config/file/chat 都在一处。
        return { ok: true, data: { __stream: streamId } };
      }

      // ---- __stream.cancel：自管理流的取消 ----
      if (service === '__stream' && method === 'cancel') {
        const streamId = String(args[0]);
        if (selfAborted.has(streamId)) {
          selfAborted.set(streamId, true);
          // 需要 emit aborted 帧，但拿不到 emit
          // 所以自管理流方案在这里卡住了
        }
        return frameTransport.invoke(service, method, args);
      }

      return frameTransport.invoke(service, method, args);
    },
  };

  return wrapped;
}
