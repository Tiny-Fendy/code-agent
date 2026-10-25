# 客户端解耦与模块重组 - 任务 (tasks.md)

> 按批提交，每批完成标准：该批测试通过 + `tsc` 类型检查通过。批次间不破坏可构建性。

## 批 1：删除可见性 + Last-Event-ID（行为变更批）

- [ ] types.ts：删除 `SSEReconnectOptions.reconnectOnVisible`；`SSEReconnectingInfo` 删除 `reason` 字段（负载收敛为 `{ attempt, delay, error }`）
- [ ] reconnect.ts：删除 `ResolvedReconnectOptions.reconnectOnVisible` 与默认值
- [ ] client.ts：删除 `document` 守卫与 `visibilitychange` 监听、`waitForVisible()`、`hiddenController`、run() 中 hidden 结局分支；删除 `lastEventId` 字段、读取循环记录逻辑、headers 注入逻辑
- [ ] client.ts：emit('reconnecting') 负载适配新结构
- [ ] 测试：删除 client.test.ts 可见性套件与 Last-Event-ID 用例；reconnect.test.ts 删除 reconnectOnVisible 断言；适配 reconnecting 负载断言
- [ ] `pnpm vitest run` + `tsc --noEmit` 通过，提交

## 批 2：三模块类化 + 收回 parser 导出（机械重构批）

- [ ] parser.ts：`createSSEParser()` → `SSEParser` 类（闭包状态字段化，仅 push 公开）
- [ ] timeout.ts：`createTimeoutController()` → `TimeoutController` 类（API 形态不变）
- [ ] reconnect.ts：三函数 → `ReconnectPolicy` 类（静态 `resolve()` 保留 null 语义；`nextDelay(attempt, retryAfterMs?)` 内含 Retry-After 优先逻辑）
- [ ] client.ts 适配三个新类 API（Retry-After 解析调用点随 ReconnectPolicy 收口）
- [ ] index.ts：删除 `createSSEParser` 与 `SSEParser` 类型导出
- [ ] 测试：parser/timeout/reconnect 测试平移为类 API（import 内部路径不变）
- [ ] 全量测试 + 类型检查通过，提交

## 批 3：拆出 ConnectionAttempt + prepareRequest（结构重组批）

- [ ] request.ts：`prepareRequest()` 纯函数（URL/params、headers 求值、body 序列化）
- [ ] connection.ts：`ConnectionAttempt` 类承接 runStream 全部逻辑（信号合并、超时、fetch、响应校验、读取循环、哨兵与严格 JSON 解析步骤、结局归类）；StreamOutcome 删除 hidden 分支
- [ ] client.ts：runStream 删除，run() 循环改为创建/await ConnectionAttempt；eventCount 经 onData 回调计数；classifyError 随读取循环归位
- [ ] 测试：单次尝试粒度用例迁至 connection 测试文件；行为保持类用例（终局、重试边界、哨兵、严格解析）全绿
- [ ] 全量测试 + 类型检查通过，提交

## 批 4：文档同步

- [ ] `openspec/systems/fetch-sse-client.md`：更新模块结构表（§4）、API 配置表（§3.2 删 reconnectOnVisible）、reconnecting 负载（§3.8）、删除可见性重连与 Last-Event-ID 章节、变更记录追加本次条目
- [ ] README：删除可见性重连特性说明与 `createSSEParser` 导出行；配置示例同步
- [ ] 验证 agent-core 构建通过（消费方零改动）
- [ ] 提交

## 批 3 补充：ConnectionAttempt.run() 内部分段

> 批 3 落地后 `ConnectionAttempt.run()` 达 131 行，超出单函数 100 行约束且职责混杂，进一步按阶段拆分。

- [ ] `connection.ts`：`run()` 缩为编排层（信号合并 + 超时 + 分段调用 + try/catch/finally）；拆出 `fetchResponse()`（请求准备 + fetch + connect 超时启停）、`assertResponseUsable()`（response.ok → onOpen → body 存在性）、`readStream()`（读取循环 + 哨兵 + 严格 JSON + onData）、`handleError()`（catch 分支结局归类）
- [ ] 全量测试 + 类型检查通过，行为零变更
- [ ] 回填 design.md（§2 connection.ts 职责、§4 关键决策）与 check.md（§3 模块结构）
