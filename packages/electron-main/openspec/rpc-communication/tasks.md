# 渲染层-主进程 RPC 通信机制 - 任务拆解 (tasks.md)

## 开发顺序说明

按照"先纯逻辑、后 Electron、最后 UI 集成"的顺序开发，保证每一步都可验证：

1. **协议与契约**（shared）：类型基础，两侧都依赖它
2. **Router 纯逻辑**（main）：不依赖 Electron，可单元测试
3. **Electron 适配 + 服务实现**（main）：接上真实 IPC
4. **preload 传输层**：哑管道
5. **web 客户端**：Proxy + 流句柄
6. **旧桥接替换 + 端到端验证**

---

## Task 1: 协议与契约（shared）

**优先级**：P0
**预估工作量**：小

**任务内容**：
- [x] 创建 `shared/src/rpc/protocol.ts`：`RPC` 通道常量、`RpcRequest` / `RpcResponse` / `RpcErrorCode` / `StreamFrame`、`StreamEvent` / `RpcStream` 句柄接口
- [x] 创建 `shared/src/rpc/contract.ts`：`ConfigService` / `ChatService` / `FileService` / `MainServices`（流式方法返回 `RpcStream`，无 `abort` 方法）
- [x] `shared/src/index.ts` 统一导出
- [x] 补充契约需要的少量数据类型（如 `TestConnResult`）

**验收标准**：
- `pnpm --filter @code-agent/shared build` 通过
- 类型只依赖既有共享类型（`AppConfig` / `AgentEvent` / `FileNode`），无循环依赖

---

## Task 2: Router 纯逻辑（main，可单测）

**优先级**：P0
**预估工作量**：中

**任务内容**：
- [x] 创建 `electron-main/src/rpc/Router.ts`
- [x] 实现 `registerService` / `dispatch`
- [x] 服务 / 方法未找到 → `SERVICE_NOT_FOUND` / `METHOD_NOT_FOUND` 信封
- [x] handler 异常统一 catch → `HANDLER_ERROR` 信封
- [x] 实现 `createRpcStream(gen)`：生成器 → 服务端流句柄（marker symbol、`onAbort` 钩子）
- [x] dispatch 识别流句柄 → 分配 `streamId`，立即返回 `__stream`，后台泵生成器推帧
- [x] `return` / `throw` / cancel 三种收尾帧，流注册表清理
- [x] 内置保留方法 `__stream.cancel(streamId)`：abort 对应 controller
- [x] 编写 `Router.test.ts`（用假服务 + 假 emitter，不启动 Electron）

**验收标准**：
- 普通方法：返回 `{ ok: true, data }`，参数逐个展开传入
- 异常方法：返回 `{ ok: false, error: { code: 'HANDLER_ERROR' } }`，不抛出
- 流式方法：先收到 `__stream` 响应，再按序收到 next 帧，最后收到 return 帧
- `__stream.cancel` 后：泵终止，推送 `throw` 帧（`ABORTED`），`onAbort` 钩子被调用
- 泵结束后不再推送任何帧（emitter 断言调用次数）

---

## Task 3: Electron 适配与服务实现（main）

**优先级**：P0
**预估工作量**：中

**任务内容**：
- [x] 创建 `electron-main/src/rpc/bindIpc.ts`：`ipcMain.handle(RPC.INVOKE, ...)` ↔ `router.dispatch`，`webContents.send(RPC.STREAM, frame)` 作为 emitter
- [x] 实现 `services/ConfigServiceImpl.ts`（electron-store 或 JSON 文件持久化，沿用 `DEFAULT_CONFIG`）
- [x] 实现 `services/ChatServiceImpl.ts`：`send` 用 `createRpcStream(agent.run(message))` 包装 + `onAbort(() => agent.abort())` 桥接取消；实现 `confirmTool`
- [x] 实现 `services/FileServiceImpl.ts`：对话框 + 文件树 + 读文件
- [x] 应用启动时 `registerService` 三个服务

**验收标准**：
- 三个服务类均 `implements` 契约接口，`pnpm typecheck` 通过
- 不启动渲染层，用脚本/测试直接调用服务实现可工作
- 取消链路贯通：句柄 abort → onAbort → `agent.abort()` 生效

---

## Task 4: preload 传输层

**优先级**：P0
**预估工作量**：小

**任务内容**：
- [x] 重写 `electron-preload/src/index.ts`：只暴露 `invoke` / `onStream` 两个原子函数
- [x] 导出 `Transport` 类型供 web 侧声明 `window.transport`
- [x] 删除旧的按方法包装 api

**验收标准**：
- 文件中不出现任何业务方法名
- `contextIsolation: true` 下渲染层只能通过 transport 通信

---

## Task 5: web 客户端

**优先级**：P0
**预估工作量**：中

**任务内容**：
- [x] 创建 `web/src/bridge/client.ts`：`createRpcClient<MainServices>()`（双层 Proxy）
- [x] 创建 `web/src/bridge/stream.ts`：`RpcError` 类 + `RpcStreamImpl`（`on` / `once` / `onEnd` / `abort`，按 streamId 过滤帧，结束后自动退订）
- [x] `window.transport` 全局类型声明
- [x] 纯 Web 模式：mock 的 `MainServices` 实现（流式方法返回注入假事件序列的 `RpcStream`）

**验收标准**：
- `rpc.config.get()` 有完整类型提示，返回 `Promise<AppConfig>`
- `rpc.chat.send('hi')` 返回 `RpcStream<AgentEvent>`，`on('text_delta', cb)` 回调参数有类型提示
- `RpcError` 可被 try/catch，`code` 可读
- `on` 注册先于事件帧到达（不丢事件）；流结束后监听器被移除（无泄漏）
- `stream.abort()` 发出 `__stream.cancel`，`onEnd` 收到 `ABORTED` 错误
- 纯 Web 模式（浏览器打开）UI 可调试

---

## Task 6: 旧桥接替换与端到端验证

**优先级**：P0
**预估工作量**：小

**任务内容**：
- [x] 删除 `shared/types/ipc.ts` 的 `IPC_CHANNELS`（保留数据类型）
- [x] 删除 `web/src/bridge/types.ts` 的 `WindowAPI`
- [x] `web/App.tsx` 接入 `rpc.config.get()` 做冒烟验证（如显示当前模型名）
- [ ] 手工端到端：配置读写 → 对话流式输出（on 订阅）→ 工具调用事件 → 句柄 abort 中断

**验收标准**：
- 全仓库无 `IPC_CHANNELS` 残留引用
- `pnpm dev` 启动后：改配置生效；发消息能通过 `stream.on('text_delta')` 流式渲染；停止按钮调 `stream.abort()` 能中断
- `pnpm typecheck` 全绿

---

## 依赖关系图

```
Task 1 (shared 协议契约)
   ├────→ Task 2 (Router 纯逻辑) ──→ Task 3 (bindIpc + services) ──┐
   ├────→ Task 4 (preload) ────────────────────────────────────────┼──→ Task 6 (替换+端到端)
   └────→ Task 5 (web 客户端) ─────────────────────────────────────┘
```

- Task 1 最先做
- Task 2 / 4 / 5 可并行（都只依赖 Task 1）
- Task 3 依赖 Task 2；Task 6 最后做
