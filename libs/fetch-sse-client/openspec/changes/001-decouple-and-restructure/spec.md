# 客户端解耦与模块重组 - 需求规格 (spec.md)

## 1. 背景

设计评审发现 `openspec/systems/fetch-sse-client.md` 的实现与其"与端无关的网络协议层"定位出现偏差，三个问题：

1. **端耦合，且特性本身无存在理由**：可见性重连带来 client.ts 中 10 处 `document` 依赖（守卫、监听、`waitForVisible`）。进一步场景分析表明它对本库不仅无用而且有害：唯一真实消费场景是 agent-core 的 LLM 请求-响应流，该场景下用户切走标签页期望的是流继续跑，隐藏即掐断意味着 token 计费浪费（LLM 流无法续传，重连只能整体重发 → 双倍计费 + 内容重复）；其唯一成立的价值（后台半死连接的快速恢复——浏览器对隐藏页做定时器节流，read 超时与退避延迟在后台失灵）仅适用于"长寿命、可续传的事件订阅推送流"，而该场景在本项目中不存在。设计文档 §5"默认关闭避免影响请求-响应式场景"的反面即：库里唯一的真实场景正是它要避免影响的场景
2. **巨石方法**：`SSEClient.runStream()` 约 195 行，串了信号合并、请求准备、fetch 与响应校验、流读取解析、结局归类 5 个阶段
3. **模块聚合失衡**：`SSEClient` 混了事件发射、状态机、重连编排、单次尝试执行、可见性管理 5 种职责；`createSSEParser` 投机性导出（全项目 grep 确认：除库内部与测试外**零业务消费方**）；`Last-Event-ID` 概念散落三处（状态、记录、headers 注入）

关键事实（2026-10-25 grep 全项目确认）：

- `createSSEParser` 外部消费方为 0，`reconnectOnVisible` 业务消费方为 0
- 错误自动重试仅限首字节前（此时必然无事件 id），`Last-Event-ID` 唯一有值的场景是可见性恢复——删除可见性后该机制整体成为死代码

## 2. 目标

- 核心端无关：`src/` 内零 `document` / `window` / `navigator` 依赖
- client.ts 拆分为编排层（SSEClient）+ 单次连接尝试（ConnectionAttempt）+ 请求组装（prepareRequest）
- parser / timeout / reconnect 由工厂函数 + 闭包重构为类，聚合各自状态与行为
- 出口统一：`index.ts` 只导出 `SSEClient`、`SSEClientError` 与类型
- **除明确删除项外，对外行为零变化**：事件语义、错误分类、重试边界、超时默认值、[DONE] 哨兵策略、严格 JSON 解析全部保持

## 3. 详细需求

### R1：删除可见性重连特性

概念归属判定（详见 design.md §4）：重连核心回答"连接失败后怎么办"——端无关，属协议层；可见性暂停回答"何时主动断开一条健康连接"——端相关、属应用策略。它是库里唯一触碰 `document` 的特性并非巧合，而是概念错位。消费方如需等价能力，监听环境信号 → `abort()` + 新建实例即可，无需库支持。

- 删除 `SSEReconnectOptions.reconnectOnVisible` 配置项
- 删除 client.ts 中 hidden 结局分支、`waitForVisible()`、`hiddenController`、`document` 守卫与监听
- `SSEReconnectingInfo.reason` 字段删除（仅剩 'error' 单值，失去判别意义），负载简化为 `{ attempt, delay, error }`
- 不提供任何替代机制（pause/resume 等），消费方如需"隐藏暂停"自行 `abort()` + 新建实例；未来确有事件订阅场景需求时按重构后的结构重新评估

### R2：删除 Last-Event-ID 机制

- 删除 `lastEventId` 状态字段、读取循环中的记录逻辑、headers 注入逻辑
- parser 对 `id` / `retry` 字段的解析**保留**（W3C 规范完整性，与 client 是否消费无关）

### R3：出口收敛

- `index.ts` 删除 `createSSEParser` 与 `SSEParser` 类型导出，仅保留 `SSEClient`、`SSEClientError`、`SSEClientErrorType` 及 types.ts 类型
- parser 类作为内部实现，测试直接 import 内部路径（不走公共出口）
- README 同步删除 parser 导出说明与可见性重连章节

### R4：三模块类化

| 模块 | 现状 | 目标 |
|------|------|------|
| parser.ts | `createSSEParser()` + 闭包 | `SSEParser` 类（内部，不导出），buffer/eventType/dataLines/id/retry 为私有字段 |
| timeout.ts | `createTimeoutController()` + 闭包 | `TimeoutController` 类，API 形态不变（startConnectTimer / cancelConnectTimer / refreshReadTimer / dispose + 三个超时标志） |
| reconnect.ts | 三个独立纯函数 | `ReconnectPolicy` 类：持有 resolved 配置，提供 `nextDelay(attempt)`（指数退避+抖动+封顶）与 Retry-After 解析；"不配置即不重试"的 null 语义保留 |

### R5：client.ts 拆分

- 新增 `connection.ts`：`ConnectionAttempt` 类，承载单次连接尝试的完整生命周期（信号合并、超时控制、fetch 发起、响应校验、流读取循环、[DONE] 哨兵与严格 JSON 解析、结局归类 `StreamOutcome`）
- 新增 `request.ts`：`prepareRequest()` 纯函数，负责 URL/params 组装、headers 求值、body 序列化（普通对象 → JSON + 补 Content-Type）
- [DONE] 哨兵判断与 JSON 严格解析**不进 parser**（保持 W3C 纯净），作为 ConnectionAttempt 读取循环内的明确步骤
- client.ts 保留：生命周期状态机（idle/running/closed）、事件订阅与分发（on/emit）、重连循环编排（run：重试预算、延迟等待、终局判定）

### R6：测试重组

- parser / timeout / reconnect 测试平移为类 API（import 内部路径）
- client.test.ts 删除可见性套件（约 L951-1100）与 Last-Event-ID 相关用例；单次尝试粒度的用例迁至 connection 测试
- 行为保持类用例（终局语义、重试边界、哨兵、严格解析）必须有对应测试锁定，防止重构漂移

## 4. 非目标

- 不新增可见性的替代机制（pause/resume），不过度设计
- 不修复 decoder 末尾未 flush / parser 无 flush 的边缘缺陷（已记录，单独修）
- 不抽取 Emitter 基类、不新增独立消息策略文件（收益不足以抵消碎片化）
- 不改既有对外行为：事件模型、错误分类与 retryable 标记规则、首字节前重试边界、Retry-After 优先级、三层超时默认值
- agent-core 等消费方零改动（验证项：删掉的导出确实无人使用）

## 5. 验收标准

详见 check.md。核心：

- [ ] `src/` 全目录无 `document` / `window` / `navigator` / `reconnectOnVisible` / `Last-Event-ID` / `lastEventId` 残留
- [ ] `index.ts` 导出面收敛为 SSEClient + SSEClientError + 类型
- [ ] 全量测试通过（vitest）、tsc 类型检查通过、agent-core 构建通过
- [ ] 行为保持类测试全绿（终局互斥、abort 归 done、哨兵消化、严格解析、重试边界）
- [ ] `openspec/systems/fetch-sse-client.md` 与 README 同步更新
