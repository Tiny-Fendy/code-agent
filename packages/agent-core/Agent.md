# @code-agent/agent-core

> ⭐ Agent 核心引擎 — 项目学习重点

## 职责

Agent 的"大脑"，负责思考—行动—观察的完整循环（ReAct 模式）。
纯 TypeScript 实现，不依赖 UI 框架或 Electron API，可以独立测试、独立运行。

## 核心学习目标

- **ReAct 循环**：理解 Agent 如何通过"思考-行动-观察"迭代解决问题
- **工具调用**：Function Calling 的工作原理，工具注册与调度机制
- **流式输出**：SSE 流解析、AsyncGenerator 异步生成器模式
- **上下文管理**：对话历史维护、Token 窗口控制、上下文压缩策略
- **LLM 接入**：OpenAI 兼容 API 的调用方式与抽象设计

## 目录结构

```
src/
├── index.ts              # 对外导出入口
├── agent/                # Agent 引擎
│   ├── Agent.ts          # Agent 主类，ReAct 循环
│   └── types.ts          # Agent 内部类型
├── tools/                # 工具系统
│   ├── base.ts           # Tool 接口定义
│   ├── ToolManager.ts    # 工具注册与调度
│   └── built-in/         # 内置工具（后续填充）
├── context/              # 上下文管理
│   └── ContextManager.ts # 对话历史 + Token 管理
└── llm/                  # LLM 接入层
    ├── LLMProvider.ts    # 抽象基类
    ├── OpenAICompatible.ts  # OpenAI 兼容实现
    └── stream.ts         # SSE 流解析（后续添加）
```

## 核心模块说明

### Agent 类

对外主接口。调用 `run(userMessage)` 启动思考循环，返回 `AsyncGenerator<AgentEvent>` 流式推送事件。

**关键设计**：
- 事件驱动：通过事件流向外输出，UI 层订阅事件更新界面
- 可中断：支持 `abort()` 中断当前执行
- 工具注入：工具实现由宿主环境注入，Agent 只调度不实现

### ToolManager

工具的注册中心。

**关键设计**：
- 新增工具 = 实现 Tool 接口 + 注册
- Agent 通过 ToolManager 获取工具 schema 列表传给 LLM
- LLM 返回工具调用后，ToolManager 查找并执行对应工具

### LLM Provider

LLM 接入的抽象层，采用适配器模式。

**关键设计**：
- `LLMProvider` 是抽象基类，定义统一接口
- `OpenAICompatibleProvider` 是 OpenAI 兼容接口的实现
- 未来接入其他模型只需新增一个 Provider 类

### ContextManager

上下文窗口管理器。

**关键设计**：
- 维护对话历史
- Token 计数与窗口控制
- 后续可扩展：上下文压缩、摘要策略

## 事件流协议

Agent 通过 AsyncGenerator 向外推送事件，事件类型定义在 `@code-agent/contracts` 中：

| 事件 | 触发时机 |
| --- | --- |
| `text_delta` | LLM 流式返回文字片段 |
| `tool_call_start` | 模型决定调用工具 |
| `tool_call_confirm` | 工具需要用户确认（暂停等待） |
| `tool_call_result` | 工具执行完成 |
| `message_complete` | AI 完整回复结束 |
| `error` | 发生错误 |
| `done` | 整轮思考结束 |

## 开发约定

1. **保持纯 TS**：不引入 React、Electron 等 UI/平台相关依赖
2. **依赖注入**：工具实现、LLM Provider 都通过构造函数注入，不硬编码
3. **事件驱动**：对外输出只用事件流，不直接操作 UI
4. **错误可恢复**：工具执行失败不应导致整个 Agent 崩溃，错误信息回灌给 LLM 继续思考
5. **可测试**：核心逻辑可以在不启动 Electron 的情况下写单元测试
6. **文档分层**：`openspec/changes/` 放单次需求文档；`openspec/systems/` 放核心子系统的方案设计文档（面向特性设计，非代码细节）：Agent 引擎、工具系统、上下文管理、LLM 接入——长期维护、随设计演进持续更新（规范见根 Agent.md）

## 构建

```bash
pnpm --filter @code-agent/agent-core build
```

监听模式：

```bash
pnpm --filter @code-agent/agent-core dev
```

## 依赖

- `@code-agent/contracts` — 共享类型与业务契约
