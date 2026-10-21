# RPC 通信机制包（@code-agent/rpc）

> 渲染层 ↔ 主进程的统一通信机制，零业务概念。
> 流式通信不是独立能力，而是本机制支持的一种**交互模式**。

状态：已落地（Unary + Server Streaming v2：帧二态 / 终局三态 / 双形态生产端 / 错误结构单源 / 注册收口）。

---

## 1. 定位

让渲染层像调用本地对象一样调用主进程能力（`rpc.<service>.<method>(...)`），机制统一解决四件事：

1. **寻址**：调用如何定位到主进程处理函数
2. **数据**：跨进程参数与返回值如何编码
3. **错误**：失败如何结构化地传回渲染层
4. **生命周期**：长时间运行的调用如何推数据、如何结束、如何取消

设计原则：

| 原则 | 含义 |
| --- | --- |
| preload 哑管道 | 安全边界只暴露与业务无关的原子函数，新增方法零改动 preload |
| 信封化错误 | 错误是数据，不依赖 IPC reject（跨进程后 Error 丢字段） |
| 机制化生命周期 | 流的开始 / 数据 / 结束 / 错误 / 取消由机制提供，不靠业务消息约定 |
| 纯逻辑核心 | Router 不 import Electron，推流接口靠注入，可脱离 Electron 单测 |

## 2. 职责边界

**包内（机制）**：协议（通道 / 信封 / 帧 / 错误结构）、Router 与流状态机、preload 哑管道、渲染端客户端与流句柄、通用 mock Transport。

**包外（使用方职责）**：

- 服务契约（接口与 DTO）由消费应用自行定义，通过泛型参数传入 Router / createRpcClient
- 服务实现与依赖组装（Composition Root）
- 业务场景 mock 脚本（基于本包 mock 框架声明）
- 窗口安全设置（`contextIsolation` / `nodeIntegration` 等）

## 3. 包形态

按运行环境做 subpath exports，消费方各自只依赖对应子路径：

| 子路径 | 内容 | electron 依赖 |
| --- | --- | --- |
| `@code-agent/rpc/protocol` | 通道常量、信封、帧、StreamEnd、RpcErrorInfo、Sink/Handle 类型 | 无 |
| `@code-agent/rpc/main` | RpcRouter、createRpcStream、bindIpc | peerDependency（optional） |
| `@code-agent/rpc/preload` | `exposeRpcTransport()`：contextBridge 暴露哑管道 | peerDependency（optional） |
| `@code-agent/rpc/renderer` | createRpcClient 双层 Proxy、RpcStreamImpl 消费端句柄 | 无 |
| `@code-agent/rpc/mock` | 通用 mock Transport 框架（脚本化场景注入） | 无 |

泛化约束（本包必须持续满足）：通道名以常量导出、`StreamEvent` 不含业务字段、`RPC_*` 保留码通用、
Router 不 import electron、全包无任何业务概念。

## 4. 寻址与传输

- **单通道 dispatch**：所有请求走固定通道 `rpc:invoke`，方法定位靠载荷 `{ service, method, args }`。新增服务/方法不新增通道，preload 零改动。
- **服务注册表**：主进程启动时 `router.registerService(name, impl)`，名字与使用方契约映射的键一一对应。
- **数据边界**：参数与返回值必须可结构化克隆（plain object / array / 基础类型），禁止函数、class 实例跨进程。
- **推流通道**：固定通道 `rpc:stream`，主进程 → 渲染层，帧按 `streamId` 多路复用；`bindIpc` 用 `event.sender` 精确投递给发起请求的窗口。

## 5. 交互模式总览

通信按调用形态分模式（类比 gRPC 的四种调用模式）：

| 模式 | 形态 | 状态 |
| --- | --- | --- |
| **Unary（请求-响应）** | 一请求 → 一响应 | ✅ 已落地 |
| **Server Streaming（服务端流）** | 一请求 → 多条数据帧 + 唯一终局 | ✅ v2 已落地 |
| Client Streaming（渲染层流） | 多条请求帧 → 一响应 | 🔲 未开始（演进路径见 §10） |
| Bidi Streaming（双向流） | 双向消息帧 | 🔲 未开始（远期） |

判断一个方法用哪种模式，只看契约签名：普通方法返回 `Promise<T>`；流式方法返回 `RpcStream<E, R>`。

## 6. Unary：请求-响应

请求：渲染层 `transport.invoke(service, method, args)` → `ipcMain.handle` → `Router.dispatch`。

响应统一走**信封**，错误不依赖 IPC reject：

```typescript
type RpcResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: RpcErrorInfo };  // { code: string; message: string; data?: unknown }
```

- Router 统一 catch handler 异常：异常不逃逸到 IPC 层，包装成 `RPC_HANDLER_ERROR` 信封
- 渲染端 Proxy 客户端拆信封：`ok:false` 抛 `RpcError`（RpcErrorInfo 的 throwable 包装），业务代码 try/catch 读 `code` / `message` / `data`
- 机制保留错误码（常量 `RPC_ERROR`）：`RPC_SERVICE_NOT_FOUND` / `RPC_METHOD_NOT_FOUND` / `RPC_HANDLER_ERROR`

## 7. Server Streaming：服务端流

统一世界观：**一次调用 = 建立 → 0..n 数据消息 → 恰好一个终局**。

### 7.1 句柄契约（消费端视角）

契约层声明共同订阅面 `RpcStream<E, R>`（生产端 Sink 与消费端句柄的交集）：

- `on / once(type, cb)`：按事件类型订阅，回调参数精确推导
- `onEnd(cb)`：终局回调，`StreamEnd<R>` 穷尽三态：

```typescript
type StreamEnd<R> =
  | { status: 'completed'; result: R }        // 正常完成（业务终局可含在 R 中，见 7.6）
  | { status: 'failed'; error: RpcErrorInfo } // 机制 / 程序级失败
  | { status: 'aborted' };                    // 取消（独立终局态，不是错误）
```

消费端句柄 `RpcStreamHandle<E, R>` 在其上增加取消能力：

- `abort()`：主动取消，幂等
- `signal: AbortSignal`：只读，任意终局后进入 aborted（reason 携带终局信息），可与标准 API 联动
- `withAbortSignal(external)`：外部信号联动取消（组件卸载 / 超时统一接一个 controller）

### 7.2 建立与帧协议

1. 流式方法被调用后，Router 识别服务返回的流句柄（marker symbol），分配 `streamId`
2. invoke 响应**立即**返回 `{ ok: true, data: { __stream: streamId } }`（同步给句柄，订阅先于帧到达）
3. 之后在 `rpc:stream` 通道推帧，帧二态：

```typescript
type StreamFrame<E, R> =
  | { streamId: string; kind: 'next'; value: E }
  | { streamId: string; kind: 'end'; value: StreamEnd<R> };
```

### 7.3 生产端：双形态工厂

`createRpcStream()` 两种用法：

- **空参 = 推模式 Sink**：回调驱动的源（child_process / pty / SSE）直接显式驱动：
  `emit(event)` / `end(result)` / `error(info)` / `onAbort(cb)`；只读状态 `aborted` / `closed`
- **传 AsyncGenerator = 拉模式**：Router 后台泵：`yield` → next 帧；`return R` → end{completed, R}；
  throw → end{failed, RPC_HANDLER_ERROR} 兜底，流不悬挂

服务通过 `stream.onAbort(cb)` 注册取消钩子；`on/once/onEnd` 在服务端也可作本地旁路（日志/测试）。

### 7.4 终局状态机

```
                         emit() 有效 / next 帧
              ┌──────────────────────────────┐
              │                              │
        ┌─────▼─────┐  end(result)   ┌───────────────┐
        │           │ ─────────────→ │  completed    │
 创建 → │   open    │  error(err)    ├───────────────┤
        │           │ ─────────────→ │    failed     │ ──→ closed
        └─────┬─────┘                ├───────────────┤
              │  cancel (远端/本地)   │   aborted     │
              └────────────────────→ └───────────────┘
```

机制保证（Router 与两侧句柄共同实现）：

1. 三个终局入口（end / error / cancel）走**同一把锁**：同 tick 内"服务 end"与"远端 cancel"竞争也只产生一个 end 帧
2. 终局后：emit 丢弃（返回 false）；end/error 重复调用 no-op；注册表项删除
3. handler 同步阶段就抛异常（连流都没建起来）：仍走 invoke 信封 `{ ok:false }`；流建立之后的一切失败都走 end(failed)，不再回到信封
4. 拉模式下生成器意外 throw / 泵自身异常：兜底 end(failed, RPC_HANDLER_ERROR)，流绝不悬挂
5. 消费端句柄收到 end 帧后：派发 onEnd → 清空事件回调 → 退订全局 onStream

服务代码不再需要自律保证幂等——**恰好一个终局帧，先到者赢**。

### 7.5 取消链路

```
渲染层 stream.abort()（或外部 AbortSignal 联动）
  → transport.invoke('__stream', 'cancel', [streamId])   # 保留方法，不占业务契约
  → Router 终局锁竞争（已终局则 no-op）→ 触发 onAbort 钩子 + 终止泵
  → 推 end{aborted} 帧 + 注册表清理
  → 渲染层 onEnd({status:'aborted'})
```

- 取消是**独立终局态**而非错误，UI 对 aborted 通常静默复位
- Unary 没有取消（一帧即终局，调用寿命只有一次 IPC 往返）；取消是**有数据消息阶段**的模式才需要的生命周期操作

### 7.6 业务失败的表达位置

业务失败有两个机制级位置，按语义选择：

- **程序 / 机制级失败**：`sink.error({ code, message, data? })` → end{failed}
- **业务终局在结果类型中表达**：终局结果 `R` 自身穷尽业务结局，随 end{completed} 的 result 送达；
  事件流不再含 error / done 结束事件（结束语义只有一处）

消费端收口只有一处：`onEnd` 先按协议三态分支，completed 内再按 `R` 分业务终局。

## 8. 错误模型

单源错误结构 `RpcErrorInfo { code: string; message: string; data?: unknown }`：Unary 信封的 error
与流终局 end{failed} 的 error 共用同一形状；渲染端 `RpcError` 是其 throwable 包装。

错误码命名空间物理隔离：机制保留码（常量 `RPC_ERROR`）占用 `RPC_*` 段；业务码自由字符串，
约定带服务前缀（如 `xxx.YYY_FAILED`），禁止 `RPC_` 前缀。

| 失败类型 | 产生者 | Unary 形态 | Streaming 形态 |
| --- | --- | --- | --- |
| 服务 / 方法不存在 | Router | `{ok:false, RPC_SERVICE_NOT_FOUND / RPC_METHOD_NOT_FOUND}` | 同左（句柄建立前） |
| Handler 程序异常 | Router catch | `{ok:false, RPC_HANDLER_ERROR}` | end{failed, RPC_HANDLER_ERROR} |
| 业务失败 | 服务显式表达 | 抛异常 → RPC_HANDLER_ERROR | end{failed, 业务码}，或按结果类型表达（见 7.6） |
| 取消 | 消费端 abort | — | end{aborted}（独立终局态，不是错误） |

## 9. 客户端（renderer 面）

- 双层 Proxy：运行时零方法清单，`service + method` 在调用时拼入载荷
- 流式方法需要同步返回句柄，客户端维护一份流式方法清单，用
  `satisfies StreamMethodsOf<TServices>` 与契约绑定——契约新增流式方法而清单漏登记时编译报错
- `RpcStreamImpl` 时序保证：构造即同步订阅 `onStream` → 早于任何帧；streamId 绑定前的帧进 buffer，绑定后重放；终局后自动退订全部监听
- 句柄 `signal` / `withAbortSignal` 与标准 AbortSignal 互操作：组件卸载、超时等外部取消源可统一接入
- 契约中声明为 `RpcStream` 的返回类型，客户端在类型层升级为 `RpcStreamHandle`（`RpcClient<TServices>` 映射）
- 纯浏览器（无 preload）下可用 `@code-agent/rpc/mock` 声明场景脚本，client 与句柄一行不改跑在浏览器里，UI 可独立调试

## 10. 未来模式的演进路径（已落地部分不设障）

- **Client Streaming**：新增渲染→主方向的数据帧（新帧 kind 或复用 `rpc:stream` 双向化），
  终局仍是主→渲染的唯一信封；streamId 在建立时由 invoke 响应分配，规则不变
- **Bidi**：两端各持 Sink + Handle，终局帧双向各一；终局锁、取消钩子、资源清理逻辑直接复用
- 现有协议决策已满足：帧按 streamId 归属与方向无关、终局判别结构对称、
  取消不绑定"只能由消费端发起"的假设（渲染→主方向取消沿用 `__stream.cancel` 同一链路）

## 11. 服务注册辅助

Router 提供两层注册 API：

- `registerService<K extends keyof TServices>(name: K, service: TServices[K])`：泛型绑定契约，名与实现编译期对齐
- `registerAll(instances)`：数组注册，注册名读取实例的 `serviceName` 字段——
  该字段由契约侧 `ServiceDef<N>` 接口显式声明（如 `ConfigService extends ServiceDef<'config'>`），
  实现类 `implements` 契约时被字面量类型强制提供；实例缺字段或结果不在构造参数
  `serviceKeys` 白名单内即启动 throw（fail fast）。
  服务名的单源事实是契约接口，不依赖类名约定，构建压缩改名无影响

## 12. 已知限制与非目标

- Unary 业务错误码暂无机制级位置（抛异常统一收敛为 RPC_HANDLER_ERROR），属独立议题
- 取消仅支持消费端发起；服务端主动取消（反向 end 帧）随 client-stream / bidi 二期细化
- 本包不包含：服务契约定义、业务 mock 场景、依赖组装——均为使用方职责

## 13. 路线图

- **Phase 2（规划）**：独立构建（双格式 + dts）、最小示例工程、版本与 CHANGELOG，具备发 npm 条件

## 14. 变更记录

- 2026-10：文档自 `packages/electron-main/openspec/systems/rpc-communication.md` 迁入，
  机制内容与应用组装视图分离；终局状态机、演进路径等细节自 `changes/rpc-communication-v2/design.md` 提炼补全。
- 2026-10-18：服务注册名来源由类名推导（`serviceNameOf`）改为契约接口显式声明——
  契约侧新增 `ServiceDef<N>`（`serviceName` 字面量字段）与 `MainServices` 键一致性编译期校验，
  Router 删除 `serviceNameOf`，`registerAll` 直接读实例字段；客户端 RpcClient 类型映射排除该元字段。
