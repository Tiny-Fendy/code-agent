# 客户端解耦与模块重组 - 设计 (design.md)

## 1. 目标模块结构与依赖方向

```
                    ┌─────────────────────────────┐
                    │  SSEClient（client.ts）      │
                    │  状态机 + 事件分发 + 重连编排 │
                    └──────┬──────────────┬───────┘
                           │ 每次尝试      │ 退避决策
                           ▼              ▼
              ┌────────────────────┐  ┌──────────────────┐
              │ ConnectionAttempt  │  │ ReconnectPolicy  │
              │ (connection.ts)    │  │ (reconnect.ts)   │
              │ 单次连接尝试生命周期 │  │ 配置+延迟+Retry-After│
              └───┬────┬────┬─────┘  └──────────────────┘
                  │    │    │
        请求组装   │    │    │ 三层超时
                  ▼    │    ▼
        ┌──────────┐  │  ┌──────────────────┐
        │prepareRequest│ │  │ TimeoutController│
        │(request.ts)│  │  │ (timeout.ts)     │
        │ 纯函数     │  │  └──────────────────┘
        └──────────┘  │        ▲
              fetch ──┼────────┘ 信号合并进超时控制器
                      ▼
              ┌──────────────┐
              │  SSEParser   │
              │ (parser.ts)  │
              │ W3C 协议解析  │
              └──────────────┘
```

全部模块端无关；`errors.ts` / `types.ts` 为共享定义。依赖方向单向：编排层 → 尝试层 → 基础件，无反向依赖。

## 2. 模块职责与接口要点

| 文件 | 导出 | 职责 |
|------|------|------|
| client.ts | `SSEClient` | 状态机（idle/running/closed）、on/emit 事件分发、重连循环（预算、延迟、终局判定）；每次循环创建并 await 一个 ConnectionAttempt |
| connection.ts | 内部 `ConnectionAttempt` | 单次尝试生命周期；`run()` 仅做编排（信号合并 + 超时 + 分段调用 + try/catch/finally），内部按阶段拆为四个私有方法：`fetchResponse()`（请求准备 + fetch + connect 超时启停）、`assertResponseUsable()`（response.ok → onOpen → body 存在性）、`readStream()`（读取循环：decode → parser.push → 哨兵特判 → 严格 JSON.parse → onData 回调）、`handleError()`（catch 分支结局归类：abort / total 超时 / classifyError）；`classifyError()` 保持独立 |
| request.ts | 内部 `prepareRequest(options)` | 纯函数：URL/params、headers 求值（支持函数形式）、body 序列化；返回 `{ url, init }` |
| parser.ts | 内部 `SSEParser` | W3C EventSource 解析；字段化闭包状态；仅 `push(chunk): SSEEvent[]` 公开 |
| timeout.ts | 内部 `TimeoutController` | 三层超时共享一个 AbortController；构造参数 `(connect, read, total, signal?)` |
| reconnect.ts | 内部 `ReconnectPolicy` | 持有 resolved 配置；`nextDelay(attempt, retryAfterMs?)`：Retry-After 优先（封顶 maxDelay），否则指数退避+抖动；"未配置不重试"以静态工厂 `ReconnectPolicy.resolve(options): ReconnectPolicy \| null` 保留 null 语义 |
| errors.ts | `SSEClientError` | 不变 |
| types.ts | 类型 | 删 `reconnectOnVisible`；`SSEReconnectingInfo` 删 `reason`，为 `{ attempt, delay, error }` |
| index.ts | 出口 | 仅 `SSEClient`、`SSEClientError`、`SSEClientErrorType`、types 类型 |

### SSEClient 与 ConnectionAttempt 的契约

- 输入：attempt 构造接收 `(options 相关子集, clientSignal, hooks)`；hooks 含 `onData(parsed)`、`onEventId(id)`?——**不需要**：Last-Event-ID 已删除，hooks 仅 `onData`
- 输出：`Promise<StreamOutcome>`，形态保持现有四种：`complete / aborted / error{ error, autoRetryable, retryAfterMs? }`；**删除 `hidden` 分支**
- eventCount 计数留在 SSEClient（onData 回调里累加），attempt 无计数职责

### [DONE] 哨兵与严格 JSON 解析的归属

作为 ConnectionAttempt 读取循环内的两个明确步骤（私有方法或局部函数），不进 SSEParser：

- 哨兵是 OpenAI 系约定俗成，非 W3C 规范——parser 保持纯净
- 严格 JSON 解析是库的消息策略——与"读取循环"天然同生命周期

## 3. 删除清单与理由

| 删除项 | 理由 |
|--------|------|
| `reconnectOnVisible` + hidden 分支 + `waitForVisible` + `hiddenController` | 概念错位（端相关的应用策略混入协议层）；唯一真实场景（LLM 请求-响应流）下开启反而有害——token 计费浪费、流不可续传只能整体重发；其适用的事件订阅场景本项目不存在；零业务消费方 |
| `Last-Event-ID` 状态/记录/注入 | 唯一有值场景是可见性恢复（错误重试必在首字节前，无 id 可回传），随可见性删除成为死代码 |
| `SSEReconnectingInfo.reason` | 删除 hidden 后仅剩单值，字段失去判别意义；事件名本身已表达语义 |
| `createSSEParser` / `SSEParser` 类型导出 | 零外部消费方；出口判断标准：**无库外消费方的能力不导出**，与"abort() 封装不暴露 AbortSignal"的最小 API 哲学一致 |

## 4. 关键决策记录

| 决策 | 备选 | 理由 |
|------|------|------|
| 可见性特性完全删除（A1） | 注入 VisibilitySource 接口（B）；改 pause()/resume()（A2） | ① 概念归属：重连核心是"连接失败后怎么办"（端无关，属协议层），可见性是"何时主动断开健康连接"（端相关、属应用策略），后者不属于本层；② 场景分析：其唯一成立价值（后台半死连接快速恢复——隐藏页定时器节流使 read 超时与退避失灵）仅适用长寿命事件订阅流，本库真实场景为 LLM 请求-响应流，开启反而有害；③ 对标前提不成立：该思路来自 @microsoft/fetch-event-source，但它是浏览器通用事件消费库，可见性处理是其主场，与本库生产场景不同；④ 零消费方，且消费方可自行"环境信号 → abort() + 新建实例"实现等价能力，任何保留机制（含 A2 的暂停态状态机）都是投机设计 |
| parser 收回内部 | 保留工厂别名兼容 | 包未对外发布，唯一消费方 agent-core 不使用该导出；别名是历史包袱 |
| 拆分粒度：ConnectionAttempt + prepareRequest | 仅 client 内私有方法拆分；更激进再抽 Emitter/消息策略层 | 前者 client 仍然偏厚；后者收益不足。中等粒度正好对应 runStream 的五阶段拆界 |
| 三模块类化 | 保持工厂函数 | reconnect 类化收益最大（三函数共享配置输入）；parser/timeout 类化统一风格、状态显式 |
| 行为保持为硬约束 | 顺手"改进"语义 | 重构与行为变更分离；已知边缘缺陷（decoder flush）单独修 |
| ConnectionAttempt.run() 内部分段为 fetchResponse / assertResponseUsable / readStream / handleError | run() 内联全部逻辑 | run() 原 131 行超出单函数 100 行约束，且同时承担信号合并、请求、校验、读取、归类五种职责；按阶段拆分后 run() 仅 24 行做编排，各阶段方法职责单一、可独立阅读与测试，行为零变更 |

## 5. 不变量（重构期间必须保持）

- 生命周期状态机：idle → running → closed；start() 一次性；abort() 非 running 态 no-op
- 终局语义：done 与 error 互斥且只发一次；abort 归 done { reason: 'aborted' }
- 重试边界：仅首字节前 + 可重试类别 + 预算未耗尽；Retry-After 优先；指数退避+抖动封顶 maxDelay
- [DONE] 哨兵：不透传、不解析、不计数，主动关流并发 done complete
- data 负载严格 JSON 解析，失败即 parse 错误终结
- 三层超时默认值 connect 10s / read 30s / total 0
