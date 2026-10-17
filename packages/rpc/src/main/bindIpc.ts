/**
 * Electron 薄适配：ipcMain.handle ↔ RpcRouter（无业务逻辑）
 *
 * emitter 精确投递给发起本次 invoke 的窗口（event.sender），
 * 流泵在 handler 返回后仍持有 sender 引用；窗口关闭后投递静默丢弃。
 */

import { ipcMain, type WebContents } from 'electron';
import { RPC, type RpcRequest } from '@code-agent/shared';
import type { RpcRouter } from './Router';
import type { StreamEmitter } from './Router';

export function bindIpc(router: RpcRouter): void {
  ipcMain.handle(RPC.INVOKE, (event, req: RpcRequest) => {
    const sender: WebContents = event.sender;
    const emitter: StreamEmitter = {
      send(frame) {
        if (sender.isDestroyed()) return;
        sender.send(RPC.STREAM, frame);
      },
    };
    return router.dispatch(req.service, req.method, req.args, emitter);
  });
}
