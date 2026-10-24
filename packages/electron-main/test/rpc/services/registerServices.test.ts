/**
 * 服务组装根测试（镜像 src/rpc/services/index.ts）
 *
 * 契约关注点：三个服务按 serviceName 注册、配置在注册前已预载、
 * 注册名缺失或漂移会由 Router 直接 fail fast（这里用假 Router 观测注册入参）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger, MainServices } from '@code-agent/contracts';
import type { RpcRouter } from '@code-agent/rpc/main';
import type { ConfigServiceImpl } from '../../../src/rpc/services/ConfigServiceImpl';

// rpc/main 的 bindIpc 会 import electron；FileServiceImpl 也用 dialog
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
// 组装根只构造 ChatService，不触碰真实 Agent
vi.mock('@code-agent/agent-core', () => ({ Agent: class {} }));

import { registerServices } from '../../../src/rpc/services';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'code-agent-register-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function createRouterStub() {
  const registerAll = vi.fn();
  const router = { registerAll } as unknown as RpcRouter<MainServices>;
  return { router, registerAll };
}

describe('registerServices', () => {
  it('按 serviceName 注册 config / chat / file 三个服务', async () => {
    const { router, registerAll } = createRouterStub();

    await registerServices(router, dir, logger);

    expect(registerAll).toHaveBeenCalledTimes(1);
    const instances = registerAll.mock.calls[0][0] as Array<{ serviceName: string }>;
    expect(instances.map((instance) => instance.serviceName)).toEqual([
      'config',
      'chat',
      'file',
    ]);
  });

  it('注册前已预载磁盘配置（ChatService 同步构造 Agent 依赖缓存）', async () => {
    await writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ api: { model: 'preloaded-model' } }),
      'utf-8',
    );
    const { router, registerAll } = createRouterStub();

    await registerServices(router, dir, logger);

    const instances = registerAll.mock.calls[0][0] as ConfigServiceImpl[];
    await expect(instances[0].get()).resolves.toMatchObject({
      api: { model: 'preloaded-model' },
    });
  });
});
