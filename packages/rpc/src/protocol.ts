/**
 * RPC 通信协议
 *
 * 核心决策（见 electron-main/openspec/changes/rpc-communication/design.md）：
 * - D2 单通道 dispatch + 信封：invoke 通道只有一个，方法定位靠载荷里的 service + method，
 *   新增服务方法不需要新通道
 * - D4 错误走信封（数据），不走 IPC reject：invoke 跨进程后 Error 会丢字段
 * - D5 流式 = streamId + 推送通道，模拟 gRPC server-streaming
 */

// ---- 两个固定通道 ----
export const RPC = {
  /** 渲染层 → 主进程，单通道分发 */
  INVOKE: 'rpc:invoke',
  /** 主进程 → 渲染层，事件流推送 */
  STREAM: 'rpc:stream',
} as const;

// ---- 请求载荷（ipcRenderer.invoke 的第二个参数） ----
export interface RpcRequest {
  service: string;
  method: string;
  args: unknown[];
}

/**
 * 原子传输接口（D3：preload 哑管道，Proxy 在 web 层）
 * preload 负责实现，web 负责消费；新增任何服务方法，preload 零改动
 */
export interface Transport {
  invoke(service: string, method: string, args: unknown[]): Promise<RpcResponse<unknown>>;
  /** 订阅主进程流式帧推送，返回退订函数 */
  onStream(cb: (frame: StreamFrame) => void): () => void;
}

// ---- 响应信封 ----
export type RpcErrorCode =
  | 'SERVICE_NOT_FOUND'
  | 'METHOD_NOT_FOUND'
  | 'HANDLER_ERROR'
  | 'ABORTED';

export type RpcResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: RpcErrorCode; message: string; data?: unknown } };

/**
 * 还原后的业务错误（信封 ok:false 抛出的异常形态）
 * 定义在 shared 侢单源复用：主进程构造信封、渲染层还原异常共用同一个 code 体系
 */
export class RpcError extends Error {
  constructor(
    public code: RpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

// ---- 流式帧 ----
/**
 * StreamFrame.kind 驱动渲染层句柄的事件分发与结束：
 * - next   → on 回调
 * - return → onEnd()
 * - throw  → onEnd(RpcError)
 */
export interface StreamFrame {
  streamId: string;
  kind: 'next' | 'return' | 'throw';
  value?: unknown;
}

// ---- 流式事件基类型与句柄接口（流式方法在契约中的返回类型） ----
export interface StreamEvent {
  type: string;
  data?: unknown;
}

/**
 * 渲染层拿到的流句柄（D7：事件句柄，非 AsyncGenerator）
 * 订阅 / 退订 / 取消与 React 生命周期一一对应
 */
export interface RpcStream<E extends StreamEvent> {
  /** 订阅业务事件，返回退订函数 */
  on<T extends E['type']>(type: T, cb: (data: Extract<E, { type: T }>['data']) => void): () => void;
  /** 订阅一次，触发后自动退订 */
  once<T extends E['type']>(
    type: T,
    cb: (data: Extract<E, { type: T }>['data']) => void,
  ): () => void;
  /** 流生命周期：正常结束 cb()；异常结束（含取消）cb(RpcError) */
  onEnd(cb: (err?: RpcError) => void): () => void;
  /** 取消该流 */
  abort(): void;
}
