# 系统设计文档

本目录实时记录 `@code-agent/agent-core` 包核心子系统的设计方案。

## 定位

- 记录**核心子系统的方案设计**：把子系统当作产品特性来写——目标、能力边界、关键设计决策，不贴代码实现细节
- 随设计演进持续更新，始终反映最新方案
- 不承载开发流程：待开发的需求/变更仍走 openspec 下的 changes/ 目录（spec / design / tasks / check）

## 收录原则

- 只记录核心子系统，不求大而全
- 每个子系统一个文档，文件名用 kebab-case（如 `agent-engine.md`）

## 当前收录

- [上下文管理（ContextManager）](./context-management.md)
- Agent 引擎（ReAct 循环）— 待记录
- 工具系统（ToolManager、工具生命周期）— 待记录
- LLM 接入（Provider 抽象与 OpenAICompatible 实现）— 待记录

## 更新时机

设计定稿、或方案演进时，及时更新对应文档，保持文档始终反映最新设计。
