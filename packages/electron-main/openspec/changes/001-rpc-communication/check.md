# 渲染层-主进程 RPC 通信机制 - 验收清单 (check.md)

## 1. 协议验收

### 信封结构
- [ ] 成功响应：`{ ok: true, data }`
- [ ] 失败响应：`{ ok: false, error: { code, message } }`
- [ ] 错误码覆盖四种：`SERVICE_NOT_FOUND` / `METHOD_NOT_FOUND` / `HANDLER_ERROR` / `ABORTED`
- [ ] `rpc:invoke` / `rpc:stream` 两个通道名与协议定义一致

### 流式帧
- [ ] `StreamFrame` 含 `streamId` / `kind` / `value`
- [ ] `kind` 三种取值：`next` / `return` / `throw`

---

## 2. Router 单元测试验收（不启动 Electron）

### 分发
- [ ] 注册的服务方法可被 `dispatch` 调用，参数逐个展开传入
- [ ] 未注册的服务返回 `SERVICE_NOT_FOUND`
- [ ] 服务上不存在的方法返回 `METHOD_NOT_FOUND`
- [ ] handler 抛异常返回 `HANDLER_ERROR`，异常不逃逸出 `dispatch`
- [ ] 返回值原样出现在 `data` 中（对象 / 数组 / 基础类型）

### 流式
- [ ] `createRpcStream(gen)` 产生的句柄被 `dispatch` 识别（marker symbol）
- [ ] `dispatch` 先返回 `{ ok: true, data: { __stream } }`
- [ ] `__stream` 为非空唯一 id，多次调用 id 不同
- [ ] next 帧按生成顺序推送，`value` 与 yield 的值一致
- [ ] 生成器正常结束推送 `return` 帧
- [ ] 生成器抛异常推送 `throw` 帧
- [ ] `__stream.cancel(streamId)` 后：推送 `throw` 帧（`ABORTED`），句柄 `onAbort` 钩子被调用
- [ ] 流结束后注册表中该项被清理（无泄漏）
- [ ] 两个流同时进行，帧的 `streamId` 互不混淆

---

## 3. 类型契约验收（编译期）

- [ ] 服务实现类 `implements` 契约接口，缺少方法 / 签名不符时编译报错
- [ ] web 侧 `createRpcClient<MainServices>()` 调用不存在的方法时编译报错
- [ ] `rpc.config.get()` 返回类型为 `Promise<AppConfig>`，字段有提示
- [ ] `rpc.chat.send()` 返回类型为 `RpcStream<AgentEvent>`
- [ ] `stream.on('text_delta', cb)` 的回调参数有精确类型提示
- [ ] 契约中无不可序列化类型（无函数 / class 实例字段），且无服务级 `abort` 方法（取消由句柄承担）

---

## 4. 请求-响应集成验收

- [ ] 渲染层 `rpc.config.get()` 能读到主进程配置
- [ ] `rpc.config.set()` 写入后重启应用仍生效（持久化）
- [ ] `rpc.config.testConnection()` 错误时抛出 `RpcError`，`code` / `message` 可读
- [ ] `rpc.file.getFileTree()` 返回正确的树结构

---

## 5. 流式集成验收

- [ ] 发送消息后同步拿到流句柄，`on` 订阅不丢早期事件
- [ ] `stream.on('text_delta')` 实时渲染增量文本
- [ ] `tool_call_start` / `tool_call_result` 事件按序到达并可渲染
- [ ] 流正常结束时 `onEnd()` 无参触发，UI 无残留订阅（DevTools 无警告）
- [ ] LLM 报错时流以 `throw` 收尾，`onEnd(err)` 收到错误，UI 展示错误信息
- [ ] 渲染层只收到属于自己 `streamId` 的帧

---

## 6. 取消 / 中断验收

- [ ] 流式进行中调用 `stream.abort()`，流尽快以 `throw`（`ABORTED`）收尾
- [ ] `onEnd(err)` 收到 `ABORTED` 错误，UI 状态正确复位
- [ ] 取消桥接生效：`ChatServiceImpl.onAbort` 调用 `agent.abort()`，Agent 循环停止
- [ ] 中断后再次发送消息可正常开始新流
- [ ] 中断后主进程不再推送该流任何帧

---

## 7. 安全验收

- [ ] preload 源码中不出现任何业务方法名（grep 验证）
- [ ] `contextIsolation: true`、`nodeIntegration: false` 保持不变
- [ ] 渲染层 `window` 上只有 `transport` 一个新增注入，且只含原子函数
- [ ] 篡改载荷调用不存在的服务，渲染层收到结构化错误而不是崩溃

---

## 8. 端到端验收

- [ ] `pnpm dev` 启动，配置页读写配置正常
- [ ] 完整对话链路：发消息 → 流式输出 → 工具调用 → 结果回灌 → 最终回答
- [ ] 点停止按钮调 `stream.abort()` 能中断；中断后能继续新对话
- [ ] 纯浏览器打开渲染层（无 Electron），mock 模式 UI 可调试（含假事件流）
- [ ] `pnpm typecheck` 全绿，`pnpm build` 通过
- [ ] 全仓库无 `IPC_CHANNELS` / `WindowAPI` 残留引用

---

## 9. 代码质量验收

- [ ] Router.ts 不 import 任何 electron 模块
- [ ] bindIpc.ts 保持薄适配（无业务逻辑）
- [ ] `createRpcStream` 是唯一的生成器 → 流句柄适配入口，服务内无绕过
- [ ] 服务实现内部委托 agent-core / fs 等既有模块，不重复造轮子
- [ ] 注释覆盖关键设计点（流式判定、句柄生命周期、信封约定、取消链路）
- [ ] 遵循项目约定：包内模块不做 re-export，类型从 shared 直接引用
