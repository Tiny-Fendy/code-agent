# IPC / RPC 通信子系统

> 渲染层（web）↔ 主进程（electron-main）的统一通信方案。
> 流式通信不是独立子系统，而是本方案支持的一种**交互模式**。

状态：已落地（Unary + 服务端流 v1）；通信方案 v2 演进中（本次动工：Server Streaming 终局机制 + 跨模式错误结构统一），见文末"进行中的变更"。

---

## 1. 定位与目标

渲染层像调用本地对象一样调用主进程能力（`rpc.<service>.<method>(...)`），通信机制统一解决四件事：

1. **寻址**：调用如何定位到主进程处理函数
2. **数据**：跨进程参数与返回值如何编码
3. **错误**：失败如何结构化地传回渲染层
4. **生命周期**：长时间运行的调用如何推数据、如何结束、如何取消

设计原则：

| 原则 | 含义 |
| --- | --- |
| 契约单源 | 服务接口只在 `shared` 定义一次，客户端与服务端靠编译期约束对齐 |
| preload 哑管道 | 安全边界只暴露与业务无关的原子函数，新增方法零改动 preload |
| 信封化错误 | 错误是数据，不依赖 IPC reject（跨进程后 Error 丢字段） |
| 机制化生命周期 | 流的开始 / 数据 / 结束 / 错误 / 取消由通信机制提供，不靠业务消息约定 |
| 纯逻辑核心 | Router 不 import Electron，推流接口靠注入，可脱离 Electron 单测 |
| 安全面最小 | `contextIsolation: true` + `nodeIntegration: false`，渲染层只触达 transport |

---

## 2. 分层结构

```
┌──────────────────────────────────────────────────────────────┐
│ shared/src/rpc/                协议与契约（类型 + 常量单源）      │
│   protocol.ts  RPC 通道 / 信封 / 流帧 / RpcStream 句柄 / 错误   │
│   contract.ts  ConfigService / ChatService / FileService ...  │
└──────────────┬───────────────────────────────┬────────────────┘
               │ 编译期类型约束                  │ 编译期类型约束
┌──────────────▼──────────────┐   ┌────────────▼─────────────────┐
│ electron-main/src/rpc/       │   │ web/src/bridge/               │
│   Router.ts    纯逻辑分发核心 │   │   client.ts  双层 Proxy 客户端 │
│   bindIpc.ts   Electron 薄皮 │   │   stream.ts  消费端流句柄       │
│   services/    服务实现       │   │   mock.ts    纯 Web mock 传输  │
└──────────────┬──────────────┘   └────────────┬─────────────────┘
               │ ipcMain                        │ window.transport
┌──────────────▼────────────────────────────────▼─────────────────┐
│ electron-preload/src/index.ts   哑管道：invoke / onStream         │
└──────────────────────────────────────────────────────────────────┘
```

关键文件（相对仓库根目录）：

- 协议与契约：`packages/shared/src/rpc/protocol.ts`、`packages/shared/src/rpc/contract.ts`
- 服务端：`packages/electron-main/src/rpc/Router.ts`、`bindIpc.ts`、`services/`
- 传输层：`packages/electron-preload/src/index.ts`
- 客户端：`packages/web/src/bridge/`（`client.ts` / `stream.ts` / `mock.ts`）

---

## 3. 寻址与传输

- **单通道 dispatch**：所有请求走固定通道 `rpc:invoke`，方法定位靠载荷 `{ service, method, args }`。新增服务/方法不新增通道，preload 零改动。
- **服务注册表**：主进程启动时 `router.registerService(name, impl)`，名字与契约 `MainServices` 的键一一对应（`config` / `chat` / `file`）。
- **数据边界**：参数与返回值必须可结构化克隆（plain object / array / 基础类型），禁止函数、class 实例跨进程。
- **推流通道**：固定通道 `rpc:stream`，主进程 → 渲染层，帧按 `streamId` 多路复用；`bindIpc` 用 `event.sender` 精确投递给发起请求的窗口。

---

## 4. 交互模式总览

通信方案按调用形态分模式（类比 gRPC 的四种调用模式）：

| 模式 | 形态 | 状态 | 场景 |
| --- | --- | --- | --- |
| **Unary（请求-响应）** | 一请求 → 一响应 | ✅ 已落地 | `config.get/set`、`file.*` |
| **Server Streaming（服务端流）** | 一请求 → 多条数据帧 + 唯一终局 | ⚠️ v1 已落地，生命周期机制演进中 | `chat.send`（Agent 事件流） |
| Client Streaming（渲染层流） | 多条请求帧 → 一响应 | 🔲 未开始 | terminal 输入（二期） |
| Bidi Streaming（双向流） | 双向消息帧 | 🔲 未开始 | 终端全双工（远期） |

判断一个方法用哪种模式，只看契约签名：普通方法返回 `Promise<T>`；流式方法返回 `RpcStream<E, R>`。

---

## 5. Unary：请求-响应

请求：渲染层 `transport.invoke(service, method, args)` → `ipcMain.handle` → `Router.dispatch`。

响应统一走**信封**，错误不依赖 IPC reject：

```typescript
type RpcResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: RpcErrorCode; message: string; data?: unknown } };
```

- Router 统一 catch handler 异常：异常不逃逸到 IPC 层，包装成 `HANDLER_ERROR` 信封
- web 侧 Proxy 客户端拆信封：`ok:false` 抛 `RpcError`，业务代码 try/catch 读 `code` / `message`
- 机制保留错误码：`SERVICE_NOT_FOUND` / `METHOD_NOT_FOUND` / `HANDLER_ERROR`；业务错误码由各服务自定义

---

## 6. Server Streaming：服务端流（现状 v1）

> ⚠️ 本节描述**当前已落地**的 v1 机制。已知的结构性缺陷与 v2 设计见
> [changes/stream-lifecycle/](../changes/stream-lifecycle/spec.md)。

### 6.1 句柄契约（消费端视角）

```typescript
interface RpcStream<E extends StreamEvent> {
  on<T>(type: T, cb: (data: ...) => void): () => void;  // 订阅业务事件
  once<T>(type: T, cb): () => void;                      // 订阅一次
  onEnd(cb: (err?: RpcError) => void): () => void;       // 终局：无参=正常，有参=异常/取消
  abort(): void;                                         // 取消
}
```

### 6.2 建立与帧协议

1. 流式方法被调用后，Router 识别服务返回的流句柄（marker symbol），分配 `streamId`
2. invoke 响应**立即**返回 `{ ok: true, data: { __stream: streamId } }`（同步给句柄，订阅先于帧到达）
3. 之后在 `rpc:stream` 通道推帧，v1 帧三态：

```typescript
interface StreamFrame {
  streamId: string;
  kind: 'next' | 'return' | 'throw';
  value?: unknown;
}
```

### 6.3 生产端：createRpcStream（v1 仅拉模式）

v1 唯一的流生产入口是生成器适配器：`createRpcStream(asyncGen)`，Router 后台泵：

- `gen.next()` 得到事件 → `next` 帧
- 生成器正常 return → `return` 帧
- 生成器 throw → `throw` 帧（`HANDLER_ERROR`）

服务通过 `stream.onAbort(cb)` 注册取消钩子（如 `agent.abort()`）；`on/once/onEnd` 在服务端也可作本地旁路（日志/测试）。

### 6.4 取消链路

```
渲染层 stream.abort()
  → transport.invoke('__stream', 'cancel', [streamId])   # 保留方法，不占业务契约
  → Router 置取消标记 + gen.return() 释放生成器 + 触发 onAbort 钩子
  → 推 throw(ABORTED) 帧 + 注册表清理
  → 渲染层 onEnd(RpcError{code:'ABORTED'})
```

### 6.5 v1 已知缺陷（本次演进的动因）

1. **协议终局不表达业务成败**：帧只有"生成器是否抛 JS 异常"。Agent 的业务失败（LLM 报错、超步数）是 yield 一个 `error` 事件后正常 return，协议层仍报 `return`（成功）。失败判定散落在业务消息约定里。
2. **结束靠业务事件**：`done` / `error` 既是 AgentEvent 又是结束信号，消费端必须记得订阅才能收敛状态，漏订阅即悬挂。
3. **生产端只有拉模式**：回调驱动的源（child_process / pty / SSE）要自己套 AsyncGenerator，没有显式的 emit/end/error API。
4. **终局幂等靠自律**：服务代码理论上可以在取消后继续产出，缺少句柄内部状态机强制"终局唯一"。
5. **取消的表达分裂**：既是 `throw(ABORTED)`（异常），Agent 又会 yield `done{reason:'aborted'}`（事件），两套说法。

---

## 7. 错误模型（现状）

| 失败类型 | 产生者 | Unary 形态 | Streaming v1 形态 |
| --- | --- | --- | --- |
| 服务 / 方法不存在 | Router | `{ok:false, SERVICE_NOT_FOUND/METHOD_NOT_FOUND}` | 同左（句柄建立前） |
| Handler 程序异常 | Router catch | `{ok:false, HANDLER_ERROR}` | `throw` 帧 `HANDLER_ERROR` |
| 业务失败 | 服务自行表达 | 抛异常 → `HANDLER_ERROR`（过粗） | 业务事件（无机制位置） |
| 取消 | 消费端 abort | — | `throw` 帧 `ABORTED` |

v2 目标：业务失败在流式场景有**机制级位置**（生产端可显式 `error(code, message)`）；错误结构在 unary 信封与流终局之间统一。

---

## 8. 客户端与双环境

- 双层 Proxy：运行时零方法清单，`service + method` 在调用时拼入载荷
- 流式方法需要同步返回句柄，客户端维护一份流式方法清单，用
  `satisfies StreamMethodsOf<MainServices>` 与契约绑定——契约新增流式方法而清单漏登记时编译报错
- `RpcStreamImpl` 时序保证：构造即同步订阅 `onStream` → 早于任何帧；streamId 绑定前的帧进 buffer，绑定后重放；终局后自动退订全部监听
- 纯浏览器（无 preload）下走 `mock.ts`：mock Transport 模拟整套信封与帧协议，UI 可独立调试

---

## 9. 服务注册与启动

主进程 `app.whenReady()`：

1. `new RpcRouter()`
2. `registerServices(router, app.getPath('userData'))`：构造 `ConfigServiceImpl`（先 `load()` 预载配置缓存）/ `ChatServiceImpl` / `FileServiceImpl`，共享 `WorkspaceState`（当前项目路径）
3. `bindIpc(router)`：注册 `ipcMain.handle`

---

## 10. 进行中的变更

- **stream-lifecycle**（设计讨论中）：把流式结束 / 错误升级为两端可显式调用的通信原语，
  引入生产端 Sink（emit / end / error）、唯一终局状态机、统一的终局三态（completed / failed / aborted）。
  Agent 主流程的消息传递只是该机制的第一个使用方。
  - 规格：[changes/stream-lifecycle/spec.md](../changes/stream-lifecycle/spec.md)
  - 方案（v0.1 提案，未定稿）：[changes/stream-lifecycle/design.md](../changes/stream-lifecycle/design.md)

远期：terminal 服务接入（client-stream / bidi 模式）时复用同一套流标识、终局与取消原语。
