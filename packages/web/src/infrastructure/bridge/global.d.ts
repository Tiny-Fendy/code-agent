/**
 * 全局 Window 类型声明
 *
 * preload 通过 contextBridge 注入 window.transport（哑管道，见 electron-main/src/preload）。
 * 纯浏览器环境下不存在，走 mock transport（见 infrastructure/bridge/mock.ts）。
 */

import type { Transport } from '@code-agent/rpc/protocol';

declare global {
  interface Window {
    transport?: Transport;
  }
}

export {};
