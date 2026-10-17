/**
 * RPC 服务契约（类型单源）
 *
 * - 服务端：`class XxxServiceImpl implements XxxService`，实现落后于契约时编译报错
 * - 客户端：`createRpcClient<MainServices>()`，调用侧签名与契约不一致时编译报错
 * - 取消不进契约：流的中断由句柄 abort() 统一承担（Router 内置保留方法 __stream.cancel）
 *
 * 序列化约束：契约参数与返回值只能是可结构化克隆类型（plain object / 基础类型），
 * 不允许函数、class 实例等。
 */

import type { AgentEvent } from '../types/agent';
import type { AppConfig, FileNode } from '../types/ipc';
import type { RpcStream } from './protocol';

// ---- 契约数据类型 ----

/** 连接测试结果 */
export interface TestConnResult {
  ok: boolean;
  error?: string;
}

// ---- 服务契约 ----

export interface ConfigService {
  get(): Promise<AppConfig>;
  set(config: AppConfig): Promise<void>;
  testConnection(): Promise<TestConnResult>;
}

export interface ChatService {
  /** 发送消息，返回 Agent 事件流句柄（流式方法） */
  send(message: string): RpcStream<AgentEvent>;
  /** 回传工具确认结果 */
  confirmTool(toolCallId: string, ok: boolean): Promise<void>;
}

export interface FileService {
  openFolderDialog(): Promise<string | null>;
  getFileTree(projectPath: string): Promise<FileNode[]>;
  readFile(filePath: string): Promise<string>;
}

/** 聚合根：web 客户端与服务端注册共同的类型依据 */
export interface MainServices {
  config: ConfigService;
  chat: ChatService;
  file: FileService;
}
