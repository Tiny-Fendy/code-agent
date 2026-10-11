/**
 * 纯 Web 模式的 mock Transport
 *
 * 直接模拟主进程侧的信封协议与流帧推送：client + RpcStreamImpl 一行不改地
 * 跑在浏览器里，UI 可脱离 Electron 调试（含假事件流与取消）。
 */

import {
  DEFAULT_CONFIG,
  type AgentEvent,
  type AppConfig,
  type RpcResponse,
  type StreamFrame,
  type Transport,
} from '@code-agent/shared';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 构造一条假的 Agent 事件序列：回显用户消息，模拟流式输出 */
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
  events.push({ type: 'done', data: { steps: 1 } });
  return events;
}

export function createMockTransport(): Transport {
  const listeners = new Set<(frame: StreamFrame) => void>();
  /** streamId → 是否被取消 */
  const aborted = new Map<string, boolean>();
  let configStore: AppConfig = structuredClone(DEFAULT_CONFIG);

  const emit = (frame: StreamFrame) => {
    for (const cb of listeners) cb(frame);
  };

  const pump = (streamId: string, events: AgentEvent[]) => {
    void (async () => {
      for (const event of events) {
        await delay(120);
        if (aborted.get(streamId)) return; // 取消后停止泵送
        emit({ streamId, kind: 'next', value: event });
      }
      if (!aborted.get(streamId)) emit({ streamId, kind: 'return' });
    })();
  };

  return {
    onStream(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    async invoke(service, method, args): Promise<RpcResponse<unknown>> {
      try {
        // 保留方法：取消
        if (service === '__stream' && method === 'cancel') {
          const streamId = String(args[0]);
          if (aborted.get(streamId)) return { ok: true, data: null }; // 幂等
          aborted.set(streamId, true);
          emit({ streamId, kind: 'throw', value: { code: 'ABORTED', message: '流已取消' } });
          return { ok: true, data: null };
        }

        // ---- config ----
        if (service === 'config' && method === 'get') {
          return { ok: true, data: structuredClone(configStore) };
        }
        if (service === 'config' && method === 'set') {
          configStore = args[0] as AppConfig;
          return { ok: true, data: null };
        }
        if (service === 'config' && method === 'testConnection') {
          return { ok: true, data: { ok: true } };
        }

        // ---- chat ----
        if (service === 'chat' && method === 'send') {
          const streamId = crypto.randomUUID();
          aborted.set(streamId, false);
          pump(streamId, buildFakeEvents(String(args[0])));
          return { ok: true, data: { __stream: streamId } };
        }
        if (service === 'chat' && method === 'confirmTool') {
          return { ok: true, data: null };
        }

        // ---- file ----
        if (service === 'file' && method === 'openFolderDialog') {
          return { ok: true, data: null };
        }
        if (service === 'file' && method === 'getFileTree') {
          return { ok: true, data: [] };
        }
        if (service === 'file' && method === 'readFile') {
          return { ok: true, data: '' };
        }

        return {
          ok: false,
          error: { code: 'METHOD_NOT_FOUND', message: `mock 未实现 ${service}.${method}` },
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: 'HANDLER_ERROR', message: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  };
}
