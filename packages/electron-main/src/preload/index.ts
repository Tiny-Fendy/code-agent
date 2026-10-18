/**
 * Preload 脚本入口 —— 哑管道（D3）
 *
 * contextBridge 只快照 own properties，动态 Proxy 的 get 陷阱跨不过桥，
 * 因此类型化 Proxy 客户端放在 web 层（@code-agent/rpc/renderer）；
 * preload 只暴露两个与业务无关的原子函数：
 * - invoke:   单通道分发，载荷为 { service, method, args }
 * - onStream: 订阅主进程流式帧推送
 *
 * 实现已收口到 @code-agent/rpc/preload，新增任何服务方法，本文件零改动。
 */

import { exposeRpcTransport } from '@code-agent/rpc/preload';

exposeRpcTransport();
