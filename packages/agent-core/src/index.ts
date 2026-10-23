/**
 * agent-core 对外导出
 *
 * 核心学习目标：Agent 引擎、工具系统、LLM 接入、上下文管理
 *
 * 使用示例：
 *   import { Agent } from '@code-agent/agent-core';
 *
 *   const agent = new Agent(config, '/path/to/project');
 *   for await (const event of agent.run('列出项目结构')) {
 *     console.log(event);
 *   }
 */

// Agent
export { Agent } from './agent/Agent.js';

// 工具系统
export { ToolManager } from './tools/ToolManager.js';
export { BaseTool } from './tools/base.js';
export type { Tool } from './tools/base.js';

// 文件工具
export {
  ListDirTool,
  ReadFileTool,
  SearchByRegexTool,
  WriteFileTool,
  EditFileTool,
} from './tools/file/index.js';

// Shell 工具
export { RunCommandTool } from './tools/shell/index.js';

// LLM
export { LLMProvider, LLMEventType } from './llm/LLMProvider.js';
export { OpenAICompatibleProvider } from './llm/OpenAICompatible.js';
export type { ChatCompletionParams, LLMEvent } from './llm/LLMProvider.js';

// Mock LLM（开发态剧本驱动，见 openspec/changes/004-mock-provider）
export { MockProvider, setMockProvider, clearMockProvider, mockEnabled } from './llm/MockProvider.js';
export type { MockTurn, MockProviderOptions } from './llm/MockProvider.js';

// 上下文
export { ContextManager } from './context/ContextManager.js';

// 日志（开发者诊断通道，与 AgentEvent 严格分离）
export { ConsoleLogger, NullLogger } from './logging/index.js';
