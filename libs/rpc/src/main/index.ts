/**
 * 主进程面（@code-agent/rpc/main）
 *
 * - RpcRouter / createRpcStream / serviceNameOf：纯逻辑核心，不依赖 Electron，可独立单测
 * - bindIpc：Electron 薄适配层（ipcMain.handle ↔ Router.dispatch）
 */

export {
  RpcRouter,
  createRpcStream,
  serviceNameOf,
  type RpcRouterOptions,
  type ServerRpcStream,
  type StreamEmitter,
} from './Router.js';
export { bindIpc } from './bindIpc.js';
