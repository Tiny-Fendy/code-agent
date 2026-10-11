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
export { Agent } from './agent/Agent';

// 工具系统
export { ToolManager } from './tools/ToolManager';
export { BaseTool } from './tools/base';
export type { Tool } from './tools/base';

// 文件工具
export {
  ListDirTool,
  ReadFileTool,
  SearchByRegexTool,
  WriteFileTool,
  EditFileTool,
} from './tools/file';

// Shell 工具
export { RunCommandTool } from './tools/shell';

// LLM
export { LLMProvider } from './llm/LLMProvider';
export { OpenAICompatibleProvider } from './llm/OpenAICompatible';
export type { ChatCompletionParams, LLMEvent, LLMEventType } from './llm/LLMProvider';

// 上下文
export { ContextManager } from './context/ContextManager';
