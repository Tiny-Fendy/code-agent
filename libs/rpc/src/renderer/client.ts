/**
 * 类型化 RPC 客户端：双层 Proxy 在调用时拼出 service + method
 *
 * 运行时无完整方法清单（普通方法零注册）；唯一的运行时信息是 streamMethods：
 * 契约里返回 RpcStream 的流式方法必须同步返回句柄（用户要立刻 on 订阅），
 * 客户端据此在 invoke 响应到达前就创建句柄。清单在 bridge/index.ts 中
 * 用 satisfies 对照 MainServices，契约新增流式方法时编译期会逼着补清单。
 *
 * 类型映射：契约方法声明返回共同订阅面 RpcStream<E,R>（主进程 Sink 也满足），
 * 消费端实际拿到的是带取消能力的 RpcStreamHandle<E,R>，由 RpcClient 在类型层升级。
 */

import {
  RpcError,
  type RpcStream,
  type RpcStreamHandle,
  type Transport,
} from '../protocol.js';
import { RpcStreamImpl } from './stream.js';

/** 由契约类型推导出的"流式方法清单"形状（值必须为 true 字面量） */
export type StreamMethodsOf<Services> = {
  [S in keyof Services]: {
    [M in keyof Services[S] as Services[S][M] extends (...args: any[]) => RpcStream<any, any>
      ? M
      : never]: true;
  };
};

/**
 * 消费端视图：把契约中的 RpcStream 订阅面升级为带 abort / signal 的句柄，
 * 其余方法签名原样保留。
 */
export type RpcClient<Services> = {
  [S in keyof Services]: {
    [M in keyof Services[S]]: Services[S][M] extends (...args: infer Args) => infer Ret
      ? Ret extends RpcStream<infer E, infer R>
        ? (...args: Args) => RpcStreamHandle<E, R>
        : Services[S][M]
      : Services[S][M];
  };
};

export function createRpcClient<Services extends object>(
  transport: Transport,
  streamMethods: Partial<Record<string, Partial<Record<string, true>>>>,
): RpcClient<Services> {
  return new Proxy({} as RpcClient<Services>, {
    get(_target, service: string | symbol) {
      if (typeof service !== 'string') return undefined;
      return new Proxy({}, {
        get(_t, method: string | symbol) {
          if (typeof method !== 'string') return undefined;
          return (...args: unknown[]) => callMethod(transport, streamMethods, service, method, args);
        },
      });
    },
  });
}

function callMethod(
  transport: Transport,
  streamMethods: Partial<Record<string, Partial<Record<string, true>>>>,
  service: string,
  method: string,
  args: unknown[],
): unknown {
  const request = transport.invoke(service, method, args);

  // 流式方法：同步返回句柄，streamId 在 invoke 响应回来后绑定（见 RpcStreamImpl）
  if (streamMethods[service]?.[method]) {
    const init = request.then((res) => {
      if (!res.ok) throw new RpcError(res.error);
      const data = res.data;
      if (data && typeof data === 'object' && '__stream' in data) {
        return data as { __stream: string };
      }
      throw new RpcError({
        code: 'RPC_HANDLER_ERROR',
        message: `方法 ${service}.${method} 应返回流句柄`,
      });
    });
    return new RpcStreamImpl(transport, init);
  }

  // 普通方法：还原信封，失败抛 RpcError（可 try/catch，code/data 可读）
  return request.then((res) => {
    if (!res.ok) throw new RpcError(res.error);
    return res.data;
  });
}
