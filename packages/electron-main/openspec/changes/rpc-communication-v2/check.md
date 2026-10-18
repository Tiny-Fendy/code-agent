# IPC / RPC 通信方案 v2（Phase 0）- 验收清单 (check.md)

> 验收范围仅 Phase 0：v2 在现有包内落地。Phase 1 抽包 / 更名、Phase 2 发布不在本清单。
> 需求条目对应 [spec.md](./spec.md) F1–F24；决策对应 [design.md](./design.md) D1–D16。

## 1. 协议验收（F16–F19 / F22）

### 帧与终局
- [x] 帧只有两态：`next`（数据）与 `end`（唯一终局帧），无 `return / throw` 帧
- [x] 每条流恰好一个 end 帧，end 之后机制不再发任何帧
- [x] `StreamEnd<R>` 为穷尽三态：`completed`（携带 result:R）/ `failed`（携带 error）/ `aborted`
- [x] 帧载荷全部可结构化克隆：无函数、无 class 实例、无 JS Error 跨进程

### 错误结构（D11 / F22）
- [x] unary 信封 error 与流终局 error 同为 `RpcErrorInfo { code, message, data? }`，shared 单源
- [x] 机制保留码仅：`RPC_SERVICE_NOT_FOUND` / `RPC_METHOD_NOT_FOUND` / `RPC_HANDLER_ERROR`
- [x] `ABORTED` 不再作为错误码存在；代码中无业务码使用 `RPC_` 前缀
- [x] web 侧抛出的 `RpcError` 可 try/catch，code/message/data 可读

---

## 2. Router 单元测试验收（不启动 Electron，F11–F15 / F23–F24）

### Unary 零回退
- [x] 注册方法正常调用：参数逐个展开，返回 `{ ok:true, data }`
- [x] 未注册服务 → `RPC_SERVICE_NOT_FOUND`；方法不存在 → `RPC_METHOD_NOT_FOUND`
- [x] handler 抛异常 → `RPC_HANDLER_ERROR` 信封，异常不逃逸 dispatch

### 推模式源（形态 A，F1–F5）
- [x] 空参 createRpcStream 得到 Sink：emit 推 next 帧，open 时返回 true
- [x] `end(result)` 推 end{completed, result}；`error(info)` 推 end{failed}，业务自定义码原样到达
- [x] `onAbort` 注册的钩子在取消时恰好触发一次；`aborted` / `closed` 状态正确
- [x] 模拟 child_process 式回调源（emit + 显式 error）全链路工作

### 拉模式源（形态 B，F6）
- [x] generator yield 序列 → next 帧；return R → end{completed, result:R}
- [x] generator throw → end{failed, RPC_HANDLER_ERROR}，流不悬挂

### 终局状态机（F11–F15 / F24）
- [x] end / error / cancel 同 tick 竞争：first-wins，**end 帧恰好一个**
- [x] 终局后 emit 返回 false 且无帧发出；end/error 重复调用静默 no-op
- [x] 取消与正常结束同时发生：只有一种终局，onAbort 钩子与终局结果不错乱
- [x] 取消已终局的流（`__stream.cancel` 迟到）：no-op，不产生第二帧
- [x] 泵自身异常 / generator 意外 throw：兜底 failed，注册表项删除
- [x] 双流并发：streamId 各自独立，帧与终局互不串扰

### 注册收口（D12a）
- [x] `registerAll` 按 `XxxServiceImpl → xxx` 正确推导三个现有服务名
- [x] 传入未实现契约的对象：编译期报错（类型试验）
- [x] 类名无法映射到契约键：启动同步 throw（fail fast 有测试）
- [x] `registerService<K, MainServices[K]>` 泛型对错误名字/错误实例编译报错

---

## 3. 类型契约验收（编译期，F9 / F20–F22）

- [x] 契约流式方法同时声明事件类型与终局结果：`send(...): RpcStream<AgentEvent, SendResult>`
- [x] onEnd 回调漏处理 completed / failed / aborted 任一状态时**编译报错**（编译探针验证）
- [x] `stream.on('text_delta', cb)` 回调参数仍有精确事件类型
- [x] 服务实现类 `implements` 契约，签名漂移编译报错
- [x] web 调用不存在的服务 / 方法编译报错
- [x] Sink 为消费端契约的结构超集，服务实现无类型强转

---

## 4. 取消与 AbortSignal 验收（D4 / D10b）

- [x] `stream.abort()` → `__stream.cancel` → 主进程终局 aborted → onEnd 收到 `{status:'aborted'}`
- [x] aborted 在 UI 不表现为错误（无错误弹窗），loading 状态正确复位
- [x] 句柄只读 `signal` 在三种终局后均为 aborted 状态
- [x] 传入外部 `AbortSignal`：外部 controller.abort() 能取消流；流自行终局后外部监听被移除（无悬挂监听）
- [x] 取消桥接生效：ChatServiceImpl 的 onAbort 调用 `agent.abort()`，Agent 循环停止
- [x] 取消后再次发送消息可正常建立新流；主进程不再向旧流推任何帧

---

## 5. Agent 深接入验收（D5a）

- [x] AgentEvent 联合中不存在 `error` / `done` 事件（grep 验证）
- [x] `Agent.run()` 类型为 `AsyncGenerator<AgentEvent, SendResult>`
- [x] 四个退出点均有测试：completed（统计信息在 result 中）/ LLM 失败 / 超步数 / aborted
- [x] 失败时协议层终局为 failed（或按结果类型表达的失败终局），UI 不依赖业务事件判失败
- [x] ChatServiceImpl 不含 Agent 事件语义判别（无 `if (event.type === 'error')` 一类适配代码）

---

## 6. Unary 与既有功能回归

- [x] config.get / set 行为不变，配置持久化（重启生效）
- [x] testConnection 失败时抛 RpcError，code/message 可读（码名已换 RPC_ 前缀）
- [x] file 对话框 / 文件树 / readFile 行为不变
- [x] preload 零改动（或仅类型 import 更新）；哑管道仍只有 invoke / onStream

---

## 7. 安全与边界验收

- [x] preload 源码无任何业务方法名（grep）
- [x] `contextIsolation: true`、`nodeIntegration: false` 不变
- [x] window 上仅 transport 一个注入，且只含原子函数
- [x] 篡改载荷调不存在服务 / 方法：渲染层收到结构化信封错误，应用不崩溃
- [x] bindIpc 保持薄适配无业务逻辑；Router.ts 不 import electron
- [x] 机制代码中无 Agent / chat / file 等业务概念（为 Phase 1 泛化审计预检）

---

## 8. 端到端手工验收

- [ ] `pnpm dev`：配置读写正常
- [ ] 完整对话：发消息 → text_delta 流式渲染 → 工具调用事件 → 结果回灌 → 最终回答，onEnd completed 收口
- [ ] LLM 报错 / 超步数：onEnd 收口（completed + SendResult.llmFailed/maxSteps），UI 展示错误信息，可重新发起对话
- [ ] 点停止：onEnd aborted，UI 静默复位；中断后能立即开始新对话
- [ ] 纯浏览器 mock 模式：completed / llmFailed(/fail) / aborted 三种假收尾均可调试
- [x] `pnpm typecheck`（5 包）全绿；`pnpm build` 通过；agent-core 与 electron-main 测试全绿

> 以上 5 项为**遗留手工项**：需真实 Electron + LLM API key 环境（mock 项需浏览器）人工执行，
> 代码侧无可自动化验证的剩余工作。

---

## 9. 文档与收尾

- [x] systems/rpc-communication.md 已更新为 v2 现状（协议、终局、错误码、注册收口、组装纪律引用）
- [x] spec/design 状态标记为已实现；本清单与 tasks.md 勾选完整
- [x] 全仓 grep 无旧协议残留：帧 `'return'/'throw'`、错误码 `ABORTED`、`HANDLER_ERROR` 旧名
- [x] Phase 1（packages/rpc 抽离、shared→contracts 更名）**确认未混入本次改动**，已另立后续 change
