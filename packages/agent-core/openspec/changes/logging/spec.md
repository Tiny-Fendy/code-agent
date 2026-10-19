# 日志系统 - 需求规格 (spec.md)

## 1. 背景

Agent 是**概率性系统**：同样的输入，LLM 每轮可能选择不同的工具与参数，行为路径无法预先确定，出问题没法像确定性程序那样断点复现，只能靠日志回放「LLM 当时看到了什么、决定了什么、工具返回了什么」。

当前 agent-core 运行过程完全是黑盒：

- LLM 每轮请求的消息数、token 估算值、响应耗时不可见
- 工具执行耗时、确认回调行为不可见
- 上下文压缩何时触发、压缩前后 token 数、防抖跳过原因不可见
- 工具结果截断、SSE 解析跳过的行等降级行为静默发生

现有的 AgentEvent 流是**产品事件**（推给 UI、用户可见），不承载诊断信息。调试只能依赖单测与 mock 端到端验证，定位线上行为问题效率低。

## 2. 目标

- 建立包内统一日志能力：定义 `Logger` 接口，提供最小功能实现，核心类完成关键决策点埋点
- **日志与事件流严格分离**：日志面向开发者诊断，不进入 AgentEvent，UI 无感知
- **默认静默**：agent-core 是库不是应用，缺省不向宿主 stdout 输出，由调用方显式注入实现
- 测试友好：可注入 FakeLogger 断言关键路径日志

## 3. 范围

| 项 | 归属 |
|----|------|
| `Logger` 接口、`LogLevel` 类型、`ToolContext` 扩展 | `packages/contracts`（跨包契约） |
| `ConsoleLogger` / `NullLogger` 最小实现 | `packages/agent-core` 内置 |
| Agent / ToolManager / ContextManager 注入改造与埋点 | `packages/agent-core` |
| 文件日志、轮转等宿主侧实现 | 非本次范围（electron-main 未来自行实现 Logger 接口注入） |

## 4. 详细需求

### R1：Logger 接口定义

- 在 contracts 包新增 `Logger` 接口与 `LogLevel` 类型（`debug | info | warn | error`）
- 调用签名统一为 `(message: string, context?: Record<string, unknown>)`，context 承载结构化附加数据
- 接口契约注明：**实现方必须自行消化异常，不得向调用方抛出**

### R2：内置最小实现

- `NullLogger`：四个方法空实现，作为各注入点的缺省值
- `ConsoleLogger`：支持 `minLevel` 级别过滤（默认 `info`），输出带时间戳与级别前缀的文本，context 拼为 JSON；序列化失败时降级处理，不得抛异常
- 不实现文件写入、轮转、异步缓冲等能力，后续有需求再扩展

### R3：注入方式

- `Agent` 构造函数演进为 options 对象形式，options 内含 `onConfirm`（迁移）与 `logger`（新增），均可选
- `ToolManager` / `ContextManager` 构造函数追加可选 `logger` 参数
- Agent 内部把同一个 logger 实例传递给 ToolManager、ContextManager，并挂到 `toolContext` 上，工具实现经 `context.logger` 使用
- 所有注入点缺省为 `NullLogger`，未注入时行为与现状完全一致

### R4：埋点与级别

按 design.md §4 埋点清单执行，级别语义：

- `info`：关键生命周期事件（任务开始/终局、每轮 LLM 调用、工具调用与耗时、压缩执行），量为每轮 O(1) 条
- `warn`：降级与安全事件（工具结果截断、压缩防抖跳过、确认回调异常、PathGuard 拒绝、工具未找到）
- `debug`：高音量原文细节（LLM 请求/响应原文、SSE 跳过行），默认关闭
- `error`：失败事件（LLM 调用失败、工具执行异常）

### R5：安全约束

- logger 抛出异常不得中断 Agent 主流程（由 R1 接口契约 + 内置实现保证）
- `debug` 级别会记录 LLM 原文，可能包含用户代码内容：靠级别开关控制，文档注明生产环境使用 `info`

### R6：测试支持

- 现有全部测试在缺省注入（NullLogger）下零改动通过
- 关键路径（任务终局、工具调用、压缩执行）可用 FakeLogger 注入断言

## 5. 非目标

- 文件日志、日志轮转、远程上报（属宿主侧需求，未来以 Logger 实现注入即可，agent-core 无感知）
- metrics / 链路追踪等可观测性体系
- UI 日志展示面板
- 抽离为 libs/ 独立包（先在 agent-core 内置演进，出现跨包复用需求再评估）

## 6. 验收标准

- [ ] contracts 包导出 `Logger` / `LogLevel`，`ToolContext` 含可选 `logger` 字段，构建通过
- [ ] `ConsoleLogger` 级别过滤与输出格式正确，context 序列化失败降级不抛异常
- [ ] Agent / ToolManager / ContextManager 支持注入，缺省 NullLogger 下现有行为与测试零变化
- [ ] 埋点清单全部落地，级别归属正确
- [ ] 新增单测通过，全量测试无回归
- [ ] systems/ 收录日志子系统设计文档
