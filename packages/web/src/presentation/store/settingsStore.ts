/**
 * 设置 store：AppConfig 的读取 / 保存 / 连接测试
 *
 * 错误处理约定：store 只管状态流转，RPC 异常原样抛给调用方，
 * 由组件层决定如何提示（antd message / 表单内联错误）。
 */

import { create } from 'zustand';
import type { AppConfig, TestConnResult } from '@code-agent/contracts';
import { rpc } from '@/infrastructure/bridge';

interface SettingsState {
  /** 当前配置（未加载完成时为 null，顶栏据此刻意展示占位） */
  config: AppConfig | null;
  loading: boolean;
  saving: boolean;

  loadConfig: () => Promise<void>;
  saveConfig: (config: AppConfig) => Promise<void>;
  testConnection: () => Promise<TestConnResult>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  config: null,
  loading: false,
  saving: false,

  loadConfig: async () => {
    set({ loading: true });
    try {
      const config = await rpc.config.get();
      set({ config, loading: false });
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  saveConfig: async (config) => {
    set({ saving: true });
    try {
      await rpc.config.set(config);
      // 乐观同步本地缓存：保存成功即以入参为准（顶栏模型名随之更新）
      set({ config, saving: false });
    } catch (err) {
      set({ saving: false });
      throw err;
    }
  },

  testConnection: () => rpc.config.testConnection(),
}));
