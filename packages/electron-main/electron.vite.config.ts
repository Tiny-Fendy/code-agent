import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';

// electron-vite 配置
// preload 入口与本包 src/preload/index.ts，实现收口在 @code-agent/rpc/preload
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, 'dist/main'),
      // dev 模式监听源码改动：重建后由 electron-vite 自动重启 Electron 进程
      // （等效于 electron-vite dev --watch，固化到配置免带 CLI 参数）
      watch: {},
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
      // 同上：preload 重建后自动刷新窗口
      watch: {},
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, '../web'),
    resolve: {
      // 与 web 包 vite.config.ts / tsconfig paths 保持一致（electron-vite renderer 不继承 web 包配置）
      alias: { '@': resolve(__dirname, '../web/src') },
    },
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
