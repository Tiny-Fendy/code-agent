/**
 * 通用 mock Transport 框架（@code-agent/rpc/mock）
 *
 * 只实现协议层的假传输：unary 信封、流式 next/end 帧推送、__stream.cancel 取消链路。
 * 业务场景（返回什么数据、推什么事件）由使用方通过 handlers 注入，
 * 供渲染层脱离主进程在纯浏览器里调试 UI（client + 句柄一行不改地跑在浏览器里）。
 *
 * 三种终局均可到达：
 * - 脚本事件推完 → end{completed | failed}（按脚本声明）
 * - 句柄 abort() → end{aborted}，泵送立即停止（重复取消幂等）
 */

import {
  RPC_ERROR,
  type RpcErrorInfo,
  type RpcResponse,
  type StreamEvent,
  type StreamFrame,
  type Transport,
} from '../protocol.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 一条流式调用的演出脚本：事件序列 + 唯一终局。
 * aborted 终局不通过脚本表达，由框架在取消时自发。
 */
export interface MockStreamScript<E extends StreamEvent = StreamEvent, R = unknown> {
  /** 按序推送的业务事件（可插入闸门项，见 MockStreamGate） */
  events: Array<E | MockStreamGate>;
  /** 事件推送间隔（ms），缺省不等待 */
  intervalMs?: number;
  /** 全部事件推完后的终局 */
  end: { status: 'completed'; result: R } | { status: 'failed'; error: RpcErrorInfo };
}

/**
 * 流中闸门（脚本项）：泵送遇到它时等待 promise settle 后继续推后续事件。
 * 用于模拟「等外部交互再继续」的业务时序（如工具确认流：confirm 决策后事件才继续）。
 *
 * 注意：若外部 promise 永不 settle（如用户取消后再无人决策），
 * 泵送协程会一直挂起——无副作用，只是不会推任何帧。
 */
export interface MockStreamGate {
  gate: PromiseLike<unknown>;
}

/** 构造一个闸门脚本项 */
export function mockGate(promise: PromiseLike<unknown>): MockStreamGate {
  return { gate: promise };
}

function isGate(item: MockStreamGate | unknown): item is MockStreamGate {
  return typeof item === 'object' && item !== null && 'gate' in item;
}

export interface MockTransportHandlers {
  /**
   * unary 业务分发：命中返回 data（异常会被兜底为 HANDLER_ERROR 信封）；
   * 返回 undefined 视为未命中 → METHOD_NOT_FOUND。
   */
  invoke?(service: string, method: string, args: unknown[]): unknown | Promise<unknown>;
  /** 流式业务分发：命中返回演出脚本；返回 undefined 继续走 unary 分发 */
  stream?(service: string, method: string, args: unknown[]): MockStreamScript | undefined;
}

export function createMockTransport(handlers: MockTransportHandlers): Transport {
  const listeners = new Set<(frame: StreamFrame) => void>();
  /** streamId → 是否被取消 */
  const aborted = new Map<string, boolean>();

  const emit = (frame: StreamFrame) => {
    for (const cb of listeners) cb(frame);
  };

  const pump = (streamId: string, script: MockStreamScript) => {
    void (async () => {
      for (const item of script.events) {
        // 闸门：等待外部信号（如确认决策）后再继续；settle 后若已取消则直接退出
        if (isGate(item)) {
          await item.gate;
          if (aborted.get(streamId)) return;
          continue;
        }
        if (script.intervalMs) await delay(script.intervalMs);
        if (aborted.get(streamId)) return; // 取消后停止泵送
        emit({ streamId, kind: 'next', value: item });
      }
      if (aborted.get(streamId)) return;
      emit({ streamId, kind: 'end', value: script.end });
    })();
  };

  return {
    onStream(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    async invoke(service, method, args): Promise<RpcResponse<unknown>> {
      try {
        // 保留方法：取消（对齐真实链路的 __stream.cancel）
        if (service === '__stream' && method === 'cancel') {
          const streamId = String(args[0]);
          if (aborted.get(streamId)) return { ok: true, data: null }; // 幂等
          aborted.set(streamId, true);
          emit({ streamId, kind: 'end', value: { status: 'aborted' } });
          return { ok: true, data: null };
        }

        // 流式方法：登记 streamId 并启动脚本泵，句柄经 invoke 响应同步拿到 id
        const script = handlers.stream?.(service, method, args);
        if (script) {
          const streamId = crypto.randomUUID();
          aborted.set(streamId, false);
          pump(streamId, script);
          return { ok: true, data: { __stream: streamId } };
        }

        // unary 方法
        const result = await handlers.invoke?.(service, method, args);
        if (result !== undefined) return { ok: true, data: result };

        return {
          ok: false,
          error: {
            code: RPC_ERROR.METHOD_NOT_FOUND,
            message: `mock 未实现 ${service}.${method}`,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: RPC_ERROR.HANDLER_ERROR,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  };
}
