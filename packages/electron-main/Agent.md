# @code-agent/electron-main

> Electron 主进程 — 桌面应用的"身体"

## 职责

- 创建和管理浏览器窗口
- 注册 IPC 处理器，接收渲染进程请求
- 提供本地能力服务（文件系统、终端进程等）
- 管理 Agent 实例，调用 agent-core 执行逻辑
- 配置持久化存储

## 目录结构

```
src/
├── index.ts                  # 主进程入口：创建窗口 + 注册 RPC 服务
└── rpc/
    ├── Router.ts             # 纯逻辑分发核心（不依赖 Electron，可单测）
    ├── bindIpc.ts            # Electron 薄适配：ipcMain.handle ↔ Router
    └── services/             # 服务实现（implements shared 中的契约）
        ├── ConfigServiceImpl.ts  # 配置读写 / JSON 持久化 / 连接探活
        ├── ChatServiceImpl.ts    # Agent ↔ RPC 适配（含取消桥接）
        ├── FileServiceImpl.ts    # 目录对话框 / 文件树 / 读文件
        ├── WorkspaceState.ts     # 当前项目路径（服务间共享）
        └── index.ts              # registerServices 统一注册
```

## RPC 通信

渲染层 ↔ 主进程走**单通道 dispatch + 信封协议**（设计文档：`openspec/changes/rpc-communication/`）：

- `rpc:invoke`：渲染层 → 主进程，载荷 `{ service, method, args }`，返回 `{ ok, data | error }` 信封
- `rpc:stream`：主进程 → 渲染层，流式方法按 `streamId` 推送 `next` / `return` / `throw` 帧
- 取消统一走句柄 `abort()` → 内置保留方法 `__stream.cancel(streamId)`，服务不各自定义 abort
- 协议与服务契约（`MainServices`）定义在 `@code-agent/shared` 的 `rpc/` 下，类型单源

## 核心服务

### ConfigServiceImpl

- `userData/config.json` JSON 持久化，启动时加载到内存缓存
- 以 `DEFAULT_CONFIG` 为底合并缺字段
- `testConnection()` 用 `GET {baseUrl}/models` 探活（5s 超时）

### ChatServiceImpl

- `send()` 同步创建 Agent，用 `createRpcStream(agent.run())` 包装事件流
- 取消桥接：句柄 `onAbort` → `agent.abort()`
- 未打开项目时工作目录退化为 `process.cwd()`

### FileServiceImpl

- 系统目录选择对话框（选中后写入 `WorkspaceState`）
- 递归文件树（跳过隐藏目录 / node_modules 等，限深 6 层）
- 读文件（UTF-8）

## 开发约定

1. **IPC 只做薄适配**：bindIpc 不写业务逻辑，分发由 Router 承担，业务在 services 里
2. **Router 不依赖 Electron**：纯逻辑 + 注入 StreamEmitter，保证可单测
3. **错误走信封**：handler 异常包装成 `{ ok: false }` 返回，不向 IPC 层抛异常
4. **主进程不阻塞**：耗时操作放子进程或异步执行，避免阻塞事件循环
5. **文档分层**：`openspec/changes/` 放单次需求文档；`openspec/systems/` 放核心子系统的方案设计文档（面向特性设计，非代码细节）：RPC 服务端、窗口与生命周期管理——长期维护、随设计演进持续更新（规范见根 Agent.md）

## 构建

使用 electron-vite 构建。开发时在根目录运行：

```bash
pnpm dev
```

单独构建：

```bash
pnpm build:electron
```

## 依赖

- `@code-agent/shared` — 共享类型
- `@code-agent/agent-core` — Agent 引擎
