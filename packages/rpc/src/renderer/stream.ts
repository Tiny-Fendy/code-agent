/**
 * 渲染层流句柄实现
 *
 * 关键时序问题：契约要求 send() 同步返回句柄（用户立刻 on 订阅），
 * 但 streamId 要等 invoke 响应回来才知道。解法：
 * 1. 构造时同步订阅全局 onStream —— 保证任何帧到达前监听已就位
 * 2. streamId 绑定前，所有帧先进 buffer
 * 3. init resolve 后绑定 id，重放 buffer 中属于自己的帧
 *
 * 结束（return / throw）后自动退订全局监听并清空回调，无泄漏。
 */

import {
  RpcError,
  type RpcStream,
  type StreamEvent,
  type StreamFrame,
  type Transport,
} from '@code-agent/shared';

/** init 成功后交给句柄的绑定信息 */
type StreamBinding = { __stream: string };

export class RpcStreamImpl<E extends StreamEvent> implements RpcStream<E> {
  private eventListeners = new Map<string, Set<(data: unknown) => void>>();
  private endListeners = new Set<(err?: RpcError) => void>();

  private streamId: string | null = null;
  private buffer: StreamFrame[] = [];
  private ended = false;
  private endError?: RpcError;
  private pendingAbort = false;

  /** 退订全局帧通道；结束后置空 */
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
        this.finish(err instanceof RpcError ? err : new RpcError('HANDLER_ERROR', String(err))),
    );
  }

  on<T extends E['type']>(
    type: T,
    cb: (data: Extract<E, { type: T }>['data']) => void,
  ): () => void {
    // 流已结束：业务事件不再可能到达，注册无意义，直接返回 noop 退订
    if (this.ended) return () => {};

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

  onEnd(cb: (err?: RpcError) => void): () => void {
    // 已结束后订阅：立即回调终态（便于晚注册场景）
    if (this.ended) {
      queueMicrotask(() => cb(this.endError));
      return () => {};
    }
    this.endListeners.add(cb);
    return () => this.endListeners.delete(cb);
  }

  abort(): void {
    if (this.ended) return;
    if (!this.streamId) {
      // id 还没绑定，绑定后立即补取消
      this.pendingAbort = true;
      return;
    }
    // 取消统一走 Router 内置保留方法，不进业务契约
    void this.transport.invoke('__stream', 'cancel', [this.streamId]);
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

    if (frame.kind === 'return') {
      this.finish(undefined);
      return;
    }

    // throw 帧：信封错误还原为 RpcError
    const errInfo = (frame.value ?? {}) as { code?: string; message?: string };
    this.finish(new RpcError(
      errInfo.code === 'ABORTED' ? 'ABORTED' : 'HANDLER_ERROR',
      errInfo.message ?? '流异常结束',
    ));
  }

  private emitEvent(event: E): void {
    const set = this.eventListeners.get(event.type);
    if (set) for (const cb of [...set]) cb(event.data);
  }

  private finish(err?: RpcError): void {
    if (this.ended) return;
    this.ended = true;
    this.endError = err;

    // 自动退订全局监听 + 清空业务回调，防泄漏
    this.offTransport?.();
    this.offTransport = null;
    this.eventListeners.clear();

    for (const cb of [...this.endListeners]) cb(err);
    this.endListeners.clear();
    this.buffer = [];
  }
}
