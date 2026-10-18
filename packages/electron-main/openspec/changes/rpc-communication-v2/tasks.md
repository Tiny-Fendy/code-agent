# IPC / RPC 通信方案 v2（Phase 0）- 任务拆解 (tasks.md)

> 范围：仅 Phase 0——v2 机制在**现有包内原地落地**。
> Phase 1（建 `libs/rpc`、shared → contracts 更名）**已完成**，执行记录见文末附录；
> Phase 2（独立构建 / 发 npm）未启动。
> 决策依据见 [design.md](./design.md) D1–D16（按当前倾向执行）。

## 开发顺序说明

沿用 v1 验证过的顺序："先协议、再纯逻辑核心、再两端适配、最后业务接入"：

1. **协议层**（shared）：帧二态化、终局类型、错误结构单源——两侧共同地基
2. **Router 纯逻辑**（main）：终局状态机 + 双形态工厂 + 注册收口，可脱离 Electron 单测
3. **Electron 薄皮与服务适配**（main）：bindIpc 适配新帧，服务切换 Sink API
4. **web 消费端**：三态 onEnd、AbortSignal 互操作、mock 同步
5. **Agent 深接入**（agent-core + shared DTO + UI）
6. **全量验证**

---

## Task 1: 协议层 v2（shared）

**优先级**：P0
**对应决策**：D1 / D3 / D4 / D6 / D10(b) / D11

**任务内容**：

- [x] `shared/src/rpc/protocol.ts` 帧协议二态化：
  - [x] `StreamFrame<E,R>` 改为 `{kind:'next', value:E}` | `{kind:'end', value:StreamEnd<R>}`，删除 `return / throw`
  - [x] 新增 `StreamEnd<R>`：`{status:'completed', result:R}` | `{status:'failed', error:RpcErrorInfo}` | `{status:'aborted'}`
  - [x] 新增单源错误结构 `RpcErrorInfo { code: string; message: string; data?: unknown }`；`RpcResponse<T>` 的 error 改用它
  - [x] `RpcError` 类保留为 web 侧 throwable 包装（构造入参改 `RpcErrorInfo` 同形状）
- [x] 错误码命名空间（D11）：
  - [x] 机制保留码常量改名 `RPC_SERVICE_NOT_FOUND` / `RPC_METHOD_NOT_FOUND` / `RPC_HANDLER_ERROR`，删除 `ABORTED`
  - [x] 注释写明：业务码禁止 `RPC_` 前缀，约定带服务前缀（如 `chat.LLM_FAILED`）
- [x] 生产端类型：`RpcStreamSink<E,R>`（emit/end/error/onAbort/aborted/closed + 本地旁路 on/onEnd）
- [x] 消费端类型：`RpcStream<E,R>` 的 onEnd 升级为 `(result: StreamEnd<R>) => void`
- [x] AbortSignal 互操作类型位（D10b）：句柄暴露只读 `signal: AbortSignal`；
  流式方法调用支持可选传入外部 `AbortSignal`（在客户端层实现，协议不新增帧，取消仍走 `__stream.cancel`）
- [x] 契约 `shared/src/rpc/contract.ts`：`send` 签名改为 `RpcStream<AgentEvent, SendResult>`
  （SendResult 随 Task 5 在 agent 类型中定义；本任务先落泛型位，可暂以 `unknown` 占位并在 Task 5 收紧）

**验收标准**：

- `pnpm --filter @code-agent/shared build` 通过
- 全包 grep 无 `kind: 'return' | 'throw'`、无裸 `ABORTED` 码残留
- 协议文件零 electron / 零业务 import

---

## Task 2: Router 终局状态机与双形态工厂（main，纯逻辑）

**优先级**：P0
**对应决策**：D2 / D3 / D4 / D7 / D12(a) / D14

**任务内容**：

- [x] 重写 `electron-main/src/rpc/Router.ts` 流核心：
  - [x] 每条流持有 open → closed(completed/failed/aborted) 状态；end / error / cancel 三个入口走**同一把终局锁**，first-wins
  - [x] 终局恰好一个 `end` 帧；终局后 `emit` 返回 false 且丢弃；end/error 重复调用 no-op
  - [x] 终局时清理：流注册表删除、订阅清理；消费端侧清理在 Task 4
  - [x] handler 同步阶段抛异常（流未建立）→ invoke 信封 `RPC_HANDLER_ERROR`；流建立后的失败一律走 `end{failed}`
  - [x] 生成器 throw / 泵自身异常 → 兜底 `end{failed, RPC_HANDLER_ERROR}`，流不悬挂
  - [x] 取消链路：`__stream.cancel` → 终局锁竞争（已终局则 no-op）→ gen.return() / onAbort 钩子 → `end{aborted}`
- [x] 双形态 `createRpcStream`（D2）：
  - [x] 空参：推模式 Sink（回调源直接 emit/end/error）
  - [x] 传 `AsyncGenerator<E,R>`：自动泵，next→emit、return R→end(R)、throw→failed
  - [x] 保留服务端本地旁路 on / once / onEnd（D7），marker symbol 识别不变
- [x] 注册收口（D12a）：
  - [x] `registerService<K extends keyof MainServices>(name: K, service: MainServices[K])` 泛型收紧
  - [x] 新增 `registerAll(router, instances[])` 与 `serviceNameOf`（`constructor.name` 去 `ServiceImpl` 后缀并首字母小写），推导名不在契约键中即 throw
  - [x] `services/index.ts` 切换为 registerAll 数组写法（组装根位置不变，仍为唯一 new 处，D14 纪律无额外代码任务）
- [x] 重写 `Router.test.ts`（node:test，假服务 + 假 emitter）：
  - [x] Unary：成功 / 服务缺失 / 方法缺失 / handler 异常（断言新码名）
  - [x] 推模式源：emit 序列 + 显式 end(R)；显式 error(业务码)
  - [x] 拉模式源：generator 正常 return R / throw 兜底
  - [x] F24 竞态全集：end 与 cancel 同 tick 竞争仅一个 end 帧、终局后 emit 被丢弃且返回 false、
        重复 end no-op、终局后注册表无残留、双流并发帧不串
  - [x] 注册收口：registerAll 正常推导；非契约实例 / 类名不符时 fail fast

**验收标准**：

- `pnpm --filter @code-agent/electron-main test` 全绿
- 每个流式用例断言 end 帧恰好一个、其后 emitter 再无调用
- Router.ts 仍不 import electron

---

## Task 3: Electron 薄皮适配（main）

**优先级**：P0

**任务内容**：

- [x] `bindIpc.ts` 适配新帧结构（emitter.send 形状不变，消费协议类型更新）；`event.sender` 精确投递与 isDestroyed 守卫保留
- [x] 错误码更名随 Router 自动生效，确认信封链路无旧码字符串
- [x] preload `index.ts` **零改动**（哑管道不感知帧形态）——若类型报错仅做 import 类型更新

**验收标准**：

- [x] bindIpc 仍无业务逻辑；preload 文件 grep 无业务方法名
- [x] `pnpm --filter @code-agent/electron-preload typecheck` 通过

---

## Task 4: web 消费端适配

**优先级**：P0
**对应决策**：D9 穷尽三态 / D10(b)

**任务内容**：

- [x] `web/src/bridge/stream.ts`：
  - [x] `onEnd(cb: (result: StreamEnd<R>) => void)` 三态派发；收到 end 帧后清空事件回调并退订全局 onStream
  - [x] 构造同步订阅 + streamId 绑定前 buffer 重放语义保留；buffer 中的 end 帧同样正确派发
  - [x] 暴露只读 `signal: AbortSignal`：completed/failed/aborted 均使 signal abort（aborted 时 `signal.reason` 可区分；其余终局 reason 为终局信息）
  - [x] 支持外部 AbortSignal 联动：外部 abort → 内部 `abort()`（一次性监听，终局后移除）
  - [x] `abort()` 行为不变：invoke `__stream.cancel`
- [x] `web/src/bridge/client.ts`：
  - [x] 流式方法创建句柄时透传可选外部 signal；错误拆包改用 `RpcErrorInfo` 形状
  - [x] streamMethods 清单的 `satisfies` 约束在 RpcStream 泛型升级后仍成立
- [x] `web/src/bridge/mock.ts`：mock Transport 改发 next/end 帧；支持注入 completed / failed(业务码) / abort 三种收尾；mock 取消产出 `end{aborted}`

**验收标准**：

- [x] 类型试验（可临时加注释代码或编译探针）：onEnd 回调中 switch 漏写任一 status 分支时编译报错
- [x] 纯浏览器 mock 模式：三态收尾均可触发，终局后无事件泄漏
- [x] `pnpm --filter @code-agent/web typecheck` 通过

---

## Task 5: Agent 深接入（第一个使用方）

**优先级**：P0
**对应决策**：D5(a) 深接入

**任务内容**：

- [x] `shared/src/types/agent.ts`：
  - [x] 删除 AgentEvent 联合中的 `error` / `done` 事件类型（结束语义不再走业务事件）
  - [x] 新增终局结果类型 `SendResult`，穷尽四个退出点：completed（含用量/步数等统计）/ llmFailed（结构化错误信息）/ 超步数 / aborted（具体字段实现时定，须可结构化克隆）
- [x] `agent-core`：
  - [x] `Agent.run()` 签名改为 `AsyncGenerator<AgentEvent, SendResult>`
  - [x] 正常完成 / LLM 失败 / 超步数分别 `return` 对应 SendResult；被 abort 时 return aborted 结果（不再 throw 表达取消）
  - [x] 更新 / 新增 agent-core 单测覆盖四个退出点
- [x] `ChatServiceImpl`：保持纯适配层，`createRpcStream(agent.run(message))` 形态 B 包装；
  `onAbort(() => agent.abort())` 保留；删除 v1 时代对 error/done 事件的任何特殊处理
- [x] `App.tsx` 冒烟 UI 适配：
  - [x] 订阅列表去掉 error/done 分支；唯一收口在 onEnd：completed 展示结果、failed 弹错误提示、aborted 复位不报错
  - [x] 停止按钮可继续直接调 `abort()`；如顺手可行，演示外部 AbortSignal 联动（非必须）

**验收标准**：

- [x] `pnpm --filter @code-agent/agent-core test` 全绿
- [x] 全包 grep：AgentEvent 无 `type:'error' | 'done'`；UI 无业务级结束事件订阅
- [x] `pnpm typecheck` 五包全绿

---

## Task 6: 全量验证与文档回写

**优先级**：P0

**任务内容**：

- [x] `pnpm typecheck`（5 包）、`pnpm build`、electron-main 与 agent-core 测试全部通过
- [ ] 手工冒烟（见 check.md 第 8 节）：配置读写 / 流式对话 / 工具调用 / 失败提示 / 停止中断 / 中断后重开
  （**遗留**：需真实 Electron + LLM API key 环境人工执行；自动化层已由 Router 20 用例 + agent-core 92 用例 + 五包 typecheck/build 覆盖）
- [x] 回写系统文档 `systems/rpc-communication.md`：状态从"v1 已落地 + v2 演进中"更新为 v2 现状
  （帧协议、终局三态、错误码、注册收口），并将进行中变更链接标记为已完成；第 6/7 节 v1 描述替换
- [x] 本 change 的 spec/design 状态更新为已实现；tasks/check 勾选收尾
- [x] **不在本次做**：建 `packages/rpc`、shared → contracts 更名（Phase 1，另立 change）

**验收标准**：

- [x] check.md 全部勾选，或遗留项有明确记录
- [x] 无旧协议残留：全仓 grep `'return' | 'throw'` 帧 kind、`ABORTED` 错误码、旧错误码名均无命中

---

## 依赖关系图

```
Task 1 (shared 协议) ──→ Task 2 (Router 状态机/注册收口 + 测试) ──→ Task 3 (bindIpc 适配) ──┐
                       └──────────────────────────────────────→ Task 4 (web 消费端/mock) ──┼──→ Task 6 (全量验证+文档)
                       ──→ Task 5 (Agent 深接入：DTO/agent-core/UI) ──────────────────────┘
```

- Task 1 最先做
- Task 2 是核心，Task 4 可与 Task 2/3 并行起步（先按协议类型 mock）
- Task 5 依赖 Task 1 的泛型位与 Task 2 的形态 B，UI 改动依赖 Task 4
- Task 6 最后；Phase 1 抽包必须在本 change 验收后另立，禁止边写边迁（D15c 已否决）

---

## 附录：Phase 1 执行记录（抽包 + 更名，已完成）

按 design.md 第 11 节执行，行为零变化：

- [x] 新建 `libs/rpc`（`@code-agent/rpc`）：subpath exports `./protocol | ./main | ./preload | ./renderer | ./mock`，
  electron 为 optional peerDependency（初版落地 `packages/rpc`，后与 fetch-sse-client 一并归入 `libs/`
  通用基础库目录，pnpm-workspace 增加 `libs/*`，消费方 tsconfig references 同步更新）
- [x] 机制迁移（git mv 保留历史）：`shared/src/rpc/protocol.ts` → `rpc/src/protocol.ts`；
  `electron-main/src/rpc/{Router,bindIpc}.ts` → `rpc/src/main/`；`web/src/bridge/{client,stream}.ts` → `rpc/src/renderer/`；
  `Router.test.ts` → `rpc/test/main/`（20 用例随包迁移全绿）
- [x] preload 逻辑函数化为 `rpc/src/preload` 的 `exposeRpcTransport()`；web mock 拆分为
  `rpc/src/mock` 通用框架（脚本化场景注入 + 取消链路）+ `web/src/bridge/mock.ts` 纯业务场景声明
- [x] `packages/shared` → `packages/contracts`（`@code-agent/contracts`）更名；
  `index.ts` 不再 re-export protocol，`contract.ts` 从 `@code-agent/rpc/protocol` 导入 `RpcStream`
- [x] 四个消费包（electron-main / electron-preload / web / agent-core）package.json、tsconfig references、
  import 全部改写：机制类型走 `@code-agent/rpc/*`，业务类型走 `@code-agent/contracts`
- [x] 根脚本更新：`build:packages = build:rpc && build:contracts && build:agent`
- [x] 全量验证：pnpm install 绿；rpc / contracts / agent-core 构建绿；7 包 typecheck 绿；
  electron-vite 全量 build 绿；Router 20 用例 + agent-core 94 用例全绿；
  代码与配置 grep 无 `@code-agent/shared` 残留
- [x] 文档回写：`systems/rpc-communication.md` 分层结构与状态、各包 Agent.md、本四件套标注
