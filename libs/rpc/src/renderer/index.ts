/**
 * 渲染端面（@code-agent/rpc/renderer）
 *
 * - createRpcClient：双层 Proxy 类型化客户端（streamMethods 清单由宿主用 satisfies 对照契约）
 * - RpcStreamImpl：消费端流句柄实现（buffer 重放 / 终局自动清理），一般无需直接使用
 */

export { createRpcClient, type RpcClient, type StreamMethodsOf } from './client.js';
export { RpcStreamImpl } from './stream.js';
