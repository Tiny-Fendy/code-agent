/**
 * 纯 Web 模式的 mock Transport（v2）
 *
 * 完全自实现 Transport 接口（invoke / onStream），不依赖 @code-agent/rpc/mock 框架，
 * 以便支持工具确认流的挂起-恢复时序。
 *
 * 三种终局均可触发：
 * - 默认：事件序列推完 → end{completed, result: SendResult.completed}
 * - 消息以 "/fail" 开头：推送事件后 end{completed, result: llmFailed}
 *   （对齐真实链路：Agent 的 LLM 失败是业务终局，随 completed 帧的 result 表达）
 * - 消息以 "/tool" 开头：模拟工具确认流——推 tool_call_start → tool_call_confirm，
 *   然后挂起等待 confirmTool 决策；放行推 tool_call_result，拒绝推文本说明。
 * - 调用句柄 abort()：end{aborted}，泵送立即停止
 */

import type { Transport, StreamFrame, RpcResponse } from '@code-agent/rpc/protocol';
import {
  DEFAULT_CONFIG,
  type AgentEvent,
  type AppConfig,
  type FileNode,
} from '@code-agent/contracts';

type SendResult =
  | { status: 'completed'; steps: number }
  | { status: 'finished'; steps: number; summary: string }
  | { status: 'llmFailed'; message: string }
  | { status: 'maxSteps'; steps: number }
  | { status: 'aborted' };

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

/** 工具确认流的挂起决策 */
interface ConfirmDecision {
  resolve: (ok: boolean) => void;
  promise: Promise<boolean>;
}

// ---- 假项目（纯浏览器调试文件树与预览） ----

const DEMO_ROOT = '/Users/tiny/Project/demo';

const FAKE_TREE: FileNode[] = [
  {
    name: 'src',
    path: `${DEMO_ROOT}/src`,
    type: 'directory',
    children: [
      { name: 'index.ts', path: `${DEMO_ROOT}/src/index.ts`, type: 'file' },
      { name: 'app.tsx', path: `${DEMO_ROOT}/src/app.tsx`, type: 'file' },
      { name: 'styles.css', path: `${DEMO_ROOT}/src/styles.css`, type: 'file' },
      {
        name: 'utils',
        path: `${DEMO_ROOT}/src/utils`,
        type: 'directory',
        children: [{ name: 'format.ts', path: `${DEMO_ROOT}/src/utils/format.ts`, type: 'file' }],
      },
    ],
  },
  { name: 'package.json', path: `${DEMO_ROOT}/package.json`, type: 'file' },
  { name: 'README.md', path: `${DEMO_ROOT}/README.md`, type: 'file' },
];

const FAKE_CONTENT: Record<string, string> = {
  [`${DEMO_ROOT}/src/index.ts`]: `import { createApp } from './app';

const app = createApp({ port: 3000 });

app.listen(() => {
  console.log('demo server started');
});
`,
  [`${DEMO_ROOT}/src/app.tsx`]: `import { useState } from 'react';

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <button onClick={() => setCount((c) => c + 1)}>
      点击次数：{count}
    </button>
  );
}
`,
  [`${DEMO_ROOT}/src/styles.css`]: `:root {
  --brand: #12b886;
}

.button {
  padding: 6px 14px;
  border-radius: 6px;
  background: var(--brand);
  color: #fff;
}
`,
  [`${DEMO_ROOT}/src/utils/format.ts`]: `export function formatBytes(bytes: number): string {
  if (bytes < 1024) return \`\${bytes} B\`;
  const kb = bytes / 1024;
  if (kb < 1024) return \`\${kb.toFixed(1)} KB\`;
  return \`\${(kb / 1024).toFixed(1)} MB\`;
}
`,
  [`${DEMO_ROOT}/package.json`]: `{
  "name": "demo",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build"
  }
}
`,
  [`${DEMO_ROOT}/README.md`]: `# Demo 项目

用于验证文件预览的假项目。

## 启动

\`\`\`bash
pnpm install
pnpm dev
\`\`\`

## 说明

- 文件内容全部来自 mock transport
- 仅支持只读预览
`,
};

function makeConfirmDecision(): ConfirmDecision {
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((r) => (resolve = r));
  return { resolve, promise };
}

export function createMockTransport(): Transport {
  let configStore: AppConfig = structuredClone(DEFAULT_CONFIG);
  let pendingConfirm: ConfirmDecision | null = null;

  const listeners = new Set<(frame: StreamFrame) => void>();
  /** streamId → 是否已取消 */
  const aborted = new Map<string, boolean>();

  const emit = (frame: StreamFrame) => {
    for (const cb of listeners) cb(frame);
  };

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** 泵送普通脚本事件 */
  const pumpScript = (
    streamId: string,
    events: AgentEvent[],
    intervalMs: number,
    end: { status: 'completed'; result: SendResult } | { status: 'failed'; error: { code: string; message: string } },
  ) => {
    void (async () => {
      for (const event of events) {
        if (intervalMs) await delay(intervalMs);
        if (aborted.get(streamId)) return;
        emit({ streamId, kind: 'next', value: event });
      }
      if (aborted.get(streamId)) return;
      emit({ streamId, kind: 'end', value: end });
    })();
  };

  /** 泵送工具确认流 */
  const pumpToolConfirm = (streamId: string, decision: ConfirmDecision) => {
    void (async () => {
      const push = (event: AgentEvent) => {
        if (aborted.get(streamId)) return;
        emit({ streamId, kind: 'next', value: event });
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
      if (aborted.get(streamId)) return;

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

      if (aborted.get(streamId)) return;
      emit({
        streamId,
        kind: 'end',
        value: { status: 'completed', result: { status: 'completed', steps: 1 } },
      });
    })();
  };

  return {
    onStream(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async invoke(service, method, args): Promise<RpcResponse<unknown>> {
      try {
        // ---- 保留方法：取消 ----
        if (service === '__stream' && method === 'cancel') {
          const streamId = String(args[0]);
          if (aborted.get(streamId)) return { ok: true, data: null }; // 幂等
          aborted.set(streamId, true);
          emit({ streamId, kind: 'end', value: { status: 'aborted' } });
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
          // 地址含 "invalid" 时模拟连接失败，便于验证表单内联错误分支
          if (configStore.api.baseUrl.includes('invalid')) {
            return { ok: true, data: { ok: false, error: 'mock：无法连接该地址' } };
          }
          return { ok: true, data: { ok: true } };
        }

        // ---- chat.confirmTool ----
        if (service === 'chat' && method === 'confirmTool') {
          const ok = args[1] as boolean;
          pendingConfirm?.resolve(ok);
          pendingConfirm = null;
          return { ok: true, data: null };
        }

        // ---- file ----
        if (service === 'file' && method === 'openFolderDialog') {
          return { ok: true, data: DEMO_ROOT };
        }
        if (service === 'file' && method === 'getFileTree') {
          // 深拷贝：避免 UI 侧对返回值的修改污染 mock 常量
          return { ok: true, data: structuredClone(FAKE_TREE) };
        }
        if (service === 'file' && method === 'readFile') {
          const filePath = String(args[0]);
          return {
            ok: true,
            data:
              FAKE_CONTENT[filePath] ??
              `// mock 模式：未内置该文件的假内容\n// ${filePath}\n`,
          };
        }

        // ---- chat.send：流式方法 ----
        if (service === 'chat' && method === 'send') {
          const userMessage = String(args[0]);
          const streamId = crypto.randomUUID();
          aborted.set(streamId, false);

          const wantFail = userMessage.trim().startsWith('/fail');
          const wantTool = userMessage.trim().startsWith('/tool');

          if (wantTool) {
            const decision = makeConfirmDecision();
            pendingConfirm = decision;
            pumpToolConfirm(streamId, decision);
          } else {
            pumpScript(streamId, buildFakeEvents(userMessage), 120, wantFail
              ? {
                  status: 'completed',
                  result: {
                    status: 'llmFailed',
                    message: 'mock：模拟上游错误（发送 /fail 触发）',
                  },
                }
              : { status: 'completed', result: { status: 'completed', steps: 1 } });
          }

          return { ok: true, data: { __stream: streamId } };
        }

        return {
          ok: false,
          error: {
            code: 'RPC_METHOD_NOT_FOUND',
            message: `mock 未实现 ${service}.${method}`,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'RPC_HANDLER_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  };
}
