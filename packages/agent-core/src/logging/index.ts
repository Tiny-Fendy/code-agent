/**
 * 日志模块（面向开发者的诊断通道，与 AgentEvent 产品事件严格分离）
 *
 * 设计文档：openspec/changes/logging/design.md
 */

export { ConsoleLogger } from './ConsoleLogger.js';
export { NullLogger } from './NullLogger.js';
