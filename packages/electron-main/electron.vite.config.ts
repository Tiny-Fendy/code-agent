import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';

// electron-vite 配置
// 主进程、preload、渲染层的入口分别指向三个 workspace 包
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, 'dist/main'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, 'dist/preload'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, '../electron-preload/src/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, '../web'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, '../web/index.html'),
        },
      },
    },
    server: {
      port: 5173,
    },
  },
});
