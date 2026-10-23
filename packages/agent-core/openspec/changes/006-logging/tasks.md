# 日志系统 - 任务清单 (tasks.md)

## 任务拆解

### Task 1：contracts 包 Logger 接口

**优先级**：P0
**预估工作量**：小

- [x] 新建 `packages/contracts/src/types/logger.ts`：`LogLevel`、`Logger` 接口（JSDoc 注明不抛异常契约）
- [x] `packages/contracts/src/types/tool.ts`：ToolContext 新增 `logger?: Logger`
- [x] `packages/contracts/src/types/agent.ts`：新增 `AgentOptions`（onConfirm + logger）
- [x] contracts 入口导出新类型，构建通过

**验收标准**：
- 类型定义正确，agent-core 可引用
- 仅新增，无破坏性变更（AgentOptions 为新增类型，不影响现有 AgentConfig）

---

### Task 2：agent-core logging 模块

**优先级**：P0
**预估工作量**：小

- [x] 新建 `src/logging/NullLogger.ts`：四个空方法
- [x] 新建 `src/logging/ConsoleLogger.ts`：minLevel 过滤（默认 info）、时间戳+级别前缀、context JSON 序列化与降级
- [x] 新建 `src/logging/index.ts` 导出
- [x] `src/index.ts` 包入口导出 ConsoleLogger / NullLogger

**验收标准**：
- ConsoleLogger 低于 minLevel 的级别不输出
- context 序列化失败降级为 String(value)，不抛异常
- NullLogger 调用无副作用

---

### Task 3：注入改造

**优先级**：P0
**预估工作量**：中

- [x] `src/agent/Agent.ts`：构造函数演进为 `(config, projectPath, options?: AgentOptions)`，onConfirm 迁移入 options，logger 缺省 NullLogger
- [x] Agent 内部：logger 传递给 ToolManager、ContextManager，挂到 toolContext
- [x] `src/tools/ToolManager.ts`：构造函数追加可选 logger 参数
- [x] `src/context/ContextManager.ts`：构造函数追加可选 logger 参数
- [x] 同步 electron-main 侧 Agent 调用点（onConfirm 移入 options，一行修改，协作方执行）

**验收标准**：
- typecheck 通过
- 缺省注入下现有测试零改动通过

---

### Task 4：埋点接入

**优先级**：P0
**预估工作量**：中

- [x] `Agent.run`：任务开始/终局 info
- [x] `Agent.callLLM`：请求/响应 info、原文 debug、失败 error
- [x] `Agent.executeToolCall`：工具调用 info、确认流 info/warn、finish info
- [x] `Agent.maybeCompactContext`：压缩触发/完成 info、防抖跳过 warn
- [x] `ContextManager`：tool 结果截断 warn
- [x] `ToolManager`：工具未找到 warn、工具异常 error
- [x] `OpenAICompatible`：SSE 跳过行 debug、网络/解析失败 error（三层拆分后无跳过行；网络/解析失败经 LLMEvent(error) 由 Agent 层 error 埋点覆盖，Provider 不注入 logger）

**验收标准**：
- 埋点与 design.md §4 清单一致，级别归属正确
- 注入 ConsoleLogger(debug) 端到端可观察到完整 ReAct 链路日志

---

### Task 5：单测覆盖

**优先级**：P0
**预估工作量**：中

- [x] 新建 `test/logging/ConsoleLogger.test.ts`：级别过滤、输出格式、context 序列化降级
- [x] 新建 `test/logging/NullLogger.test.ts`：调用无副作用
- [x] 扩展 `test/agent/AgentRun.test.ts`：FakeLogger 注入，断言任务终局、工具调用、压缩执行关键日志
- [x] 全量测试通过（现有用例零改动）

**验收标准**：
- 新增用例覆盖接口行为与关键埋点路径
- 全量测试无回归

---

### Task 6：文档同步

**优先级**：P1
**预估工作量**：小

- [x] 新建 `openspec/systems/logging.md`：日志子系统持久设计文档（定位、接口契约、注入链路、埋点原则）
- [x] 更新 `openspec/systems/README.md` 当前收录清单
- [x] 勾选本 tasks.md 全部任务

**验收标准**：
- 文档与代码实态一致

---

## 依赖关系

```
Task 1 (contracts 类型) ──→ Task 2 (内置实现) ──→ Task 3 (注入改造) ──→ Task 4 (埋点) ──→ Task 5 (单测)
                                                                                    Task 6 (文档) 最后执行
```

- Task 1 是全部后续任务的前置（类型依赖）
- Task 2 不依赖 Task 3，可与 Task 3 并行准备
- Task 5 依赖 Task 3/4
- Task 6 最后执行

## 提交批次建议

1. contracts 包：Task 1（类型扩展）
2. agent-core：Task 2 + Task 3（实现与注入改造）
3. agent-core：Task 4 + Task 5（埋点与测试）
4. agent-core：Task 6（文档）
