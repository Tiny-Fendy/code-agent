/**
 * RPC 通信协议 v2
 *
 * 统一世界观（见 electron-main/openspec/changes/rpc-communication-v2/design.md）：
 *   一次调用 = 建立 → 0..n 数据消息 → 恰好一个终局
 * - Unary：0 条数据消息，invoke 响应信封本身即终局
 * - Server Streaming：0..n 个 next 帧 + 恰好 1 个 end 帧（三态：completed/failed/aborted）
 *
 * 核心决策：
 * - 单通道 dispatch + 信封：invoke 通道只有一个，方法定位靠载荷里的 service + method
 * - 错误是数据：RpcErrorInfo 单源，unary 信封与流终局同形状，不依赖跨进程 Error
 * - 终局是通道状态而不是异常：aborted 独立成态，不借用错误码
 */

// ---- 两个固定通道 ----
export const RPC = {
  /** 渲染层 → 主进程，单通道分发 */
  INVOKE: 'rpc:invoke',
  /** 主进程 → 渲染层，事件流推送（next / end 帧按 streamId 多路复用） */
  STREAM: 'rpc:stream',
} as const;

// ---- 请求载荷（ipcRenderer.invoke 的第二个参数） ----
export interface RpcRequest {
  service: string;
  method: string;
  args: unknown[];
}

/**
 * 原子传输接口（preload 哑管道，Proxy 在 web 层）
 * preload 负责实现，web 负责消费；新增任何服务方法，preload 零改动
 */
export interface Transport {
  invoke(service: string, method: string, args: unknown[]): Promise<RpcResponse<unknown>>;
  /** 订阅主进程流式帧推送，返回退订函数 */
  onStream(cb: (frame: StreamFrame) => void): () => void;
}

// ---- 统一错误结构 ----

/**
 * 机制保留错误码（D11）：占用 RPC_ 前缀保留段，业务码禁止此前缀。
 * 业务码约定带服务前缀（如 chat.LLM_FAILED），为自由字符串。
 */
export const RPC_ERROR = {
  SERVICE_NOT_FOUND: 'RPC_SERVICE_NOT_FOUND',
  METHOD_NOT_FOUND: 'RPC_METHOD_NOT_FOUND',
  HANDLER_ERROR: 'RPC_HANDLER_ERROR',
} as const;

export type RpcReservedErrorCode = (typeof RPC_ERROR)[keyof typeof RPC_ERROR];

/** 跨进程传输的结构化错误：unary 信封与流终局共用，单源定义（F22） */
export interface RpcErrorInfo {
  /** 机制码（RPC_*）或业务自定义码（约定服务前缀，如 chat.LLM_FAILED） */
  code: string;
  message: string;
  /** 结构化附加信息，必须可结构化克隆 */
  data?: unknown;
}

export type RpcResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: RpcErrorInfo };

/**
 * 渲染层拆信封时抛出的异常（throwable 包装）。
 * 线上传输的只有 RpcErrorInfo；本类仅存活于进程本地。
 */
export class RpcError extends Error {
  readonly code: string;
  readonly data?: unknown;

  constructor(info: RpcErrorInfo) {
    super(info.message);
    this.name = 'RpcError';
    this.code = info.code;
    this.data = info.data;
  }

  toInfo(): RpcErrorInfo {
    return { code: this.code, message: this.message, data: this.data };
  }
}

// ---- 流式帧（两态：数据帧 + 唯一终局帧） ----

/** 流的终局结果：穷尽三态（F9），消费端必须显式处理（或显式忽略）每一种 */
export type StreamEnd<R> =
  | { status: 'completed'; result: R }
  | { status: 'failed'; error: RpcErrorInfo }
  | { status: 'aborted' };

export type StreamFrame<E extends StreamEvent = StreamEvent, R = unknown> =
  | { streamId: string; kind: 'next'; value: E }
  | { streamId: string; kind: 'end'; value: StreamEnd<R> };

// ---- 流式事件基类型与句柄接口 ----
export interface StreamEvent {
  type: string;
  data?: unknown;
}

/**
 * AbortSignal 的结构子集（D10b）。
 * shared 包保持平台中立（lib 仅 ES2022，零运行时依赖），不引用 DOM / Node 全局；
 * 标准 AbortSignal（浏览器与 Node 18+）结构上满足本接口，可直接传入。
 */
export interface RpcAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/**
 * 流句柄的共同订阅面：契约中流式方法的返回类型。
 * 生产端 Sink 与消费端 Handle 都继承它，但角色能力互不相同——
 * 契约只描述"这是一条事件流及其终局类型"，不暴露任何一侧的专有能力。
 */
export interface RpcStream<E extends StreamEvent, R = void> {
  /** 订阅业务事件，返回退订函数 */
  on<T extends E['type']>(
    type: T,
    cb: (data: Extract<E, { type: T }>['data']) => void,
  ): () => void;
  /** 订阅一次，触发后自动退订 */
  once<T extends E['type']>(
    type: T,
    cb: (data: Extract<E, { type: T }>['data']) => void,
  ): () => void;
  /** 唯一终局入口：穷尽三态的判别结构（F9） */
  onEnd(cb: (result: StreamEnd<R>) => void): () => void;
}

/**
 * 生产端流句柄 Sink（F1–F5）：推模式 API，业务可在任意回调时机主动调用。
 * 主进程服务持有它；marker symbol 由 Router 内部附加，业务不感知。
 */
export interface RpcStreamSink<E extends StreamEvent, R = void> extends RpcStream<E, R> {
  /** 推数据：open 时返回 true；终局后数据被丢弃并返回 false（F13） */
  emit(event: E): boolean;
  /** 正常结束，可携带终局结果；first-wins，重复调用静默无效 */
  end(result?: R): void;
  /** 失败结束，携带结构化错误；first-wins */
  error(error: RpcErrorInfo): void;
  /** 注册消费端取消钩子（如 kill 子进程 / agent.abort()） */
  onAbort(cb: () => void): void;
  /** 消费端是否已取消 */
  readonly aborted: boolean;
  /** 是否已到达任一终局 */
  readonly closed: boolean;
}

/**
 * 渲染层拿到的流句柄（消费端视图）：订阅 / 取消与 React 生命周期对应。
 * 客户端 Proxy 把契约中的 RpcStream 返回类型映射成本接口（见 RpcClient）。
 */
export interface RpcStreamHandle<E extends StreamEvent, R = void> extends RpcStream<E, R> {
  /** 取消该流（取消是终局的一种，不是异常抛出） */
  abort(): void;
  /** 句柄终局信号：completed / failed / aborted 后均 abort（D10b，本地对象，不跨进程） */
  readonly signal: RpcAbortSignal;
  /**
   * 绑定外部 AbortSignal 联动取消（D10b）：外部 abort 等价于调用本句柄 abort()。
   * 返回解绑函数；流终局后监听自动移除。纯客户端行为，不产生 IPC 参数。
   */
  withAbortSignal(signal: RpcAbortSignal): () => void;
}
