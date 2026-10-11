# @code-agent/shared

> 共享类型、常量与工具函数 — 所有包的共同依赖

## 职责

- 定义跨包共享的 TypeScript 类型
- 存放全局常量（默认配置、IPC 通道名等）
- 提供无副作用的纯工具函数（两端都能安全使用）

## 目录结构

```
src/
├── index.ts           # 统一导出入口
├── types/
│   ├── agent.ts       # Agent 相关类型（消息、事件、配置）
│   ├── tool.ts        # 工具相关类型（定义、结果、上下文）
│   └── ipc.ts         # IPC 消息类型 + 通道常量
├── constants/
│   └── index.ts       # 全局常量
└── utils/             # 纯函数工具（待填充）
```

## 核心类型

### Agent 类型（types/agent.ts）

- `ChatRole` — 对话角色：system / user / assistant / tool
- `ChatMessage` — 聊天消息（含 tool_calls、tool_call_id 等字段）
- `ToolCall` — 工具调用（id、name、arguments）
- `AgentEventType` / `AgentEvent` — Agent 流式事件类型
- `AgentConfig` — Agent 配置（API Key、模型、参数等）

### Tool 类型（types/tool.ts）

- `ToolDefinition` — 工具定义（传给 LLM 的 schema）
- `ToolResult` — 工具执行结果
- `ToolContext` — 工具执行上下文（projectPath 等）

### IPC 数据类型（types/ipc.ts）

- `AppConfig` — 应用配置结构
- `FileNode` — 文件树节点

### RPC 协议与契约（rpc/）

- `RPC` / `RpcRequest` / `RpcResponse` / `RpcErrorCode` — 通道常量与信封
- `StreamFrame` / `StreamEvent` / `RpcStream` — 流式帧与句柄接口
- `Transport` — preload ↔ web 的原子传输接口
- `RpcError` — 信封错误还原后的异常类型
- `ConfigService` / `ChatService` / `FileService` / `MainServices` — 服务契约（类型单源）

## 开发约定

1. **只放类型和纯函数**：不放业务逻辑，不产生副作用
2. **修改需谨慎**：shared 的变更会影响所有依赖包，改类型前先想清楚
3. **保持轻量**：不要引入重型依赖，保持编译速度
4. **构建产物**：使用 tsc 编译到 dist/，其他包通过 dist 引用

## 构建

```bash
pnpm --filter @code-agent/shared build
```

监听模式（开发时用）：

```bash
pnpm --filter @code-agent/shared dev
```
