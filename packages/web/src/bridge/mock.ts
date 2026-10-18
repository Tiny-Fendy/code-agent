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
 * - 调用句柄 abort()：end{aborted}，泵送立即停止
 */

import { createMockTransport as createMockTransportFrame } from '@code-agent/rpc/mock';
import type { Transport } from '@code-agent/rpc/protocol';
import {
  DEFAULT_CONFIG,
  type AgentEvent,
  type AppConfig,
} from '@code-agent/contracts';

/** 构造一条假的 Agent 事件序列：回显用户消息，模拟流式输出（不含终局事件） */
function buildFakeEvents(userMessage: string): AgentEvent[] {
  const reply = `收到你的消息：「${userMessage}」\n我是 mock 模式下的假 Agent，用于在浏览器里调试 UI。`;
  // 切成小块，模拟 token 流
  const chunks: string[] = [];
  for (let i = 0; i < reply.length; i += 4) chunks.push(reply.slice(i, i + 4));

  const events: AgentEvent[] = chunks.map((delta) => ({ type: 'text_delta', data: { delta } }));
  events.push({
    type: 'message_complete',
    data: { message: { role: 'assistant', content: reply }, step: 1 },
  });
  return events;
}

export function createMockTransport(): Transport {
  let configStore: AppConfig = structuredClone(DEFAULT_CONFIG);

  return createMockTransportFrame({
    invoke(service, method, args) {
      // ---- config ----
      if (service === 'config' && method === 'get') return structuredClone(configStore);
      if (service === 'config' && method === 'set') {
        configStore = args[0] as AppConfig;
        return null;
      }
      if (service === 'config' && method === 'testConnection') return { ok: true };

      // ---- chat（unary 部分）----
      if (service === 'chat' && method === 'confirmTool') return null;

      // ---- file ----
      if (service === 'file' && method === 'openFolderDialog') return null;
      if (service === 'file' && method === 'getFileTree') return [];
      if (service === 'file' && method === 'readFile') return '';

      return undefined; // 未命中 → METHOD_NOT_FOUND
    },

    stream(service, method, args) {
      if (service !== 'chat' || method !== 'send') return undefined;

      const userMessage = String(args[0]);
      const wantFail = userMessage.trim().startsWith('/fail');
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
}
