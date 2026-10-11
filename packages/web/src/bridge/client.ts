/**
 * 类型化 RPC 客户端：双层 Proxy 在调用时拼出 service + method
 *
 * 运行时无完整方法清单（普通方法零注册）；唯一的运行时信息是 streamMethods：
 * 契约里返回 RpcStream 的流式方法必须同步返回句柄（用户要立刻 on 订阅），
 * 客户端据此在 invoke 响应到达前就创建句柄。清单在 bridge/index.ts 中
 * 用 satisfies 对照 MainServices，契约新增流式方法时编译期会逼着补清单。
 */

import { RpcError, type RpcStream, type Transport } from '@code-agent/shared';
import { RpcStreamImpl } from './stream';

/** 由契约类型推导出的"流式方法清单"形状（值必须为 true 字面量） */
export type StreamMethodsOf<Services> = {
  [S in keyof Services]: {
    [M in keyof Services[S] as Services[S][M] extends (...args: any[]) => RpcStream<any>
      ? M
      : never]: true;
  };
};

export function createRpcClient<Services extends object>(
  transport: Transport,
  streamMethods: Partial<Record<string, Partial<Record<string, true>>>>,
): Services {
  return new Proxy({} as Services, {
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
      if (!res.ok) throw new RpcError(res.error.code, res.error.message);
      const data = res.data;
      if (data && typeof data === 'object' && '__stream' in data) {
        return data as { __stream: string };
      }
      throw new RpcError('HANDLER_ERROR', `方法 ${service}.${method} 应返回流句柄`);
    });
    return new RpcStreamImpl(transport, init);
  }

  // 普通方法：还原信封，失败抛 RpcError（可 try/catch，code 可读）
  return request.then((res) => {
    if (!res.ok) throw new RpcError(res.error.code, res.error.message);
    return res.data;
  });
}
