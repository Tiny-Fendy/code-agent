import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';

// electron-vite 配置
// preload 入口与本包 src/preload/index.ts，实现收口在 @code-agent/rpc/preload
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
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, '../web'),
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
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
