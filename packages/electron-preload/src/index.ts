/**
 * Preload 脚本 —— 哑管道（D3）
 *
 * contextBridge 只快照 own properties，动态 Proxy 的 get 陷阱跨不过桥，
 * 因此类型化 Proxy 客户端放在 web 层；preload 只暴露两个与业务无关的原子函数：
 * - invoke:   单通道分发，载荷为 { service, method, args }
 * - onStream: 订阅主进程流式帧推送
 *
 * 新增任何服务方法，本文件零改动。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { RPC, type RpcRequest, type StreamFrame, type Transport } from '@code-agent/shared';

const transport: Transport = {
  invoke(service, method, args) {
    const req: RpcRequest = { service, method, args };
    return ipcRenderer.invoke(RPC.INVOKE, req);
  },

  onStream(cb) {
    const listener = (_event: unknown, frame: StreamFrame) => cb(frame);
    ipcRenderer.on(RPC.STREAM, listener);
    return () => {
      ipcRenderer.removeListener(RPC.STREAM, listener);
    };
  },
};

contextBridge.exposeInMainWorld('transport', transport);
