import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // test/agent/Agent.test.ts 是手动演示脚本（需要真实 API key），不参与自动化
    exclude: ['test/agent/Agent.test.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
