# 日志系统 - 设计方案 (design.md)

## 1. 核心设计决策

### D1：日志与事件流严格分离

**决策**：日志（Logger）与 AgentEvent 是两套独立通道，互不复用、互不承载。

**理由**：
- 受众不同：AgentEvent 面向 UI/用户（产品事件），Logger 面向开发者（诊断信息）
- 粒度不同：`text_delta` 每个增量都 yield，日志照此记录会爆炸；日志按「一轮 LLM 调用 / 一次工具执行」粒度记录，每轮 O(1) 条
- 内容不同：压缩预估 token、确认回调耗时、SSE 跳过行等诊断细节只进日志，不进事件流

### D2：Logger 接口放 contracts 包

**决策**：`Logger` / `LogLevel` 定义在 `packages/contracts`，agent-core 导入使用。

**理由**：
- `ToolContext` 在 contracts 包，工具要经 context 拿 logger，接口必须与 ToolContext 同包
- electron-main 未来实现文件日志时也需引用该类型
- contracts 的定位即跨包契约，接口归属一致

### D3：默认 NullLogger（库静默原则）

**决策**：所有注入点缺省值为 `NullLogger`（空实现），未注入时不产生任何输出。

**理由**：
- agent-core 是库不是应用，默认不污染宿主 stdout 是库的基本修养
- 现有 94 项测试构造时都不传 logger，若默认 ConsoleLogger 会刷屏污染 vitest 输出
- 宿主要日志：显式注入 `ConsoleLogger` 或自定义实现（如 electron-main 的文件日志）

### D4：注入方式 —— Agent 构造演进为 options 对象

**决策**：Agent 构造函数由 `(config, projectPath, onConfirm?)` 演进为 `(config, projectPath, options?)`，options 内含 `onConfirm`（迁移）与 `logger`（新增）。

**理由**：
- 追加第 4 个位置参数后，只传 logger 的调用方要写 `new Agent(config, path, undefined, logger)`，签名劣化
- 项目处于早期，options 对象为后续依赖（如 Provider 注入）预留了扩展位，避免参数持续膨胀
- ToolManager / ContextManager 参数少，直接追加可选位置参数即可，不套 options

#### 破坏性说明

**性质**：公共 API 的类型面破坏（agent-core 对外导出的 Agent 构造签名变更），但**运行时零破坏**——现场核实结论如下。

**调用点实测清单**：

| 调用点 | 现有写法 | 是否受影响 |
|--------|----------|------------|
| `electron-main/src/rpc/services/ChatServiceImpl.ts:28` | `new Agent(config, projectPath)`（2 参） | 否，2 参调用在新签名下依然合法 |
| `agent-core/test/agent/AgentRun.test.ts:29` | `new Agent(config, process.cwd())`（2 参） | 否 |
| `agent-core/test/agent/Agent.test.ts:40` | `new Agent(config, ...)`（2 参） | 否 |
| `agent-core/src/index.ts:9`（用法注释） | `new Agent(config, '/path')` | 否，仅注释需同步 |

**关键事实**：全仓**没有任何生产或测试代码传递过第三参数 `onConfirm`**。electron-main 的 `ChatServiceImpl.confirmTool()` 目前仍是空实现（注释自述「确认门控尚未在引擎落地」），确认回调尚未在宿主侧接线。因此 `onConfirm` 从位置参数迁入 options，**不产生任何编译错误或运行时行为变化**。

**真正的破坏面（需处理）**：

1. **类型面**：`Agent` 构造签名变更为 `(config, projectPath, options?: AgentOptions)`；传入第 3 个 `ToolConfirmCallback` 将报 TS 类型错误。当前无调用方触发。
2. **文档面**：多处设计文档与用法注释仍写 `onConfirm` 为第三参数，需同步更正——
   - `src/index.ts` 用法示例注释
   - `openspec/changes/002-context-compaction/design.md:68`（`constructor(config, projectPath, onConfirm?)  // 不变`）
   - `openspec/changes/001-file-tools/design.md:10`
   - `electron-main/openspec/changes/001-rpc-communication/design.md:190`（`new Agent(this.config, this.projectPath)` 快照，2 参无影响，但可核对）
3. **未来接线面**：electron-main 落实工具确认门控（把 `confirmTool` 接成真实回调）时，须按新签名传 `{ onConfirm }`，不能再写第三位置参数。

**迁移步骤（供宿主侧协作方执行）**：

1. 保持现有 2 参调用不变，无需改动即可编译通过；
2. 待实现确认门控时，改为 `new Agent(config, projectPath, { onConfirm, logger })`。

**兼容策略选择**：**不做过渡重载**。理由——无任何现存第三参数调用方，加过渡重载只会延长双签名维护期，与"项目早期、最小改动"的取向相悖。若未来需要过渡，可临时提供 `(config, projectPath, onConfirmOrOptions?: ToolConfirmCallback | AgentOptions)` 做运行时判别，但当前无此必要。

**协作方通知项**：需告知负责 electron-main 的一方——Agent 第三参数已由 `ToolConfirmCallback` 变为 `AgentOptions` 对象，其 `ChatServiceImpl.confirmTool` 落地时必须走 `{ onConfirm }` 形式。

**备选（被否）**：保留 onConfirm 第三参数、logger 作第四可选参数——零破坏，但签名劣化，长期还得再改一次。

### D5：日志调用签名 `(message, context?)`

**决策**：统一 `(message: string, context?: Record<string, unknown>)` 两参形式，不用重载与变参。

**理由**：
- context 承载结构化附加数据（耗时、token 数、工具名），ConsoleLogger 拼 JSON 输出，未来文件实现可直接写 JSON Lines
- 接口保持最小，四个级别 × 一种签名，实现与调用成本都最低

### D6：logger 异常不中断主流程

**决策**：接口契约规定实现方**必须自行消化异常**；Agent 埋点处直接调用，不逐点包 try/catch。

**理由**：
- 每个埋点包防御是冗余代码，契约集中约束更干净
- 内置 ConsoleLogger 对 context 序列化失败（循环引用等）做 try/catch 降级为 `String(value)`，自身不抛
- JSDoc 在 Logger 接口上显式注明该契约

## 2. 接口定义

### contracts 包（新增 types/logger.ts）

```typescript
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 日志接口（面向开发者的诊断通道，与 AgentEvent 产品事件严格分离）
 *
 * 契约：实现方必须自行消化异常，任何情况下不得向调用方抛出。
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
```

### contracts 包（ToolContext 扩展）

```typescript
export interface ToolContext {
  projectPath: string;
  /** 可选日志器，工具内诊断信息经此输出；缺省由 ToolManager 注入 NullLogger */
  logger?: Logger;
}
```

### contracts 包（AgentOptions 新增）

```typescript
export interface AgentOptions {
  onConfirm?: ToolConfirmCallback;
  logger?: Logger;
}
```

### agent-core（src/logging/）

```typescript
export class ConsoleLogger implements Logger {
  constructor(private minLevel: LogLevel = 'info') {}
  // 输出格式：[HH:mm:ss.SSS] [LEVEL] message {contextJson}
  // context 序列化失败降级为 String(value)
}

export class NullLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
```

## 3. 注入链路

```
new Agent(config, projectPath, { onConfirm, logger })
  ├─ new ToolManager(projectPath, logger)     // 追加可选参数
  ├─ new ContextManager(tokens, logger)       // 追加可选参数
  └─ toolContext = { projectPath, logger }    // 工具经 context.logger 使用
```

同一实例贯穿全链路，未注入时各环节各自落到 NullLogger。

## 4. 埋点清单

| 位置 | 级别 | 内容 |
|------|------|------|
| Agent.run 开始 | info | 用户消息长度、maxSteps |
| Agent.run 终局 | info | status、steps（finished 含 summary 长度） |
| callLLM 请求 | info | model、消息数、估算 token、tools 数 |
| callLLM 响应 | info | 耗时、content 长度、toolCalls 数 |
| callLLM 请求/响应原文 | debug | messages、tools、完整 message |
| callLLM 失败 | error | 错误信息 |
| executeToolCall 开始 | info | tool name、args |
| 确认请求 / 通过 | info | tool name、耗时 |
| 确认拒绝 / 回调异常 | warn | tool name、是否异常 |
| executeToolCall 完成 | info | tool name、success、耗时 |
| finish 检测命中 | info | summary |
| 压缩触发与完成 | info | before/after token、range 大小、耗时 |
| 压缩防抖跳过 | warn | 预估值 vs 触发阈值 |
| ContextManager tool 结果截断 | warn | 原长度、截断后长度 |
| ToolManager 工具未找到 | warn | tool name |
| ToolManager 工具异常 | error | tool name、错误信息 |
| OpenAICompatible SSE 跳过行 | debug | 原始行内容 |
| OpenAICompatible 网络/解析失败 | error | 错误信息 |

## 5. 级别语义

| 级别 | 定位 | 示例 |
|------|------|------|
| debug | 高音量原文细节，默认关闭 | LLM 请求 messages 原文、SSE 跳过行 |
| info | 关键生命周期，每轮 O(1) 条 | 任务终局、工具调用完成、压缩执行 |
| warn | 降级与安全事件 | 结果截断、防抖跳过、PathGuard 拒绝 |
| error | 失败事件 | LLM 失败、工具异常 |

`debug` 会记录 LLM 原文（可能含用户代码），生产环境使用 `info` 及以上。

## 6. 边界情况

| 场景 | 处理 |
|------|------|
| 未注入 logger | 各注入点缺省 NullLogger，行为与现状完全一致 |
| context 含循环引用/不可序列化值 | ConsoleLogger try/catch 降级为 String(value) |
| logger 实现抛异常 | 契约禁止，实现方负责；内置实现保证不抛 |
| debug 泄露敏感内容 | 级别开关控制，文档注明生产用 info |
| 测试环境 | 缺省静默；需断言日志时注入 FakeLogger |

## 7. 与现有机制的关系

- **事件流**：互不干扰，UI 无感知
- **现有测试**：缺省 NullLogger，94 项测试零改动通过
- **electron-main**：未来实现文件 Logger 注入即可，agent-core 无感知；本次需同步 Agent 调用点一行（见 D4）

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 埋点遗漏或级别错配 | 清单评审；关键路径用 FakeLogger 断言 |
| 日志开销 | info 级每轮 O(1) 条可忽略；debug 显式开启 |
| contracts 变更影响其他包 | 仅新增类型与可选字段，向后兼容 |
| options 对象破坏 electron-main 调用 | 仅一个调用点一行修改，随实现任务同步通知协作方 |
