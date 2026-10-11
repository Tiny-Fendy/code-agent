# @code-agent/electron-preload

> Preload 安全桥接层

## 职责

在渲染进程（Web）和主进程之间建立安全的通信桥梁。
通过 `contextBridge` 向渲染进程暴露受控的 API，渲染进程只能调用这些预定义的方法，
无法直接访问 Node.js API。

## 为什么需要 preload？

Electron 的安全最佳实践：
- **contextIsolation: true** — 渲染进程和 Node.js 上下文隔离
- **nodeIntegration: false** — 渲染进程不直接集成 Node.js
- Preload 脚本运行在独立上下文，是两者之间唯一的桥梁

## 目录结构

```
src/
└── index.ts    # preload 入口，通过 contextBridge 暴露哑管道 transport
```

## 暴露的 API

preload 是与业务无关的**哑管道**（contextBridge 只快照 own properties，动态 Proxy 跨不过桥，
类型化客户端放在 web 层）。通过 `window.transport` 只暴露两个原子函数：

```typescript
window.transport = {
  // 单通道分发：service + method 在调用时拼进载荷，新增服务方法零改动
  invoke(service: string, method: string, args: unknown[]): Promise<RpcResponse<unknown>>;
  // 订阅主进程流式帧推送，返回退订函数
  onStream(cb: (frame: StreamFrame) => void): () => void;
}
```

协议（通道名、信封、流帧、Transport 类型）定义在 `@code-agent/shared` 的 `rpc/` 下。

## 开发约定

1. **最小暴露原则**：只暴露 `invoke` / `onStream` 两个原子函数，不出现任何业务方法名
2. **不暴露原始 IPC**：渲染进程拿不到 `ipcRenderer`，只能走信封协议
3. **清理函数**：`onStream` 返回退订函数，方便组件卸载时解绑

## 构建

由 electron-vite 在构建主进程时一并构建，不需要单独构建命令。

## 依赖

- `@code-agent/shared` — RPC 协议类型与通道常量
