/**
 * RPC Router —— 纯逻辑核心（不 import electron）
 *
 * 职责：
 * - 服务注册表 + dispatch 分发（ipcMain.handle 只是一层薄皮，见 bindIpc.ts）
 * - 识别流式句柄 → 分配 streamId → 后台泵生成器逐帧推送
 * - 内置保留方法 __stream.cancel：句柄 abort() 的统一取消入口，不占用业务契约
 *
 * 泵与取消的状态机：
 *   dispatch 识别流句柄 → 注册表登记（streamId → StreamEntry）→ 立即返回 __stream
 *   → pump 后台循环 gen.next()，逐帧 emitter.send
 *   → 收尾三态：正常 return 帧 / 异常 throw 帧 / 取消 throw(ABORTED) 帧
 *   → 注册表清理，防泄漏
 */

import { randomUUID } from 'node:crypto';
import { RpcError } from '@code-agent/shared';
import type { RpcResponse, RpcStream, StreamEvent, StreamFrame } from '@code-agent/shared';

// ---- 推流接口（由宿主注入，Router 自身不依赖 Electron） ----

export interface StreamEmitter {
  send(frame: StreamFrame): void;
}

// ---- createRpcStream 内部状态（句柄与 Router 共享） ----

interface StreamState<E extends StreamEvent> {
  /** 被泵送的生成器 */
  gen: AsyncGenerator<E>;
  /** 取消标记：置位后 pump 丢弃残留值、不再推送任何帧 */
  cancelled: boolean;
  /** 取消钩子（onAbort 注册），由 Router 在取消时触发 */
  abortHooks: Array<() => void>;
  /** 由 Router 在登记时注入：句柄 abort() 的实际执行入口 */
  cancel?: () => void;
  /** 服务端本地旁路监听（on / once），事件主体仍推给渲染层 */
  eventListeners: Map<string, Set<(data: unknown) => void>>;
  /** 服务端本地旁路结束监听（onEnd） */
  endListeners: Set<(err?: RpcError) => void>;
}

/** 服务端流句柄：RpcStream 的服务端超集，额外暴露 onAbort 与内部状态 */
export interface ServerRpcStream<E extends StreamEvent> extends RpcStream<E> {
  /** 供服务桥接中断逻辑：句柄 abort() 时触发 */
  onAbort(cb: () => void): void;
  /** 内部标记与共享状态，业务代码不应使用 */
  readonly [STREAM_STATE]: StreamState<E>;
}

// 内部 marker symbol：dispatch 靠它识别"这是流句柄"，避免误判普通对象
const STREAM_STATE: unique symbol = Symbol('rpc.stream.state');

// Router 内置保留方法的服务名（不占用业务契约）
const STREAM_CONTROL_SERVICE = '__stream';

/**
 * 生成器 → 服务端流句柄适配器（唯一的适配入口，服务内不应绕过）
 *
 * - on / once / onEnd 为服务端本地旁路（可用于服务端日志）
 * - 事件主体由 Router 泵推给渲染层
 * - onAbort 注册取消钩子，供服务桥接中断逻辑（如 agent.abort()）
 */
export function createRpcStream<E extends StreamEvent>(gen: AsyncGenerator<E>): ServerRpcStream<E> {
  const state: StreamState<E> = {
    gen,
    cancelled: false,
    abortHooks: [],
    eventListeners: new Map(),
    endListeners: new Set(),
  };

  const handle: ServerRpcStream<E> = {
    [STREAM_STATE]: state,

    on(type, cb) {
      let set = state.eventListeners.get(type);
      if (!set) {
        set = new Set();
        state.eventListeners.set(type, set);
      }
      set.add(cb as (data: unknown) => void);
      return () => set!.delete(cb as (data: unknown) => void);
    },

    once(type, cb) {
      const off = handle.on(type, (data) => {
        off();
        cb(data);
      });
      return off;
    },

    onEnd(cb) {
      state.endListeners.add(cb);
      return () => state.endListeners.delete(cb);
    },

    // 取消链路的入口：Router 登记时注入 cancel 实现
    abort() {
      state.cancel?.();
    },

    onAbort(cb) {
      state.abortHooks.push(cb);
    },
  };

  return handle;
}

// ---- Router ----

/** 注册表条目：streamId → 泵送所需的一切 */
interface StreamEntry {
  state: StreamState<StreamEvent>;
  emitter: StreamEmitter;
}

export class RpcRouter {
  private services = new Map<string, Record<string, unknown>>();
  private streams = new Map<string, StreamEntry>();

  registerService(name: string, service: object): void {
    this.services.set(name, service as Record<string, unknown>);
  }

  /**
   * 核心入口：ipcMain.handle 只是一层薄皮
   * 错误一律走信封返回（D4），不向 IPC 层抛异常
   */
  async dispatch(
    service: string,
    method: string,
    args: unknown[],
    emitter: StreamEmitter,
  ): Promise<RpcResponse<unknown>> {
    // 保留方法：__stream.cancel(streamId)，句柄 abort() 的统一取消入口
    if (service === STREAM_CONTROL_SERVICE && method === 'cancel') {
      this.cancelStream(args[0] as string);
      return { ok: true, data: null };
    }

    const svc = this.services.get(service);
    if (!svc) {
      return {
        ok: false,
        error: { code: 'SERVICE_NOT_FOUND', message: `服务 "${service}" 未注册` },
      };
    }

    const handler = svc[method];
    if (typeof handler !== 'function') {
      return {
        ok: false,
        error: { code: 'METHOD_NOT_FOUND', message: `方法 "${service}.${method}" 不存在` },
      };
    }

    try {
      const result = await handler.apply(svc, args);

      // 流式判定：createRpcStream 产生的句柄（marker symbol 识别）
      if (isRpcStream(result)) {
        const state = result[STREAM_STATE];
        const streamId = randomUUID();
        state.cancel = () => this.cancelStream(streamId);
        this.streams.set(streamId, { state: state as StreamState<StreamEvent>, emitter });
        // 后台泵送，不阻塞本次响应
        void this.pump(streamId);
        return { ok: true, data: { __stream: streamId } };
      }

      return { ok: true, data: result };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'HANDLER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  /** 后台泵：把生成器逐帧推给渲染层，结束/异常/取消三态收尾 */
  private async pump(streamId: string): Promise<void> {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    const { state, emitter } = entry;

    try {
      for (;;) {
        const { value, done } = await state.gen.next();
        // 取消后：收尾帧已由 cancelStream 发出，残留值一律丢弃
        if (state.cancelled) return;

        if (done) {
          emitter.send({ streamId, kind: 'return' });
          notifyEnd(state, undefined);
          return;
        }

        emitter.send({ streamId, kind: 'next', value });
        notifyEvent(state, value);
      }
    } catch (err) {
      // 取消引发的生成器中断（gen.return 落定）不算异常
      if (state.cancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      emitter.send({ streamId, kind: 'throw', value: { code: 'HANDLER_ERROR', message } });
      notifyEnd(state, new RpcError('HANDLER_ERROR', message));
    } finally {
      this.streams.delete(streamId); // 注册表清理，防泄漏（双保险）
    }
  }

  /**
   * 取消链路：渲染层 stream.abort() → invoke('__stream','cancel',[id]) → 这里
   * 立即收尾：置位 cancelled → 释放生成器 → 触发 onAbort 钩子 → 推 throw(ABORTED) 帧
   */
  private cancelStream(streamId: string): void {
    const entry = this.streams.get(streamId);
    if (!entry) return; // 流已结束或不存在，幂等处理
    const { state, emitter } = entry;

    state.cancelled = true;
    // 释放生成器：若卡在 pending await，会在其落定后静默终止，不再产出
    void state.gen.return(undefined).catch(() => {});

    for (const hook of state.abortHooks) {
      try {
        hook();
      } catch {
        // 钩子异常不阻断取消链路
      }
    }

    emitter.send({
      streamId,
      kind: 'throw',
      value: { code: 'ABORTED', message: '流已取消' },
    });
    notifyEnd(state, new RpcError('ABORTED', '流已取消'));
    this.streams.delete(streamId);
  }
}

/** 流句柄识别：只认 createRpcStream 的 marker symbol */
function isRpcStream(value: unknown): value is ServerRpcStream<StreamEvent> {
  return typeof value === 'object' && value !== null && STREAM_STATE in value;
}

// ---- 服务端本地旁路通知（on / once / onEnd） ----

function notifyEvent<E extends StreamEvent>(state: StreamState<E>, event: E): void {
  const set = state.eventListeners.get(event.type);
  if (set) for (const cb of [...set]) cb(event.data);
}

function notifyEnd(state: StreamState<StreamEvent>, err?: RpcError): void {
  for (const cb of [...state.endListeners]) cb(err);
}
