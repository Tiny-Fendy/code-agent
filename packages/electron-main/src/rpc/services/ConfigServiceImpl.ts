/**
 * ConfigService 实现：JSON 文件持久化（userData/config.json）
 *
 * - 启动时 load() 预载到内存缓存：ChatService.send 是同步签名，
 *   需要同步拿到配置来 new Agent（Agent 构造也是同步的）
 * - 读取以 DEFAULT_CONFIG 为底做浅合并，缺字段自动补默认值
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  type AppConfig,
  type ConfigService,
  type TestConnResult,
} from '@code-agent/contracts';

export class ConfigServiceImpl implements ConfigService {
  private readonly filePath: string;
  private cache: AppConfig = structuredClone(DEFAULT_CONFIG);

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'config.json');
  }

  /** 启动时调用：从磁盘加载配置到缓存 */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      this.cache = mergeWithDefaults(parsed);
    } catch {
      // 文件不存在 / 解析失败：保持默认配置
      this.cache = structuredClone(DEFAULT_CONFIG);
    }
  }

  /** 同步读缓存（供 ChatService 创建 Agent 用，非契约方法） */
  getCached(): AppConfig {
    return this.cache;
  }

  async get(): Promise<AppConfig> {
    return structuredClone(this.cache);
  }

  async set(config: AppConfig): Promise<void> {
    this.cache = mergeWithDefaults(config);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
  }

  /** 用 GET {baseUrl}/models 探活，5s 超时 */
  async testConnection(): Promise<TestConnResult> {
    const { baseUrl, apiKey } = this.cache.api;
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** 以默认配置为底合并（磁盘配置可能缺字段） */
function mergeWithDefaults(stored: Partial<AppConfig> | AppConfig): AppConfig {
  return {
    api: {
      ...DEFAULT_CONFIG.api,
      ...(stored.api ?? {}),
    },
  };
}
