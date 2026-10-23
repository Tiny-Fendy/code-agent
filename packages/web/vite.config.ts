import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vite 配置（用于独立 Web 调试）
// Electron 环境下由 electron-vite 接管构建
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 用 import.meta.dirname（ESM 原生）替代 __dirname：
      // Vite 未来主版本将默认使用 native config loader，不再支持 __dirname
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    sourcemap: true,
  },
});
