/**
 * Router 单元测试 v2（不启动 Electron）
 *
 * 运行：pnpm --filter @code-agent/rpc test
 *
 * 覆盖 check.md 第 2 节：
 * - Unary 信封 / 新错误码
 * - 推模式 Sink（形态 A）与拉模式 generator（形态 B）
 * - 终局状态机：唯一 end 帧、first-wins、终局后丢弃、取消幂等
 * - 注册收口 registerAll（读取 serviceName 字段）与白名单
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RPC_ERROR } from '../../src/protocol';
import type { StreamEnd, StreamEvent, StreamFrame } from '../../src/protocol';
import {
  RpcRouter,
  createRpcStream,
  type ServerRpcStream,
  type StreamEmitter,
} from '../../src/main/Router';

// ---- 假 emitter：记录所有推送帧 ----
function makeEmitter(): StreamEmitter & { frames: StreamFrame[] } {
  const frames: StreamFrame[] = [];
  return {
    frames,
    send(frame) {
      frames.push(structuredClone(frame));
    },
  };
}

// 等句柄本地旁路终局， resolve 终局结果
function waitForEnd<R = unknown>(
  handle: ServerRpcStream<StreamEvent, R>,
): Promise<StreamEnd<R>> {
  return new Promise((resolve) => {
    handle.onEnd(resolve);
  });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function* genOf(events: StreamEvent[]): AsyncGenerator<StreamEvent, void> {
  for (const e of events) yield e;
}

async function* genWithResult(
  events: StreamEvent[],
  result: { steps: number },
): AsyncGenerator<StreamEvent, { steps: number }> {
  for (const e of events) yield e;
  return result;
}

type EndFrame = Extract<StreamFrame, { kind: 'end' }>;

// ---- 假服务 ----
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandle = ServerRpcStream<StreamEvent, any>;

function makeService() {
  const pushHandles: AnyHandle[] = [];
  const service = {
    add: (a: number, b: number) => a + b,
    echoObject: () => ({ x: 1, nested: { y: [1, 2] } }),
    echoNull: () => null,
    boom: () => {
      throw new Error('boom');
    },
    asyncBoom: async () => {
      throw new Error('async boom');
    },
    // 形态 B：拉模式，无结果值
    stream: (events: StreamEvent[]) => {
      const handle = createRpcStream(genOf(events));
      pushHandles.push(handle);
      return handle;
    },
    // 形态 B：带 completed 结果
    streamWithResult: (events: StreamEvent[]) => {
      const handle = createRpcStream(genWithResult(events, { steps: events.length }));
      pushHandles.push(handle);
      return handle;
    },
    // 形态 B：generator 内部抛异常
    throwingStream: () => {
      const handle = createRpcStream(
        (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: 'a', data: 1 };
          throw new Error('gen boom');
        })(),
      );
      pushHandles.push(handle);
      return handle;
    },
    // 形态 A：推模式，暴露句柄供测试后续操作（R=unknown，终局可带任意结果）
    push: () => {
      const handle = createRpcStream<StreamEvent, unknown>();
      pushHandles.push(handle);
      return handle;
    },
    // 形态 A：handler 返回前同步 emit + end（早发帧保序）
    pushImmediate: () => {
      const handle = createRpcStream<StreamEvent, string>();
      handle.emit({ type: 'a', data: 1 });
      handle.emit({ type: 'b', data: 2 });
      handle.end('done');
      return handle;
    },
  };
  return { service, pushHandles };
}

function setup() {
  const router = new RpcRouter();
  const { service, pushHandles } = makeService();
  router.registerService('demo', service as never);
  const emitter = makeEmitter();
  return { router, emitter, pushHandles };
}

async function dispatchStream(
  router: RpcRouter,
  emitter: StreamEmitter,
  service: string,
  method: string,
  args: unknown[] = [],
): Promise<string> {
  const res = await router.dispatch(service, method, args, emitter);
  if (!res.ok) throw new Error('应当成功');
  return (res.data as { __stream: string }).__stream;
}

// ============ Unary ============

test('普通方法：返回 { ok: true, data }，参数逐个展开传入', async () => {
  const { router, emitter } = setup();
  const res = await router.dispatch('demo', 'add', [2, 3], emitter);
  assert.deepEqual(res, { ok: true, data: 5 });
  assert.equal(emitter.frames.length, 0);
});

test('返回值原样出现在 data 中（对象 / null）', async () => {
  const { router, emitter } = setup();
  assert.deepEqual(await router.dispatch('demo', 'echoObject', [], emitter), {
    ok: true,
    data: { x: 1, nested: { y: [1, 2] } },
  });
  assert.deepEqual(await router.dispatch('demo', 'echoNull', [], emitter), {
    ok: true,
    data: null,
  });
});

test('错误信封使用新机制码 RPC_*，异常不逃逸 dispatch', async () => {
  const { router, emitter } = setup();

  const s = await router.dispatch('nope', 'x', [], emitter);
  assert.equal(s.ok, false);
  if (s.ok) throw new Error('应当失败');
  assert.equal(s.error.code, RPC_ERROR.SERVICE_NOT_FOUND);

  const m = await router.dispatch('demo', 'missing', [], emitter);
  if (m.ok) throw new Error('应当失败');
  assert.equal(m.error.code, RPC_ERROR.METHOD_NOT_FOUND);

  for (const method of ['boom', 'asyncBoom'] as const) {
    const r = await router.dispatch('demo', method, [], emitter);
    if (r.ok) throw new Error('应当失败');
    assert.equal(r.error.code, RPC_ERROR.HANDLER_ERROR);
    assert.match(r.error.message, /boom/);
  }
});

// ============ 形态 B：拉模式 ============

test('拉模式：next 帧序列 + 唯一 end{completed}（无结果值）', async () => {
  const { router, emitter, pushHandles } = setup();
  const events: StreamEvent[] = [
    { type: 'a', data: 1 },
    { type: 'b', data: 'two' },
  ];

  const streamId = await dispatchStream(router, emitter, 'demo', 'stream', [events]);
  const end = await waitForEnd(pushHandles[0]);

  assert.deepEqual(end, { status: 'completed', result: undefined });
  assert.deepEqual(emitter.frames, [
    { streamId, kind: 'next', value: { type: 'a', data: 1 } },
    { streamId, kind: 'next', value: { type: 'b', data: 'two' } },
    { streamId, kind: 'end', value: { status: 'completed', result: undefined } },
  ]);
});

test('拉模式：generator return R → end{completed, result:R}', async () => {
  const { router, emitter, pushHandles } = setup();
  const streamId = await dispatchStream(router, emitter, 'demo', 'streamWithResult', [
    [{ type: 'a', data: 1 }],
  ]);

  const end = await waitForEnd(pushHandles[1] ?? pushHandles[0]);
  assert.deepEqual(end, { status: 'completed', result: { steps: 1 } });

  const last = emitter.frames.at(-1) as EndFrame;
  assert.equal(last.kind, 'end');
  assert.deepEqual(last.value, { status: 'completed', result: { steps: 1 } });
  assert.equal(last.streamId, streamId);
});

test('拉模式：generator throw → end{failed, RPC_HANDLER_ERROR}，本地旁路收到同一终局', async () => {
  const { router, emitter, pushHandles } = setup();
  await dispatchStream(router, emitter, 'demo', 'throwingStream');

  const end = await waitForEnd(pushHandles.at(-1)!);
  assert.equal(end.status, 'failed');
  if (end.status !== 'failed') throw new Error('类型收窄');
  assert.equal(end.error.code, RPC_ERROR.HANDLER_ERROR);
  assert.equal(end.error.message, 'gen boom');

  assert.deepEqual(emitter.frames, [
    {
      streamId: emitter.frames[0].streamId,
      kind: 'next',
      value: { type: 'a', data: 1 },
    },
    {
      streamId: emitter.frames[0].streamId,
      kind: 'end',
      value: { status: 'failed', error: { code: RPC_ERROR.HANDLER_ERROR, message: 'gen boom' } },
    },
  ]);
});

// ============ 形态 A：推模式 ============

test('推模式：emit 推 next；end(R) 是唯一终局帧；本地 on 旁路同步收到', async () => {
  const { router, emitter, pushHandles } = setup();
  const seen: unknown[] = [];

  const streamId = await dispatchStream(router, emitter, 'demo', 'push');
  const sink = pushHandles.at(-1)!;
  sink.on('a', (data) => seen.push(data));

  assert.equal(sink.emit({ type: 'a', data: 42 }), true);
  sink.end('ok');
  const end = await waitForEnd(sink);

  assert.deepEqual(seen, [42]);
  assert.deepEqual(end, { status: 'completed', result: 'ok' });
  assert.deepEqual(emitter.frames, [
    { streamId, kind: 'next', value: { type: 'a', data: 42 } },
    { streamId, kind: 'end', value: { status: 'completed', result: 'ok' } },
  ]);
});

test('推模式：error(业务码) → end{failed}，业务码原样到达', async () => {
  const { router, emitter, pushHandles } = setup();
  await dispatchStream(router, emitter, 'demo', 'push');
  const sink = pushHandles.at(-1)!;

  sink.emit({ type: 'a', data: 1 });
  sink.error({ code: 'chat.LLM_FAILED', message: '上游 401', data: { httpStatus: 401 } });
  const end = await waitForEnd(sink);

  assert.deepEqual(end, {
    status: 'failed',
    error: { code: 'chat.LLM_FAILED', message: '上游 401', data: { httpStatus: 401 } },
  });
  const last = emitter.frames.at(-1) as EndFrame;
  assert.deepEqual(last.value, {
    status: 'failed',
    error: { code: 'chat.LLM_FAILED', message: '上游 401', data: { httpStatus: 401 } },
  });
});

test('推模式：handler 返回前同步 emit/end 的早发帧保序到达，且仍只有一个 end', async () => {
  const { router, emitter } = setup();
  const streamId = await dispatchStream(router, emitter, 'demo', 'pushImmediate');

  assert.deepEqual(emitter.frames, [
    { streamId, kind: 'next', value: { type: 'a', data: 1 } },
    { streamId, kind: 'next', value: { type: 'b', data: 2 } },
    { streamId, kind: 'end', value: { status: 'completed', result: 'done' } },
  ]);
});

// ============ 终局状态机 ============

test('终局后 emit 返回 false 且数据被丢弃；重复 end 静默 no-op', async () => {
  const { router, emitter, pushHandles } = setup();
  const streamId = await dispatchStream(router, emitter, 'demo', 'push');
  const sink = pushHandles.at(-1)!;

  sink.end('first');
  assert.equal(sink.closed, true);
  assert.equal(sink.emit({ type: 'late', data: 9 }), false);
  sink.end('second');
  sink.error({ code: 'x', message: 'late error' });

  await flush();
  assert.deepEqual(emitter.frames, [
    { streamId, kind: 'end', value: { status: 'completed', result: 'first' } },
  ]);
});

test('end 先于 cancel：completed 胜出，迟到 cancel 幂等无第二帧', async () => {
  const { router, emitter, pushHandles } = setup();
  const streamId = await dispatchStream(router, emitter, 'demo', 'push');
  const sink = pushHandles.at(-1)!;
  let hookCount = 0;
  sink.onAbort(() => hookCount++);

  sink.end('done');
  const cancelRes = await router.dispatch('__stream', 'cancel', [streamId], emitter);
  assert.deepEqual(cancelRes, { ok: true, data: null });

  assert.equal(hookCount, 0, '已终局不再触发取消钩子');
  assert.equal(sink.aborted, false);
  assert.equal(emitter.frames.length, 1);
  assert.deepEqual((emitter.frames[0] as EndFrame).value, {
    status: 'completed',
    result: 'done',
  });
});

test('cancel 先于 end：aborted 胜出，钩子触发一次，后续 end 无效', async () => {
  const { router, emitter, pushHandles } = setup();
  const streamId = await dispatchStream(router, emitter, 'demo', 'push');
  const sink = pushHandles.at(-1)!;
  let hookCount = 0;
  sink.onAbort(() => hookCount++);

  await router.dispatch('__stream', 'cancel', [streamId], emitter);
  assert.equal(sink.aborted, true);
  assert.equal(sink.closed, true);
  sink.end('late');
  sink.emit({ type: 'late', data: 1 });

  const end = await waitForEnd(sink);
  assert.deepEqual(end, { status: 'aborted' });
  assert.equal(hookCount, 1);
  assert.deepEqual(emitter.frames, [
    { streamId, kind: 'end', value: { status: 'aborted' } },
  ]);
});

test('拉模式取消：泵终止 + aborted 终局 + 钩子一次 + 迟到残留值丢弃 + 重复取消幂等', async () => {
  const router = new RpcRouter();
  const emitter = makeEmitter();
  let hookCount = 0;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  async function* gatedGen(): AsyncGenerator<StreamEvent> {
    yield { type: 'a', data: 1 };
    await gate;
    yield { type: 'b', data: 2 };
  }

  const handle = createRpcStream(gatedGen());
  handle.onAbort(() => hookCount++);
  router.registerService('demo', { gated: () => handle } as never);

  const streamId = await dispatchStream(router, emitter, 'demo', 'gated');
  await flush();
  await flush();
  assert.deepEqual(emitter.frames, [
    { streamId, kind: 'next', value: { type: 'a', data: 1 } },
  ]);

  await router.dispatch('__stream', 'cancel', [streamId], emitter);
  assert.equal(hookCount, 1);

  // 释放卡住的生成器：泵落定后 aborted 已胜出，b 与 completed 都不得出现
  releaseGate();
  await flush();
  await flush();
  assert.deepEqual(emitter.frames, [
    { streamId, kind: 'next', value: { type: 'a', data: 1 } },
    { streamId, kind: 'end', value: { status: 'aborted' } },
  ]);

  // 重复取消：注册表已清理，幂等无帧
  await router.dispatch('__stream', 'cancel', [streamId], emitter);
  assert.equal(emitter.frames.length, 2);
});

test('取消不存在 / 已终局的流：no-op，不报错', async () => {
  const { router, emitter } = setup();
  const r = await router.dispatch('__stream', 'cancel', ['no-such-id'], emitter);
  assert.deepEqual(r, { ok: true, data: null });
  assert.equal(emitter.frames.length, 0);
});

test('两个流并发：streamId 不同，帧与终局互不串扰', async () => {
  const router = new RpcRouter();
  const emitter = makeEmitter();

  const h1 = createRpcStream(genOf([{ type: 'x', data: 1 }]));
  const h2 = createRpcStream(genWithResult([{ type: 'y', data: 2 }], { steps: 1 }));
  router.registerService('s1', { go: () => h1 } as never);
  router.registerService('s2', { go: () => h2 } as never);

  const [r1, r2] = await Promise.all([
    dispatchStream(router, emitter, 's1', 'go'),
    dispatchStream(router, emitter, 's2', 'go'),
  ]);
  assert.notEqual(r1, r2);

  await Promise.all([waitForEnd(h1 as ServerRpcStream<StreamEvent>), waitForEnd(h2 as ServerRpcStream<StreamEvent, { steps: number }>)]);

  const byStream = (id: string) => emitter.frames.filter((f) => f.streamId === id);
  assert.deepEqual(byStream(r1), [
    { streamId: r1, kind: 'next', value: { type: 'x', data: 1 } },
    { streamId: r1, kind: 'end', value: { status: 'completed', result: undefined } },
  ]);
  assert.deepEqual(byStream(r2), [
    { streamId: r2, kind: 'next', value: { type: 'y', data: 2 } },
    { streamId: r2, kind: 'end', value: { status: 'completed', result: { steps: 1 } } },
  ]);
});

test('多次调用产生不同 streamId', async () => {
  const { router, emitter, pushHandles } = setup();
  const ids = new Set<string>();
  for (let i = 0; i < 3; i++) {
    ids.add(await dispatchStream(router, emitter, 'demo', 'stream', [[{ type: 'a', data: i }]]));
    await waitForEnd(pushHandles[i]);
  }
  assert.equal(ids.size, 3);
});

// ============ 注册收口 ============

test('registerAll：读取 serviceName 字段注册，服务可分发', async () => {
  const router = new RpcRouter({ serviceKeys: ['demo'] });

  class DemoServiceImpl {
    readonly serviceName = 'demo' as const;
    ping() {
      return 'pong';
    }
  }
  router.registerAll([new DemoServiceImpl()]);

  const emitter = makeEmitter();
  const res = await router.dispatch('demo', 'ping', [], emitter);
  assert.deepEqual(res, { ok: true, data: 'pong' });
});

test('registerAll：实例缺少 serviceName 字段 → 同步 throw（fail fast）', () => {
  const router = new RpcRouter();

  class NoNameService {
    x() {
      return 1;
    }
  }
  assert.throws(() => router.registerAll([new NoNameService()]), /缺少 serviceName/);
});

test('registerAll：serviceName 不在白名单 → 同步 throw（fail fast）', () => {
  const router = new RpcRouter({ serviceKeys: ['demo'] });

  class UnknownServiceImpl {
    readonly serviceName = 'unknown' as const;
    x() {
      return 1;
    }
  }
  assert.throws(() => router.registerAll([new UnknownServiceImpl()]), /不在契约键白名单中/);
});

test('registerAll：无白名单时不做运行时拦截（机制库中立用法）', async () => {
  const router = new RpcRouter();
  class FooServiceImpl {
    readonly serviceName = 'foo' as const;
    x() {
      return 1;
    }
  }
  router.registerAll([new FooServiceImpl()]);
  const emitter = makeEmitter();
  assert.deepEqual(await router.dispatch('foo', 'x', [], emitter), { ok: true, data: 1 });
});
