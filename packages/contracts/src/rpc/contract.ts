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

// ---- 服务元定义 ----

/**
 * 服务定义基础接口：每个服务契约显式声明自己的注册名（单源事实）。
 *
 * - 编译期：字面量类型强制实现类与 MainServices 键对齐，写错即编译报错
 * - 运行时：Router.registerAll 直接读取该字段完成注册，不再从类名推导
 * - 客户端：RpcClient 类型映射已排除该字段，不出现在调用面
 */
export interface ServiceDef<N extends string> {
  readonly serviceName: N;
}

/** 服务名一致性检查：键 ≠ serviceName 时该键映射为含具体名称的错误提示字面量 */
export type ServiceNameMismatch<S> = {
  [K in keyof S & string]: S[K] extends { readonly serviceName: infer N }
    ? N extends K
      ? never
      : `键 "${K}" 与 serviceName "${N & string}" 不一致`
    : `服务 "${K}" 缺少 serviceName 字段`;
};

// ---- 契约数据类型 ----

/** 连接测试结果 */
export interface TestConnResult {
  ok: boolean;
  error?: string;
}

// ---- 服务契约 ----

export interface ConfigService extends ServiceDef<'config'> {
  get(): Promise<AppConfig>;
  set(config: AppConfig): Promise<void>;
  testConnection(): Promise<TestConnResult>;
}

export interface ChatService extends ServiceDef<'chat'> {
  /**
   * 发送消息，返回 Agent 事件流句柄（流式方法）。
   * 事件流只含过程数据；终局结果 SendResult 穷尽四个退出点，
   * 由句柄 onEnd 送达（业务失败如 LLM 上游错误也在结果的 llmFailed 中表达）。
   */
  send(message: string): RpcStream<AgentEvent, SendResult>;
  /** 回传工具确认结果 */
  confirmTool(toolCallId: string, ok: boolean): Promise<void>;
}

export interface FileService extends ServiceDef<'file'> {
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

// 编译期断言：MainServices 键必须与各服务 serviceName 字面量一致。
// 出现漂移时本行报错（错误提示字面量联合无法赋给 true），提示中含具体键名。
type ServiceNameCheck = ServiceNameMismatch<MainServices>[keyof MainServices & string] extends never
  ? true
  : never;
const _assertServiceNames: ServiceNameCheck = true;
void _assertServiceNames;
