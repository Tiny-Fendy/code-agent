/**
 * Router 单元测试（不启动 Electron）
 *
 * 运行：npx tsx --test src/rpc/Router.test.ts
 *
 * 用假服务 + 假 emitter 覆盖 check.md 第 2 节：
 * 分发信封、handler 异常、流式 next/return/throw 三态、取消链路、注册表清理、并发隔离
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StreamEvent, StreamFrame } from '@code-agent/shared';
import { RpcRouter, createRpcStream, type StreamEmitter, type ServerRpcStream } from './Router';

// ---- 假 emitter：记录所有推送帧 ----
function makeEmitter(): StreamEmitter & { frames: StreamFrame[] } {
  const frames: StreamFrame[] = [];
  return {
    frames,
    send(frame) {
      // 深拷贝，避免后续 mutate 干扰断言
      frames.push(structuredClone(frame));
    },
  };
}

// 等待流在服务端本地旁路收尾（句柄 onEnd 是本地旁路，可直接 await）
function waitForEnd(handle: ServerRpcStream<StreamEvent>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    handle.onEnd((err) => (err ? reject(err) : resolve(undefined)));
  });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// 按给定事件序列造生成器
async function* genOf(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

// ---- 假服务（工厂）：streamHandles 暴露被 dispatch 实际泵送的句柄 ----
function makeService() {
  const streamHandles: ServerRpcStream<StreamEvent>[] = [];
  const service = {
    // 参数逐个展开传入
    add: (a: number, b: number) => a + b,
    // 各种返回值原样出现在 data 中
    echoObject: () => ({ x: 1, nested: { y: [1, 2] } }),
    echoArray: () => [1, 'a', true],
    echoNull: () => null,
    // handler 抛异常
    boom: () => {
      throw new Error('boom');
    },
    // 异步 handler 抛异常
    asyncBoom: async () => {
      throw new Error('async boom');
    },
    // 流式方法
    stream: (events: StreamEvent[]) => {
      const handle = createRpcStream(genOf(events));
      streamHandles.push(handle);
      return handle;
    },
    // 生成器内部抛异常的流式方法
    throwingStream: () => {
      const handle = createRpcStream(
        (async function* () {
          yield { type: 'a', data: 1 };
          throw new Error('gen boom');
        })(),
      );
      streamHandles.push(handle);
      return handle;
    },
  };
  return { service, streamHandles };
}

function setup() {
  const router = new RpcRouter();
  const { service, streamHandles } = makeService();
  router.registerService('demo', service);
  const emitter = makeEmitter();
  return { router, emitter, streamHandles };
}

// ---- 分发：成功 ----

test('普通方法：返回 { ok: true, data }，参数逐个展开传入', async () => {
  const { router, emitter } = setup();
  const res = await router.dispatch('demo', 'add', [2, 3], emitter);
  assert.deepEqual(res, { ok: true, data: 5 });
  // 非流式调用不推帧
  assert.equal(emitter.frames.length, 0);
});

test('返回值原样出现在 data 中（对象 / 数组 / null）', async () => {
  const { router, emitter } = setup();
  assert.deepEqual(await router.dispatch('demo', 'echoObject', [], emitter), {
    ok: true,
    data: { x: 1, nested: { y: [1, 2] } },
  });
  assert.deepEqual(await router.dispatch('demo', 'echoArray', [], emitter), {
    ok: true,
    data: [1, 'a', true],
  });
  assert.deepEqual(await router.dispatch('demo', 'echoNull', [], emitter), {
    ok: true,
    data: null,
  });
});

// ---- 分发：错误信封 ----

test('未注册的服务返回 SERVICE_NOT_FOUND', async () => {
  const { router, emitter } = setup();
  const res = await router.dispatch('nope', 'x', [], emitter);
  assert.equal(res.ok, false);
  if (res.ok) throw new Error('应当是失败信封');
  assert.equal(res.error.code, 'SERVICE_NOT_FOUND');
});

test('不存在的方法返回 METHOD_NOT_FOUND', async () => {
  const { router, emitter } = setup();
  const res = await router.dispatch('demo', 'missing', [], emitter);
  assert.equal(res.ok, false);
  if (res.ok) throw new Error('应当是失败信封');
  assert.equal(res.error.code, 'METHOD_NOT_FOUND');
});

test('handler 同步 / 异步抛异常都返回 HANDLER_ERROR，不逃逸 dispatch', async () => {
  const { router, emitter } = setup();
  for (const method of ['boom', 'asyncBoom'] as const) {
    const res = await router.dispatch('demo', method, [], emitter);
    assert.equal(res.ok, false);
    if (res.ok) throw new Error('应当是失败信封');
    assert.equal(res.error.code, 'HANDLER_ERROR');
    assert.match(res.error.message, /boom/);
  }
});

// ---- 流式 ----

test('流式方法：先返回 __stream，再按序收到 next 帧，最后 return 帧', async () => {
  const { router, emitter, streamHandles } = setup();
  const events: StreamEvent[] = [
    { type: 'a', data: 1 },
    { type: 'b', data: 'two' },
  ];

  const res = await router.dispatch('demo', 'stream', [events], emitter);
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('应当成功');
  const streamId = (res.data as { __stream: string }).__stream;
  assert.ok(typeof streamId === 'string' && streamId.length > 0);

  await waitForEnd(streamHandles[0]);

  assert.deepEqual(emitter.frames, [
    { streamId, kind: 'next', value: { type: 'a', data: 1 } },
    { streamId, kind: 'next', value: { type: 'b', data: 'two' } },
    { streamId, kind: 'return' },
  ]);
});

test('多次调用产生不同的 streamId', async () => {
  const { router, emitter, streamHandles } = setup();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await router.dispatch('demo', 'stream', [[{ type: 'a', data: i }]], emitter);
    if (!res.ok) throw new Error('应当成功');
    ids.push((res.data as { __stream: string }).__stream);
    await waitForEnd(streamHandles[i]);
  }
  assert.equal(new Set(ids).size, 3);
});

test('生成器抛异常：推送 throw 帧（HANDLER_ERROR），本地 onEnd 收到 RpcError', async () => {
  const { router, emitter, streamHandles } = setup();
  const res = await router.dispatch('demo', 'throwingStream', [], emitter);
  if (!res.ok) throw new Error('应当成功');
  const streamId = (res.data as { __stream: string }).__stream;

  await assert.rejects(() => waitForEnd(streamHandles[0]), (err: unknown) => {
    return err instanceof Error && (err as { code?: string }).code === 'HANDLER_ERROR';
  });

  assert.deepEqual(emitter.frames, [
    { streamId, kind: 'next', value: { type: 'a', data: 1 } },
    { streamId, kind: 'throw', value: { code: 'HANDLER_ERROR', message: 'gen boom' } },
  ]);
});

test('__stream.cancel：泵终止 + throw(ABORTED) 帧 + onAbort 钩子触发 + 无残留帧', async () => {
  const router = new RpcRouter();
  const emitter = makeEmitter();

  let aborted = false;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });

  async function* gatedGen(): AsyncGenerator<StreamEvent> {
    yield { type: 'a', data: 1 };
    await gate; // 卡在第二帧之前
    yield { type: 'b', data: 2 };
  }

  const handle = createRpcStream(gatedGen());
  handle.onAbort(() => {
    aborted = true;
  });

  router.registerService('demo', {
    gated: () => handle,
  });

  const res = await router.dispatch('demo', 'gated', [], emitter);
  if (!res.ok) throw new Error('应当成功');
  const streamId = (res.data as { __stream: string }).__stream;

  // 等第一帧推完（泵正卡在 gate）
  await flush();
  await flush();
  assert.deepEqual(emitter.frames, [{ streamId, kind: 'next', value: { type: 'a', data: 1 } }]);

  // 走与渲染层完全相同的取消入口
  const cancelRes = await router.dispatch('__stream', 'cancel', [streamId], emitter);
  assert.deepEqual(cancelRes, { ok: true, data: null });
  assert.equal(aborted, true, 'onAbort 钩子应被调用');

  // throw(ABORTED) 收尾
  assert.deepEqual(emitter.frames, [
    { streamId, kind: 'next', value: { type: 'a', data: 1 } },
    { streamId, kind: 'throw', value: { code: 'ABORTED', message: '流已取消' } },
  ]);

  // 释放 gate：取消后的残留值必须被丢弃，不再产生任何帧
  releaseGate();
  await flush();
  await flush();
  assert.equal(emitter.frames.length, 2, '取消后不再推送任何帧');

  // 重复取消幂等（注册表已清理），不产生新帧
  await router.dispatch('__stream', 'cancel', [streamId], emitter);
  assert.equal(emitter.frames.length, 2);
});

test('两个流并发：帧的 streamId 互不混淆，各自正常收尾', async () => {
  const router = new RpcRouter();
  const emitter = makeEmitter();

  const handles1: ServerRpcStream<StreamEvent>[] = [];
  const handles2: ServerRpcStream<StreamEvent>[] = [];
  router.registerService('s1', {
    go: () => {
      const h = createRpcStream(genOf([{ type: 'x', data: 1 }]));
      handles1.push(h);
      return h;
    },
  });
  router.registerService('s2', {
    go: () => {
      const h = createRpcStream(genOf([{ type: 'y', data: 2 }, { type: 'z', data: 3 }]));
      handles2.push(h);
      return h;
    },
  });

  const [r1, r2] = await Promise.all([
    router.dispatch('s1', 'go', [], emitter),
    router.dispatch('s2', 'go', [], emitter),
  ]);
  if (!r1.ok || !r2.ok) throw new Error('都应当成功');
  const id1 = (r1.data as { __stream: string }).__stream;
  const id2 = (r2.data as { __stream: string }).__stream;
  assert.notEqual(id1, id2);

  await Promise.all([waitForEnd(handles1[0]), waitForEnd(handles2[0])]);

  const byStream = (id: string) => emitter.frames.filter((f) => f.streamId === id);
  assert.deepEqual(byStream(id1), [
    { streamId: id1, kind: 'next', value: { type: 'x', data: 1 } },
    { streamId: id1, kind: 'return' },
  ]);
  assert.deepEqual(byStream(id2), [
    { streamId: id2, kind: 'next', value: { type: 'y', data: 2 } },
    { streamId: id2, kind: 'next', value: { type: 'z', data: 3 } },
    { streamId: id2, kind: 'return' },
  ]);
});
