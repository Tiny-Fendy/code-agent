# ask_user 工具 - 任务清单 (tasks.md)

> 状态：Task 1-5 已实施（2026-10-21）；Task 6 宿主接线待协作方。任务按依赖顺序排列，完成后勾选。

## Task 1：contracts 用户交互类型

**优先级**：P0
**预估工作量**：小

- [x] 新建 `packages/contracts/src/types/user-input.ts`：`UserInputOption` / `UserInputRequest` / `UserInputResponse` / `UserInputCallback`
- [x] `packages/contracts/src/types/tool.ts`：`ToolContext` 新增 `requestUserInput?: UserInputCallback`
- [x] `packages/contracts/src/types/agent.ts`：`AgentOptions` 新增 `onAskUser?: UserInputCallback`
- [x] contracts 入口 `src/index.ts` 导出新类型，构建通过

**验收标准**：

- 类型定义与 design.md §2 一致
- 仅新增可选字段，现有调用方零破坏

---

## Task 2：AskUserTool 实现与注册

**优先级**：P0
**预估工作量**：中

- [x] 新建 `packages/agent-core/src/tools/ask-user/AskUserTool.ts`
- [x] 新建 `packages/agent-core/src/tools/ask-user/index.ts` 导出
- [x] 参数校验：`question` 非空、`options` 2-4、`label` 非空、单选唯一
- [x] 回调缺失 / 异常 / 空回答三级降级为 error ToolResult
- [x] 回答映射：`用户选择：A、B` / `用户输入：...`
- [x] `ToolManager.createBuiltinTools` 注册 `new AskUserTool()`（内置工具增至 8 个）

**验收标准**：

- 不抛异常，所有非法输入均以 `success: false` 返回
- `getDefinitions()` 中包含 `ask_user`

---

## Task 3：Agent 注入与提示词

**优先级**：P0
**预估工作量**：小

- [x] Agent 构造：`toolContext.requestUserInput = options?.onAskUser`
- [x] `DEFAULT_SYSTEM_PROMPT` 追加 `ask_user` 使用原则（先问再动手、能自查不问、2-4 个互斥选项）
- [x] 日志：发起 info、回答 info（含耗时）、降级 warn

**验收标准**：

- 注入 `onAskUser` 后工具回调可用；未注入时返回「不支持交互」错误
- 自定义 `systemPrompt` 不被覆盖

---

## Task 4：单元测试

**优先级**：P0
**预估工作量**：中

- [x] 新建 `packages/agent-core/test/tools/AskUserTool.test.ts`
  - schema 与注册（`getDefinitions` 含 `ask_user`）
  - 回调收到完整 request（question/options/allowMultiple 原样透传）
  - 单选 / 多选 / 自由输入三种回答映射
  - `question` 空白、`options` 数量非法、`label` 空白、单选多返回
  - 未注入回调 / 回调抛异常 / 空回答三级降级
  - 回调耗时与日志字段（可选）
- [x] 扩展 `packages/agent-core/test/agent/AgentRun.test.ts`
  - 注入 `onAskUser`：LLM 调用 `ask_user` → 回答作为 tool 消息回灌 → 下一轮继续
  - 未注入：工具返回错误观察，循环继续
- [x] 全量测试通过（195 项，其中现有 169 项零回归）

**验收标准**：

- 用例按 spec R1-R8 与 design 边界表编写，非按实现倒推
- test 目录结构与 src 镜像

---

## Task 5：文档同步

**优先级**：P1
**预估工作量**：小

- [x] `openspec/systems/tool-system.md`：内置工具清单新增 `ask_user`，补充交互回调决策与已知限制
- [x] `openspec/systems/agent-engine.md`：§3.4 增补「用户输入流」与 `onAskUser` 注入说明
- [x] 勾选本 tasks.md 与 spec.md 验收项

**验收标准**：

- 文档与代码实态一致

---

## Task 6：宿主接线（非本次范围）

**优先级**：P2
**预估工作量**：中（协作方）

- [ ] `electron-main` 实现 `onAskUser`，经 RPC 通知 renderer 弹出选择面板并回传答案
- [ ] RPC 协议复用现有 Agent 构造 options 通道，不新增事件类型
- [ ] 宿主侧超时策略：超时 resolve 空回答，避免任务挂起

**验收标准**：

- 桌面端可完成一次「提问 → 选择 → 回答回灌」闭环

---

## 依赖关系

```
Task 1 (contracts)
   └─ Task 2 (工具实现)
        └─ Task 3 (Agent 注入)
             ├─ Task 4 (测试)
             └─ Task 5 (文档)
                  └─ Task 6 (宿主接线，另批)
```

## 提交规划

- 批次 1（feat）：contracts 类型 + AskUserTool + 注册 + Agent 注入与提示词
- 批次 2（test）：AskUserTool 单测 + Agent 集成用例
- 批次 3（docs）：change 三件套勾选 + systems 文档同步
