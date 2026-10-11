/**
 * RPC 客户端入口
 *
 * 环境检测：
 * - Electron：window.transport（preload 注入的哑管道）
 * - 纯浏览器：mock Transport（模拟主进程信封协议，UI 可独立调试）
 *
 * 业务代码统一用 `rpc.config.get()` / `rpc.chat.send()` 等类型化方法，
 * 不感知环境差异。
 */

import type { MainServices } from '@code-agent/shared';
import { createRpcClient, type StreamMethodsOf } from './client';
import { createMockTransport } from './mock';

const transport =
  typeof window !== 'undefined' && window.transport
    ? window.transport
    : createMockTransport();

// 流式方法运行时清单：契约里返回 RpcStream 的方法需要同步返回句柄。
// satisfies 对照契约类型推导：契约新增流式方法而清单漏登记时，编译报错。
const streamMethods = {
  config: {},
  chat: { send: true },
  file: {},
} satisfies StreamMethodsOf<MainServices>;

export const rpc: MainServices = createRpcClient<MainServices>(transport, streamMethods);

export default rpc;
