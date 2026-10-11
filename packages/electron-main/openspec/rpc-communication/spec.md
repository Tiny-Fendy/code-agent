# 渲染层-主进程 RPC 通信机制 - 需求规格 (spec.md)

## 1. 背景

Electron 渲染进程与主进程的通信，现有方案是"手写每方法 API"模式：

- `shared/types/ipc.ts` 手工维护通道名常量
- `electron-preload` 手写每个方法的包装函数
- `web/src/bridge/types.ts` 手写与 preload 对应的 `WindowAPI` 接口

该模式已暴露的问题：

| 问题 | 具体表现 |
| --- | --- |
| 类型三处手写 | preload api 对象 / web 的 WindowAPI / 未来的 main handler 靠人肉同步，`testConnection` 返回类型两侧已经漂移 |
| 新增方法成本高 | 加常量 → preload 包装 → web 类型 → main handler，动 4~5 个文件 |
| 错误无约定 | `ipcRenderer.invoke` 跨进程后 Error 只剩 message，stack / 自定义字段全丢 |
| 流式无生命周期 | `onChatEvent` 裸订阅通道，没有流的 id、结束、清理、取消机制 |
| preload 不够薄 | 每加一个方法都要改 preload 并重新打包，而它是安全边界 |

本需求定义一套类 RPC 的通信机制：渲染层像调用本地方法一样调用主进程方法，类型、错误、流式由机制统一保证。

---

## 2. 目标

- web 层通过 `rpc.<service>.<method>(args)` 直接调用主进程方法，与调用本地模块无差别
- 类型单源：服务契约只在 shared 定义一次，客户端与服务端类型自动对齐，改契约任一侧另一侧编译报错
- 错误有统一信封：业务代码可以 try/catch，能拿到错误码与错误信息
- 流式调用：主进程的事件流推送到渲染层，渲染层通过流句柄以 `on` 事件订阅方式消费（`stream.on('text_delta', cb)`），像本地事件发射器
- 支持取消：渲染层能中断进行中的流式任务（如 Agent 思考循环）
- 新增一个服务方法只需改 2 处（契约 + 实现），preload 零改动
- 主进程侧 Router 为纯逻辑，不依赖 Electron 即可单元测试

---

## 3. 服务清单

第一期需要接入 RPC 的服务：

| 服务 | 方法（示例） | 类型 | 说明 |
| --- | --- | --- | --- |
| `config` | `get` / `set` / `testConnection` | 请求-响应 | 应用配置读写与连接测试 |
| `chat` | `send` / `confirmTool` | 流式 + 请求-响应 | 对话：send 返回 Agent 事件流句柄；confirmTool 回传工具确认结果 |
| `file` | `openFolderDialog` / `getFileTree` / `readFile` | 请求-响应 | 文件对话框与文件读取（渲染层 UI 用） |

`terminal` 服务（输入/输出流）后续按同样机制接入，第一期不实现。

---

## 4. 详细需求

### 4.1 请求-响应调用

**功能描述**：渲染层调用一个主进程方法，返回 `Promise`，resolve 为方法返回值。

**行为约束**：
- 客户端按 `service + method` 定位处理函数，运行时无需维护方法清单
- 参数与返回值必须是可结构化克隆的数据（plain object / array / 基础类型），禁止传函数、class 实例
- 同一调用不支持并发去重，每次调用独立

### 4.2 错误处理约定

**功能描述**：所有业务错误通过响应信封传递，不依赖 IPC 层的 reject。

**错误码**：
| 错误码 | 含义 |
| --- | --- |
| `SERVICE_NOT_FOUND` | 服务未注册 |
| `METHOD_NOT_FOUND` | 服务上不存在该方法 |
| `HANDLER_ERROR` | 方法执行抛出异常（业务错误） |
| `ABORTED` | 流被主动取消 |

**约束**：
- Router 统一 catch handler 异常并包装为错误信封，不允许异常直接抛到 IPC 层
- web 侧将错误信封还原为 `RpcError` 抛出，业务代码用 try/catch，可读取 `code` / `message`

### 4.3 流式调用

**功能描述**：流式方法返回一个 `RpcStream` 事件句柄，渲染层通过 `on` 订阅事件、`onEnd` 感知流结束、`abort` 取消流。

**句柄 API**：
| 方法 | 行为 |
| --- | --- |
| `on(type, cb)` | 订阅业务事件，返回退订函数 |
| `once(type, cb)` | 订阅一次，触发后自动退订 |
| `onEnd(cb)` | 流生命周期：正常结束 `cb()`；异常结束（含取消）`cb(RpcError)` |
| `abort()` | 取消该流 |

**行为约束**：
- 流必须有唯一 `streamId`，帧上携带以支持多流并存
- 调用方法同步返回句柄，`on` 注册先于任何事件帧到达，不丢事件
- 流帧分三类：`next`（数据）、`return`（正常结束）、`throw`（异常结束）
- `return` / `throw` 后服务端停止推送，渲染层自动清理订阅，不泄漏监听器
- 多个流可同时进行，互不干扰（如同时进行对话与终端输出）
- 流帧为 fire-and-forget 推送，第一期不做背压控制

### 4.4 取消 / 中断

**功能描述**：渲染层通过流句柄的 `abort()` 取消一个进行中的流式任务。

**约束**：
- 取消走 Router 内置的保留方法（`__stream.cancel`），不占用业务契约
- 主进程维护 `streamId → AbortController` 映射；服务实现通过句柄的 `onAbort` 钩子桥接中断逻辑（如 `agent.abort()`）
- 取消后对应流以 `throw`（`ABORTED`）帧收尾，渲染层 `onEnd` 收到携带 `ABORTED` 的错误

### 4.5 类型契约

**功能描述**：所有服务的接口定义集中在 shared 包，作为唯一事实来源。

**约束**：
- main 侧服务类必须 `implements` 契约接口
- web 侧客户端以契约接口为泛型约束
- 修改契约任一侧，另一侧未同步时必须编译报错

---

## 5. 安全要求

### 5.1 preload 暴露面
- preload 只暴露固定的原子传输函数（`invoke` / `onStream` 等），不暴露任何业务方法
- 新增服务方法时 preload 代码零改动，安全面不随业务增长

### 5.2 上下文隔离
- 保持 `contextIsolation: true`、`nodeIntegration: false`
- 渲染层只能通过桥接的原子函数通信，不能直接触达 Node 能力

### 5.3 数据边界
- 跨进程数据全部走结构化克隆，契约中不允许出现不可序列化的类型
- 主进程 handler 对入参做基本校验（服务实现层职责，本机制提供包装）

---

## 6. 非目标（第一期不做）

- 超时重试、请求重试策略
- 请求批量合并、去重、缓存
- 多窗口广播 / 按窗口路由（当前单窗口，推送到唯一 `webContents`）
- 流的背压控制（慢消费者处理）
- 从 IDL 生成代码（契约手写，类型靠 TS 推导）
- terminal 服务的流式接入（机制预留，第二期实现）
