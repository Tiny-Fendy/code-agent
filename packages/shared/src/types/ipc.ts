/**
 * 跨进程共享的数据类型
 *
 * 通道名 / 信封协议见 src/rpc/（单通道 dispatch，不再有每方法一个通道）
 */

// ---- 配置 ----
export interface AppConfig {
  api: {
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };
}

// ---- 文件 ----
export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}
