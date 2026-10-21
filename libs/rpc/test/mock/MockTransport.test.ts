/**
 * mock Transport 闸门能力测试
 *
 * 覆盖：gate 前事件正常推、gate 挂起期间不推、settle 后继续推 + 正常终局、
 * gate 挂起期间取消 → aborted 终局且 settle 后不再推帧。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockTransport, mockGate, type MockStreamScript } from '../../src/mock/index.js';
import type { StreamEvent, StreamFrame } from '../../src/protocol.js';

interface Ev extends StreamEvent {
  type: string;
}

/** 事件帧摘要：next → 事件 type，end → end:{status} */
function summarize(frames: StreamFrame[]): string[] {
  return frames.map((f) =>
    f.kind === 'next' ? f.value.type : `end:${f.value.status}`,
  );
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeScript(gatePromise: Promise<unknown>): MockStreamScript<Ev, unknown> {
  return {
    events: [{ type: 'a' }, mockGate(gatePromise), { type: 'b' }],
    intervalMs: 10,
    end: { status: 'completed', result: null },
  };
}

test('gate 挂起期间不推帧，settle 后继续推并正常终局', async () => {
  let release!: () => void;
  const gatePromise = new Promise<unknown>((r) => (release = r));

  const transport = createMockTransport({ stream: () => makeScript(gatePromise) });
  const frames: StreamFrame[] = [];
  transport.onStream((f) => frames.push(f));
  void transport.invoke('s', 'm', []);

  await delay(60); // 'a'（10ms 间隔）已推，gate 挂起中
  assert.deepEqual(summarize(frames), ['a']);

  release();
  await delay(60); // 'b' + end
  assert.deepEqual(summarize(frames), ['a', 'b', 'end:completed']);
});

test('gate 挂起期间取消 → aborted 终局，settle 后不再推帧', async () => {
  let release!: () => void;
  const gatePromise = new Promise<unknown>((r) => (release = r));

  const transport = createMockTransport({ stream: () => makeScript(gatePromise) });
  const frames: StreamFrame[] = [];
  transport.onStream((f) => frames.push(f));

  // 从 invoke 响应里拿 streamId（对齐句柄建立链路）
  const res = await transport.invoke('s', 'm', []);
  assert.ok(res.ok);
  const streamId = (res.data as { __stream: string }).__stream;

  await delay(60);
  assert.deepEqual(summarize(frames), ['a']);

  await transport.invoke('__stream', 'cancel', [streamId]);
  assert.deepEqual(summarize(frames), ['a', 'end:aborted']);

  release(); // 迟到的 settle 不应再推任何帧
  await delay(60);
  assert.deepEqual(summarize(frames), ['a', 'end:aborted']);
});
