/**
 * 渲染层流句柄实现（消费端，v2）
 *
 * 关键时序：契约要求 send() 同步返回句柄（用户立刻 on 订阅），
 * 但 streamId 要等 invoke 响应回来才知道。解法：
 * 1. 构造时同步订阅全局 onStream —— 保证任何帧到达前监听已就位
 * 2. streamId 绑定前，所有帧先进 buffer，绑定后按序重放
 *
 * 终局：收到唯一 end 帧（completed / failed / aborted 三态）后
 * 自动退订全局监听并清空回调，无泄漏；晚订阅 onEnd 回放已存终局。
 */

import {
  RPC_ERROR,
  type RpcAbortSignal,
  type RpcStreamHandle,
  type StreamEnd,
  type StreamEvent,
  type StreamFrame,
  type Transport,
} from '../protocol.js';

/** init 成功后交给句柄的绑定信息 */
type StreamBinding = { __stream: string };

export class RpcStreamImpl<E extends StreamEvent, R = void> implements RpcStreamHandle<E, R> {
  private eventListeners = new Map<string, Set<(data: unknown) => void>>();
  private endListeners = new Set<(result: StreamEnd<R>) => void>();

  private streamId: string | null = null;
  private buffer: StreamFrame[] = [];
  private terminal: StreamEnd<R> | null = null;
  private pendingAbort = false;

  /** 句柄本地终局信号（D10b）：任何终局后 abort，reason 为终局结构 */
  private abortController = new AbortController();

  /** 外部联动 signal 的解绑集合，终局时统一移除 */
  private externalSignals = new Set<{ signal: RpcAbortSignal; listener: () => void }>();

  /** 退订全局帧通道；终局后置空 */
  private offTransport: (() => void) | null;

  constructor(
    private readonly transport: Transport,
    init: Promise<StreamBinding>,
  ) {
    // 第一步必须同步完成：订阅早于任何帧到达
    this.offTransport = this.transport.onStream((frame) => this.handleFrame(frame));

    init.then(
      (binding) => this.bind(binding.__stream),
      (err: unknown) =>
        this.finish({
          status: 'failed',
          error: {
            code: RPC_ERROR.HANDLER_ERROR,
            message: err instanceof Error ? err.message : String(err),
          },
        }),
    );
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  on<T extends E['type']>(
    type: T,
    cb: (data: Extract<E, { type: T }>['data']) => void,
  ): () => void {
    // 流已终局：业务事件不再可能到达，注册无意义
    if (this.terminal) return () => {};

    let set = this.eventListeners.get(type);
    if (!set) {
      set = new Set();
      this.eventListeners.set(type, set);
    }
    set.add(cb as (data: unknown) => void);
    return () => set!.delete(cb as (data: unknown) => void);
  }

  once<T extends E['type']>(
    type: T,
    cb: (data: Extract<E, { type: T }>['data']) => void,
  ): () => void {
    const off = this.on(type, (data) => {
      off();
      cb(data);
    });
    return off;
  }

  onEnd(cb: (result: StreamEnd<R>) => void): () => void {
    // 终局后晚订阅：终局是状态而非时刻，异步回放
    if (this.terminal) {
      const terminal = this.terminal;
      queueMicrotask(() => cb(terminal));
      return () => {};
    }
    this.endListeners.add(cb);
    return () => this.endListeners.delete(cb);
  }

  abort(): void {
    if (this.terminal) return;
    if (!this.streamId) {
      // id 还没绑定，绑定后立即补取消
      this.pendingAbort = true;
      return;
    }
    // 取消统一走 Router 内置保留方法，不进业务契约；
    // 终局由主进程回推 end{aborted} 收口，本端不抢先置终局
    void this.transport.invoke('__stream', 'cancel', [this.streamId]);
  }

  withAbortSignal(signal: RpcAbortSignal): () => void {
    // 外部已 abort：立即联动
    if (signal.aborted) {
      this.abort();
      return () => {};
    }
    const entry = {
      signal,
      listener: () => this.abort(),
    };
    signal.addEventListener('abort', entry.listener);
    this.externalSignals.add(entry);
    // 返回主动解绑；终局时也会自动移除
    return () => this.detachExternal(entry);
  }

  // ---- 内部 ----

  private bind(streamId: string): void {
    this.streamId = streamId;
    const pending = this.buffer;
    this.buffer = [];
    for (const frame of pending) this.handleFrame(frame);
    if (this.pendingAbort) this.abort();
  }

  private handleFrame(frame: StreamFrame): void {
    // id 未绑定：先缓存（宁缓勿丢）
    if (this.streamId === null) {
      this.buffer.push(frame);
      return;
    }
    // 只处理属于自己的帧
    if (frame.streamId !== this.streamId) return;

    if (frame.kind === 'next') {
      const event = frame.value as E | undefined;
      if (event) this.emitEvent(event);
      return;
    }

    // 唯一终局帧
    this.finish(frame.value as StreamEnd<R>);
  }

  private emitEvent(event: E): void {
    const set = this.eventListeners.get(event.type);
    if (set) for (const cb of [...set]) cb(event.data);
  }

  private finish(terminal: StreamEnd<R>): void {
    if (this.terminal) return; // 终局锁：first-wins，忽略迟到帧
    this.terminal = terminal;

    // 自动退订全局监听 + 清空业务回调，防泄漏
    this.offTransport?.();
    this.offTransport = null;
    this.eventListeners.clear();
    this.buffer = [];

    // 移除外部联动监听
    for (const entry of this.externalSignals) this.detachExternal(entry);
    this.externalSignals.clear();

    for (const cb of [...this.endListeners]) cb(terminal);
    this.endListeners.clear();

    // 本地信号终局（reason 携带终局结构，供 signal 消费方判别）
    this.abortController.abort(terminal);
  }

  private detachExternal(entry: { signal: RpcAbortSignal; listener: () => void }): void {
    entry.signal.removeEventListener('abort', entry.listener);
    this.externalSignals.delete(entry);
  }
}
