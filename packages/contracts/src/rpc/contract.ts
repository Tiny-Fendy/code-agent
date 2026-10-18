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

import type { AgentEvent, SendResult } from '../types/agent.js';
import type { AppConfig, FileNode } from '../types/ipc.js';
import type { RpcStream } from '@code-agent/rpc/protocol';

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
  /**
   * 发送消息，返回 Agent 事件流句柄（流式方法）。
   * 事件流只含过程数据；终局结果 SendResult 穷尽四个退出点，
   * 由句柄 onEnd 送达（业务失败如 LLM 上游错误也在结果的 llmFailed 中表达）。
   */
  send(message: string): RpcStream<AgentEvent, SendResult>;
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
