/**
 * ConfigServiceImpl 测试（镜像 src/rpc/services/ConfigServiceImpl.ts）
 *
 * 契约关注点：默认配置兜底、部分字段合并、持久化往返、缓存副本隔离、
 * 以及 testConnection 的请求形状与失败语义。使用真实临时目录，不 mock fs。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type AppConfig } from '@code-agent/contracts';
import { ConfigServiceImpl } from '../../../src/rpc/services/ConfigServiceImpl';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'code-agent-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function writeConfigFile(content: string): Promise<void> {
  await writeFile(path.join(dir, 'config.json'), content, 'utf-8');
}

describe('ConfigServiceImpl 加载与缓存', () => {
  it('配置文件不存在时加载默认配置', async () => {
    const service = new ConfigServiceImpl(dir);
    await service.load();

    expect(await service.get()).toEqual(DEFAULT_CONFIG);
  });

  it('配置文件缺字段时用默认值补齐，已有字段保持不变', async () => {
    await writeConfigFile(JSON.stringify({ api: { model: 'custom-model' } }));

    const service = new ConfigServiceImpl(dir);
    await service.load();

    const config = await service.get();
    expect(config.api.model).toBe('custom-model');
    expect(config.api.baseUrl).toBe(DEFAULT_CONFIG.api.baseUrl);
    expect(config.api.temperature).toBe(DEFAULT_CONFIG.api.temperature);
    expect(config.api.maxTokens).toBe(DEFAULT_CONFIG.api.maxTokens);
  });

  it('配置文件损坏时回落默认配置且不抛异常', async () => {
    await writeConfigFile('{ not-json');

    const service = new ConfigServiceImpl(dir);
    await service.load();

    expect(await service.get()).toEqual(DEFAULT_CONFIG);
  });

  it('get 返回副本，调用方修改结果不影响缓存', async () => {
    const service = new ConfigServiceImpl(dir);
    await service.load();

    const first = await service.get();
    first.api.model = 'mutated';
    first.api.apiKey = 'mutated';

    const second = await service.get();
    expect(second.api.model).toBe(DEFAULT_CONFIG.api.model);
    expect(second.api.apiKey).toBe(DEFAULT_CONFIG.api.apiKey);
  });

  it('set 补齐默认值并写入 userData/config.json，新实例可读回', async () => {
    const service = new ConfigServiceImpl(dir);
    const partial = { api: { model: 'm1', apiKey: 'k1' } } as AppConfig;

    await service.set(partial);

    const onDisk = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf-8'));
    expect(onDisk.api).toEqual({
      ...DEFAULT_CONFIG.api,
      model: 'm1',
      apiKey: 'k1',
    });

    const reloaded = new ConfigServiceImpl(dir);
    await reloaded.load();
    expect(await reloaded.get()).toEqual(onDisk);
  });

  it('set 后 getCached 立即返回新值', async () => {
    const service = new ConfigServiceImpl(dir);
    await service.set({
      api: {
        ...DEFAULT_CONFIG.api,
        model: 'realtime',
      },
    });

    expect(service.getCached().api.model).toBe('realtime');
  });
});

describe('ConfigServiceImpl.testConnection', () => {
  it('请求 {baseUrl}/models 并携带 Bearer 鉴权与超时信号', async () => {
    const service = new ConfigServiceImpl(dir);
    await service.set({
      api: {
        ...DEFAULT_CONFIG.api,
        baseUrl: 'https://example.com/v1/',
        apiKey: 'secret',
      },
    });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.testConnection()).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // 末尾斜杠归一，避免拼出 //models
    expect(url).toBe('https://example.com/v1/models');
    expect(init.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('HTTP 非 2xx 时返回状态码与状态文本', async () => {
    const service = new ConfigServiceImpl(dir);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' }),
    );

    await expect(service.testConnection()).resolves.toEqual({
      ok: false,
      error: 'HTTP 401 Unauthorized',
    });
  });

  it('网络异常时把错误信息透出，不向上抛', async () => {
    const service = new ConfigServiceImpl(dir);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(service.testConnection()).resolves.toEqual({
      ok: false,
      error: 'network down',
    });
  });

  it('非 Error 类型的异常也转成字符串错误信息', async () => {
    const service = new ConfigServiceImpl(dir);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('boom'));

    await expect(service.testConnection()).resolves.toEqual({
      ok: false,
      error: 'boom',
    });
  });
});
