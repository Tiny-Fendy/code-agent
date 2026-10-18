/**
 * RPC Router —— 纯逻辑核心（不 import electron）
 *
 * 统一世界观（见 openspec/changes/rpc-communication-v2/design.md）：
 *   一次调用 = 建立 → 0..n 数据消息 → 恰好一个终局
 *
 * 职责：
 * - 服务注册表 + dispatch 分发（ipcMain.handle 只是一层薄皮，见 bindIpc.ts）
 * - 识别流式 Sink → 分配 streamId → 绑定 emitter；推模式直通 / 拉模式自动泵
 * - 终局状态机：open → closed(completed/failed/aborted)，同一把锁 first-wins
 * - 内置保留方法 __stream.cancel：取消的统一入口，不占用业务契约
 *
 * 泛型 TServices 为服务契约映射（应用侧传 MainServices）；本类不依赖任何业务类型。
 */

import { randomUUID } from 'node:crypto';
import { RPC_ERROR } from '../protocol.js';
import type {
  RpcErrorInfo,
  RpcResponse,
  RpcStreamSink,
  StreamEnd,
  StreamEvent,
  StreamFrame,
} from '../protocol.js';

// ---- 推流接口（由宿主注入，Router 自身不依赖 Electron） ----

export interface StreamEmitter {
  send(frame: StreamFrame): void;
}

// ---- Sink 内部状态 ----

type PendingFrame<E extends StreamEvent, R> =
  | { kind: 'next'; value: E }
  | { kind: 'end'; value: StreamEnd<R> };

interface StreamState<E extends StreamEvent, R> {
  phase: 'open' | 'closed';
  terminal?: StreamEnd<R>;
  /** 拉模式源；存在时绑定后启动自动泵 */
  gen?: AsyncGenerator<E, R>;
  streamId?: string;
  emitter?: StreamEmitter;
  /** 绑定 emitter 之前的早发帧（推模式源可能在 handler 返回前同步 emit） */
  pending: PendingFrame<E, R>[];
  /** 消费端取消钩子（onAbort 注册），仅 aborted 终局触发一次 */
  abortHooks: Array<() => void>;
  /** 服务端本地旁路监听（on / once），事件主体仍推给渲染层 */
  eventListeners: Map<string, Set<(data: unknown) => void>>;
  /** 服务端本地旁路终局监听（onEnd） */
  endListeners: Set<(result: StreamEnd<R>) => void>;
  /** 由 Router 在登记时注入：从注册表摘除本流 */
  cleanup?: () => void;
}

/**
 * 服务端流句柄：RpcStreamSink 的实体 + Router 识别用 marker。
 * 业务代码只按 Sink 接口使用，不访问 marker。
 */
export interface ServerRpcStream<E extends StreamEvent, R = void>
  extends RpcStreamSink<E, R> {
  /** 内部标记与共享状态，业务代码不应使用 */
  readonly [STREAM_STATE]: StreamState<E, R>;
}

// 内部 marker symbol：dispatch 靠它识别"这是流句柄"，避免误判普通对象
const STREAM_STATE: unique symbol = Symbol('rpc.stream.state');

// Router 内置保留方法的服务名（不占用业务契约）
const STREAM_CONTROL_SERVICE = '__stream';

// ---- 双形态工厂 ----

/**
 * 创建服务端流句柄（唯一的生产端适配入口，服务内不应绕过）。
 *
 * - 形态 A（推模式）：空参。业务在任意回调时机主动 emit / end / error，
 *   适合 child_process / pty 等回调源。
 * - 形态 B（拉模式）：传入 AsyncGenerator<E, R>。Router 自动泵：
 *   yield → next 帧；return R → end{completed, result:R}；throw → end{failed}。
 *
 * 两种形态返回同一种 Sink，取消 / 终局 / 本地旁路语义完全一致。
 */
export function createRpcStream<E extends StreamEvent, R = void>(
  gen?: AsyncGenerator<E, R>,
): ServerRpcStream<E, R> {
  const state: StreamState<E, R> = {
    phase: 'open',
    gen,
    pending: [],
    abortHooks: [],
    eventListeners: new Map(),
    endListeners: new Set(),
  };

  const handle: ServerRpcStream<E, R> = {
    [STREAM_STATE]: state,

    emit(event) {
      if (state.phase === 'closed') return false; // F13：终局后静默丢弃
      notifyEvent(state, event);
      deliver(state, { kind: 'next', value: event });
      return true;
    },

    end(result) {
      close(state, { status: 'completed', result: result as R });
    },

    error(error) {
      close(state, { status: 'failed', error });
    },

    onAbort(cb) {
      if (state.phase === 'open' && state.terminal?.status !== 'aborted') {
        state.abortHooks.push(cb);
      }
    },

    get aborted() {
      return state.terminal?.status === 'aborted';
    },

    get closed() {
      return state.phase === 'closed';
    },

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
      // 终局后晚订阅：终局是状态而非时刻，回放已存终局（异步，保持回调时序一致）
      if (state.phase === 'closed' && state.terminal) {
        const terminal = state.terminal;
        queueMicrotask(() => cb(terminal));
        return () => {};
      }
      state.endListeners.add(cb);
      return () => state.endListeners.delete(cb);
    },
  };

  return handle;
}

// ---- 状态机原语（模块级纯函数，便于泵与 Router 共用同一把锁） ----

/** 帧投递：已绑定 emitter 直发，否则进早发队列保序 */
function deliver<E extends StreamEvent, R>(
  state: StreamState<E, R>,
  frame: PendingFrame<E, R>,
): void {
  if (state.emitter && state.streamId !== undefined) {
    state.emitter.send(
      frame.kind === 'next'
        ? { streamId: state.streamId, kind: 'next', value: frame.value }
        : { streamId: state.streamId, kind: 'end', value: frame.value },
    );
  } else {
    state.pending.push(frame);
  }
}

/**
 * 终局锁：end / error / 取消 / 泵收尾四个入口唯一收口，first-wins。
 * 竞争失败（已 closed）静默 false；恰好产生一个 end 帧。
 */
function close<E extends StreamEvent, R>(
  state: StreamState<E, R>,
  terminal: StreamEnd<R>,
): boolean {
  if (state.phase === 'closed') return false;
  state.phase = 'closed';
  state.terminal = terminal;

  deliver(state, { kind: 'end', value: terminal });

  for (const cb of [...state.endListeners]) cb(terminal);
  // 终局即清理：释放所有订阅引用，防泄漏
  state.endListeners.clear();
  state.eventListeners.clear();
  state.abortHooks.length = 0;
  state.cleanup?.();
  return true;
}

/** 消费端取消入口：触发钩子 + 释放生成器 + aborted 终局（终局锁兜底竞态） */
function performAbort<E extends StreamEvent, R>(state: StreamState<E, R>): void {
  if (state.phase === 'closed') return;
  if (state.gen) void state.gen.return(undefined as R).catch(() => {});
  for (const hook of state.abortHooks) {
    try {
      hook();
    } catch {
      // 钩子异常不阻断取消链路
    }
  }
  close(state, { status: 'aborted' });
}

/** 拉模式自动泵（仅形态 B） */
async function pump<E extends StreamEvent, R>(state: StreamState<E, R>): Promise<void> {
  const gen = state.gen;
  if (!gen) return;
  try {
    while (state.phase === 'open') {
      const { value, done } = await gen.next();
      // await 期间可能已被取消 / 终局：锁会挡下后续收尾，这里直接退出
      if (state.phase !== 'open') return;
      if (done) {
        close(state, { status: 'completed', result: value });
        return;
      }
      notifyEvent(state, value);
      deliver(state, { kind: 'next', value });
    }
  } catch (err) {
    if (state.phase !== 'open') return;
    const info: RpcErrorInfo = {
      code: RPC_ERROR.HANDLER_ERROR,
      message: err instanceof Error ? err.message : String(err),
    };
    close(state, { status: 'failed', error: info });
  }
}

// ---- 注册收口（D12a） ----

const SERVICE_IMPL_SUFFIX = 'ServiceImpl';

/**
 * 实现类名 → 契约键：`ChatServiceImpl` → `chat`。
 * 无 ServiceImpl 后缀时退化为首字母小写。
 */
export function serviceNameOf(className: string): string {
  const stripped = className.endsWith(SERVICE_IMPL_SUFFIX)
    ? className.slice(0, -SERVICE_IMPL_SUFFIX.length)
    : className;
  if (stripped.length === 0) return stripped;
  return stripped.charAt(0).toLowerCase() + stripped.slice(1);
}

// ---- Router ----

export interface RpcRouterOptions<K extends string> {
  /**
   * 契约键白名单（D12a 运行时保险）：registerAll 推导出的名字不在其中即 fail fast。
   * 传字面量数组以获得编译期校验：(keyof MainServices)[]。
   */
  serviceKeys?: ReadonlyArray<K>;
}

export class RpcRouter<
  // 不施加 Record 约束：interface 形式的服务契约（如 MainServices）没有隐式索引签名。
  // 默认值用 any 值类型，保证无契约泛型的中立用法可直接 registerAll(任意类实例)；
  // 应用侧传入 MainServices 后，实例类型即受契约联合严格约束。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TServices = Record<string, any>,
> {
  private services = new Map<string, Record<string, unknown>>();
  private streams = new Map<string, StreamState<StreamEvent, unknown>>();
  private serviceKeys: ReadonlySet<string>;

  constructor(options: RpcRouterOptions<keyof TServices & string> = {}) {
    this.serviceKeys = new Set(options.serviceKeys ?? []);
  }

  /** 注册服务：name 与实例同时受契约映射约束（编译期对齐，禁止名字与实现漂移） */
  registerService<K extends keyof TServices & string>(
    name: K,
    service: TServices[K],
  ): void {
    this.services.set(name, service as Record<string, unknown>);
  }

  /**
   * 组装根统一入口（D12a）：传入实现实例数组，注册名由类名机械推导，零手写字符串。
   * 推导名不在 serviceKeys 白名单内时同步 throw（fail fast）。
   */
  registerAll(instances: ReadonlyArray<TServices[keyof TServices]>): void {
    for (const instance of instances) {
      const name = serviceNameOf((instance as object).constructor.name);
      if (this.serviceKeys.size > 0 && !this.serviceKeys.has(name)) {
        throw new Error(
          `registerAll：类 "${(instance as object).constructor.name}" 推导出的服务名 "${name}" 不在契约键白名单中`,
        );
      }
      this.services.set(name, instance as Record<string, unknown>);
    }
  }

  /**
   * 核心入口：ipcMain.handle 只是一层薄皮。
   * 错误一律走信封返回，不向 IPC 层抛异常；
   * 流建立后的失败一律走 end{failed}，不经信封。
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
        error: { code: RPC_ERROR.SERVICE_NOT_FOUND, message: `服务 "${service}" 未注册` },
      };
    }

    const handler = svc[method];
    if (typeof handler !== 'function') {
      return {
        ok: false,
        error: { code: RPC_ERROR.METHOD_NOT_FOUND, message: `方法 "${service}.${method}" 不存在` },
      };
    }

    let result: unknown;
    try {
      result = await handler.apply(svc, args);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: RPC_ERROR.HANDLER_ERROR,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // 流式判定：createRpcStream 产生的 Sink（marker symbol 识别）
    if (isRpcStream(result)) {
      const streamId = randomUUID();
      const state = result[STREAM_STATE] as StreamState<StreamEvent, unknown>;

      state.streamId = streamId;
      state.emitter = emitter;
      state.cleanup = () => this.streams.delete(streamId);
      this.streams.set(streamId, state);

      // 先冲刷早发帧（handler 内同步 emit/end 的保序内容）
      this.flushPending(state, streamId, emitter);

      // 拉模式：后台泵，不阻塞本次响应；推模式：无泵，业务自行推
      if (state.gen) void pump(state);

      return { ok: true, data: { __stream: streamId } };
    }

    return { ok: true, data: result };
  }

  private flushPending(
    state: StreamState<StreamEvent, unknown>,
    streamId: string,
    emitter: StreamEmitter,
  ): void {
    if (state.pending.length === 0) return;
    const queued = state.pending.splice(0);
    for (const frame of queued) {
      emitter.send(
        frame.kind === 'next'
          ? { streamId, kind: 'next', value: frame.value }
          : { streamId, kind: 'end', value: frame.value },
      );
    }
  }

  /**
   * 取消链路：渲染层 stream.abort() → invoke('__stream','cancel',[id]) → 这里。
   * 流已终局 / 不存在时幂等 no-op，绝不产生第二个 end 帧。
   */
  private cancelStream(streamId: string): void {
    const state = this.streams.get(streamId);
    if (!state) return;
    performAbort(state);
  }
}

/** 流句柄识别：只认 createRpcStream 的 marker symbol */
function isRpcStream(value: unknown): value is ServerRpcStream<StreamEvent, unknown> {
  return typeof value === 'object' && value !== null && STREAM_STATE in value;
}

// ---- 服务端本地旁路通知（on / once） ----

function notifyEvent<E extends StreamEvent, R>(state: StreamState<E, R>, event: E): void {
  const set = state.eventListeners.get(event.type);
  if (set) for (const cb of [...set]) cb(event.data);
}
