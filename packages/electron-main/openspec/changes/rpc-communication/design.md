# 渲染层-主进程 RPC 通信机制 - 设计方案 (design.md)

## 1. 架构定位

契约单源 + 四层分工。契约定义在 shared（跨包共享），服务端实现在 electron-main，传输与客户端分属 preload / web。**本特性文档落在 electron-main（服务端主体），但改动横跨 4 个包。**

```
┌─────────────────────────────────────────────────────────┐
│ shared/src/rpc/                                          │
│   protocol.ts   通道常量 + 信封协议 + RpcStream 句柄类型    │
│   contract.ts   服务接口 + MainServices 聚合（类型单源）    │
└──────────────┬──────────────────────────┬───────────────┘
               │ 类型约束（编译期）          │
┌──────────────▼──────────┐   ┌───────────▼───────────────┐
│ web/src/bridge/          │   │ electron-main/src/rpc/     │
│   client.ts  Proxy 客户端 │   │   Router.ts   纯逻辑分发    │
│   stream.ts  流句柄+RpcError│  │   bindIpc.ts  Electron 适配 │
└──────────────┬──────────┘   │   services/   服务实现      │
               │              └───────────┬───────────────┘
┌──────────────▼──────────┐               │
│ electron-preload/src/    │               │
│   index.ts  原子传输函数   │◄──── IPC ─────┘
└─────────────────────────┘
```

**核心决策（已确认）**：

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| D1 | 契约先行，类型单源 | 类型漂移从机制上消灭 |
| D2 | 单通道 dispatch + 信封（`rpc:invoke`），非每方法一个通道 | preload 无法感知方法名（D3），干脆做成哑管道；顺带获得统一中间件入口 |
| D3 | Proxy 放 web 层，preload 只暴露原子函数 | contextBridge 只快照 own properties，动态 Proxy 的 get 陷阱跨不过桥 |
| D4 | 错误走信封（数据），不走 IPC reject | invoke 跨进程后 Error 丢字段 |
| D5 | 流式 = streamId + 推送通道，模拟 gRPC server-streaming | Agent 核心输出就是事件流 |
| D6 | Router 纯逻辑 + Electron 薄适配 | 不启动 Electron 可单测 |
| D7 | 流式 DX = RpcStream 事件句柄（on / once / onEnd / abort），非 AsyncGenerator 迭代 | Agent 事件按类型分发，UI 天然事件驱动；订阅/退订/取消与 React 生命周期一一对应 |

---

## 2. 协议设计（shared/src/rpc/protocol.ts）

```typescript
// 两个固定通道
export const RPC = {
  INVOKE: 'rpc:invoke',  // 渲染层 → 主进程，单通道分发
  STREAM: 'rpc:stream',  // 主进程 → 渲染层，事件流推送
} as const;

// 请求载荷（ipcRenderer.invoke 的第二个参数）
export interface RpcRequest { service: string; method: string; args: unknown[] }

// 响应信封
export type RpcResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: RpcErrorCode; message: string; data?: unknown } };

export type RpcErrorCode =
  | 'SERVICE_NOT_FOUND' | 'METHOD_NOT_FOUND' | 'HANDLER_ERROR' | 'ABORTED';

// 流式帧
export interface StreamFrame {
  streamId: string;
  kind: 'next' | 'return' | 'throw';
  value?: unknown;
}

// 流式事件基类型与 web 侧句柄（流式方法在契约中的返回类型）
export interface StreamEvent { type: string; data?: unknown }

export interface RpcStream<E extends StreamEvent> {
  /** 订阅业务事件，返回退订函数 */
  on<T extends E['type']>(type: T, cb: (data: Extract<E, { type: T }>['data']) => void): () => void;
  /** 订阅一次，触发后自动退订 */
  once<T extends E['type']>(type: T, cb: (data: Extract<E, { type: T }>['data']) => void): () => void;
  /** 流生命周期：正常结束 cb()；异常结束（含取消）cb(RpcError) */
  onEnd(cb: (err?: RpcError) => void): () => void;
  /** 取消该流 */
  abort(): void;
}
```

要点：
- `invoke` 通道只有一个，方法定位靠载荷里的 `service + method`，新增方法不需要新通道
- 业务错误全部走 `{ ok: false }` 信封；IPC 层 reject 只兜底序列化失败等意外
- `StreamFrame.kind` 驱动渲染层句柄的事件分发与结束：`next` → `on` 回调；`return` → `onEnd()`；`throw` → `onEnd(RpcError)`
- 保留方法 `__stream.cancel(streamId)`：Router 内置，用于句柄 `abort()`，不占用业务契约

---

## 3. 契约设计（shared/src/rpc/contract.ts）

```typescript
export interface ConfigService {
  get(): Promise<AppConfig>;
  set(config: AppConfig): Promise<void>;
  testConnection(): Promise<TestConnResult>;
}

export interface ChatService {
  /** 发送消息，返回 Agent 事件流句柄（流式方法） */
  send(message: string): RpcStream<AgentEvent>;
  /** 回传工具确认结果 */
  confirmTool(toolCallId: string, ok: boolean): Promise<void>;
}

export interface FileService {
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
```

**类型对齐机制**：
- 服务端：`class ChatServiceImpl implements ChatService` → 服务实现落后于契约时编译报错
- 客户端：`createRpcClient<MainServices>()` → 调用侧签名与契约不一致时编译报错
- 取消不进契约：流的中断由句柄 `abort()` 统一承担，服务无需各自定义 `abort()` 方法

**序列化约束**：契约参数与返回值只能是可结构化克隆类型；`AgentEvent` 等均为 plain object，满足要求。

---

## 4. 服务端设计（electron-main/src/rpc/）

### 4.1 Router.ts —— 纯逻辑核心（不 import electron）

```typescript
// 推流接口由宿主注入，Router 自身不依赖 Electron
export interface StreamEmitter {
  send(frame: StreamFrame): void;
}

export class RpcRouter {
  private services = new Map<string, Record<string, unknown>>();
  private streams = new Map<string, StreamController>(); // streamId → 控制器

  registerService(name: string, service: object): void;

  /** 核心入口：ipcMain.handle 只是一层薄皮 */
  async dispatch(
    service: string,
    method: string,
    args: unknown[],
    emitter: StreamEmitter,
  ): Promise<RpcResponse<unknown>>;
}
```

`dispatch` 行为：

1. 查服务 / 方法，不存在 → `SERVICE_NOT_FOUND` / `METHOD_NOT_FOUND` 信封
2. 调用 `service[method](...args)`，统一 try/catch → `HANDLER_ERROR` 信封
3. **流式判定**：返回值为 `createRpcStream` 产生的句柄（内部 marker symbol 识别）→ 分配 `streamId`，立即返回 `{ ok: true, data: { __stream: streamId } }`，随后后台泵生成器，逐帧 `emitter.send({ streamId, kind: 'next', value })`
4. 泵结束：正常 → `return` 帧；异常 → `throw` 帧；被取消 → `throw` 帧（`ABORTED`），并从 `streams` 注册表清理
5. **保留方法**：`dispatch('__stream', 'cancel', [streamId], ...)` 由 Router 直接处理，abort 对应 controller，不经过业务服务

### 4.2 createRpcStream —— 生成器 → 流句柄适配器

Router 提供的显式适配器，替代"自动探测 AsyncGenerator"的隐式约定：

```typescript
// main 侧句柄：对外满足 RpcStream 接口，内部携带泵送所需的生成器与取消钩子
export function createRpcStream<E extends StreamEvent>(
  gen: AsyncGenerator<E>,
): ServerRpcStream<E>
```

- `ServerRpcStream` 是 `RpcStream` 的服务端超集：额外暴露 `onAbort(cb)`（供服务桥接中断逻辑）与内部 marker
- 服务端的 `on` / `once` 为本地旁路（可用于服务端日志），事件主体推给渲染层
- 泵在 Router 分配 streamId 后启动，`controller.abort()` 时终止泵并以 `throw`（`ABORTED`）收尾

### 4.3 流与取消

- Router 维护 `streamId → StreamController`（内含 `AbortController`）
- 取消链路：渲染层 `stream.abort()` → `invoke('__stream', 'cancel', [streamId])` → Router abort controller → 泵终止 → `throw`（`ABORTED`）帧 → 渲染层 `onEnd(err)` 触发并退订
- 流结束后从注册表移除，防止泄漏

### 4.4 services/ —— 服务实现

```typescript
// ChatService.ts：持有 Agent 实例，做 Agent ↔ RPC 的适配
// 注：Agent 构造第三参数已演进为 options 对象 AgentOptions（日志子系统变更，见
// agent-core openspec/changes/logging/design.md D4）；未来 confirmTool 落地真实
// 确认门控时必须走 { onConfirm } 形式，不得再写第三位置参数。
export class ChatServiceImpl implements ChatService {
  send(message: string) {
    const agent = new Agent(this.config, this.projectPath);
    const stream = createRpcStream(agent.run(message));
    stream.onAbort(() => agent.abort());   // 取消桥接：句柄 abort → Agent 中断
    return stream;
  }
  async confirmTool(id: string, ok: boolean): Promise<void> { /* 确认回传 */ }
}
```

第一期实现 `ConfigServiceImpl`、`ChatServiceImpl`、`FileServiceImpl`。服务内部再委托 agent-core / fs 等已有模块。

### 4.5 bindIpc.ts —— Electron 薄适配（十几行）

- `ipcMain.handle(RPC.INVOKE, (_e, req: RpcRequest) => router.dispatch(req.service, req.method, req.args, emitter))`
- `emitter` 内部用 `BrowserWindow.getAllWindows()[0].webContents.send(RPC.STREAM, frame)` 推送
- 应用启动时注册三个服务实例

---

## 5. 传输层设计（electron-preload/src/index.ts）

preload 退化为哑管道，只暴露两个原子函数：

```typescript
const transport = {
  invoke: (service: string, method: string, args: unknown[]) =>
    ipcRenderer.invoke(RPC.INVOKE, { service, method, args }),
  onStream: (cb: (frame: StreamFrame) => void) => {
    const listener = (_e: unknown, frame: StreamFrame) => cb(frame);
    ipcRenderer.on(RPC.STREAM, listener);
    return () => ipcRenderer.removeListener(RPC.STREAM, listener);
  },
};
contextBridge.exposeInMainWorld('transport', transport);
```

新增任何服务方法，preload 零改动。

---

## 6. 客户端设计（web/src/bridge/）

### 6.1 client.ts —— Proxy 生成类型化客户端

```typescript
export function createRpcClient<Services extends object>(): Services {
  return new Proxy({} as Services, {
    get(_t, service: string) {
      return new Proxy({}, {
        get(_t2, method: string) {
          return (...args: unknown[]) => dispatch(service, method, args);
        },
      });
    },
  });
}
```

运行时无方法清单，`service + method` 在调用时拼进载荷。

### 6.2 stream.ts —— 流句柄与错误还原

```typescript
export class RpcError extends Error {
  constructor(public code: RpcErrorCode, message: string) { super(message); }
}
```

`dispatch` 内部：

1. `const res = await transport.invoke(service, method, args)`
2. `res.ok === false` → `throw new RpcError(res.error.code, res.error.message)`
3. `data.__stream` 存在 → 同步返回 `RpcStreamImpl`：
   - `on` / `once`：本地注册回调，按 `streamId` 过滤 `onStream` 帧（调用同步返回句柄，注册先于任何帧到达，不丢事件）
   - `onEnd`：`return` 帧 → `cb()`；`throw` 帧 → `cb(new RpcError(...))`；之后自动退订全部监听
   - `abort()`：`invoke('__stream', 'cancel', [streamId])`

普通方法不受影响：`rpc.config.get()` 仍是 `Promise<AppConfig>`。

### 6.3 环境检测与 mock

保留现有"Electron / 纯 Web"双模式：非 Electron 环境下 `createRpcClient` 换成 mock 实现的 `MainServices` 对象（流式方法直接返回注入了假事件序列的 `RpcStream`），UI 可脱离 Electron 调试。

---

## 7. 与现有代码的关系

| 现有物 | 处置 |
| --- | --- |
| `shared/types/ipc.ts` 的 `IPC_CHANNELS` | 删除（`AppConfig` / `FileNode` 等数据类型保留） |
| `electron-preload` 手写 api 对象 | 整体替换为 transport |
| `web/src/bridge/types.ts` 的 `WindowAPI` | 删除，类型改由契约推导 |
| `web/src/bridge/index.ts` mock 桥 | 改为 mock `MainServices` |
| `electron-main` 尚无 IPC handler | 直接按新机制实现，无历史包袱 |

一次性替换，不做渐进兼容（当前无业务代码依赖旧桥）。

---

## 8. 待定项

1. **terminal 服务**：stdout 输出复用 `rpc:stream` 通道（终端输出同样建模为 RpcStream 句柄），终端输入作为普通方法，第二期细化。

已关闭的待定项：流式 DX（定为 RpcStream 事件句柄，D7）、确认交互（`tool_call_confirm` 走应用层回调 `chat.confirmTool`，协议层不加原语）、契约位置（`shared/src/rpc/`）。
