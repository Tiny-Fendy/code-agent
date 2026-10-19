# Mock LLM Provider - 任务清单 (tasks.md)

## 任务拆解

### Task 1：MockProvider 类与模块级开关

**优先级**：P0
**预估工作量**：中

- [x] 新建 `src/llm/MockProvider.ts`：`MockTurn`、`MockProviderOptions`、`MockProvider` 类（剧本消耗、事件合成、calls 记录）
- [x] 模块级开关：`setMockProvider` / `clearMockProvider` / `mockEnabled` / `mockStream`
- [x] 环境变量惰性加载：`CODE_AGENT_MOCK_SCRIPT` JSON 剧本，失败进入错误态单例（绝不回退真实 LLM）
- [x] 剧本消息 structuredClone、码点切分、delay/chunkSize/onExhausted 处理

**验收标准**：
- 事件 data 形状与 OpenAICompatible 输出逐字段对齐（design.md §1 D3 对照表）✅
- 默认关闭零副作用 ✅

---

### Task 2：OpenAICompatible 入口委托

**优先级**：P0
**预估工作量**：小

- [x] `src/llm/OpenAICompatible.ts`：`chat()` 入口 `if (mockEnabled()) { yield* mockStream(params); return; }`，全文件仅此一处改动

**验收标准**：
- 原有真实请求逻辑零改动 ✅
- mock 启用时不发任何网络请求 ✅

---

### Task 3：包入口导出

**优先级**：P1
**预估工作量**：小

- [x] `src/index.ts` 导出 `MockProvider`、`setMockProvider`、`clearMockProvider`、`mockEnabled` 及相关类型

**验收标准**：
- 外部可 import 使用，typecheck 通过 ✅

---

### Task 4：单测覆盖

**优先级**：P0
**预估工作量**：中

- [x] 新建 `test/llm/MockProvider.test.ts`（镜像结构）：
  - 事件合成：TextDelta 分块拼接、ToolCallDelta 累积形状、MessageComplete 完整性、content+toolCalls 顺序
  - 剧本消耗顺序、耗尽 error/loop 两行为、动态剧本（含抛异常）
  - calls 记录、structuredClone 隔离、chunkSize 边界归一
- [x] 委托路径测试：setMockProvider 后 OpenAICompatible.chat() 返回 mock 事件且无网络请求；clearMockProvider 后恢复
- [x] 全局状态 afterEach 清理；全量测试无回归

**验收标准**：
- 新增用例覆盖 design.md §4 全部边界情况 ✅
- 现有用例零改动通过，全量 123 项测试通过 ✅

---

### Task 5：文档同步

**优先级**：P1
**预估工作量**：小

- [x] MockProvider 系统级设计并入 `openspec/systems/llm-provider.md`（新增 §6 MockProvider、§7 实施状态勾选、决策表加行、变更记录加行）
  - 说明：本文档已由三层拆分线补录并登记 README，不另建 llm-access.md 重复收录
- [x] `openspec/systems/README.md` 无需改动（已指向 llm-provider.md）
- [x] 勾选本 tasks.md 全部任务

**验收标准**：
- 文档与代码实态一致 ✅

---

## 依赖关系

```
Task 1 (MockProvider + 开关) ──→ Task 2 (入口委托) ──→ Task 4 (单测)
        └──────────────→ Task 3 (导出) ──────────────┘
Task 5 (文档) 最后执行
```

- Task 2 依赖 Task 1（委托目标须先存在）
- Task 3 依赖 Task 1
- Task 4 依赖 Task 2/3
- Task 5 最后执行

## 提交批次建议

1. agent-core：Task 1 + Task 2 + Task 3（实现）
2. agent-core：Task 4（测试）
3. agent-core：Task 5（文档）

## 备注

- 与 logging 变更（openspec/changes/logging，未实施）相互独立、无文件冲突；logging 落地后可在委托分支补 debug 埋点，非必须
- electron-main 侧本次零改动；env 入口（CODE_AGENT_MOCK_SCRIPT）即可零代码接入
- 全量验证结果：vitest 123 项通过、src typecheck 通过、build 通过
