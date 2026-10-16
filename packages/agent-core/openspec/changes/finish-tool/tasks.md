# finish 工具 - 任务清单 (tasks.md)

## 任务拆解

### Task 1：FinishTool 实现

**优先级**：P0
**预估工作量**：小

- [x] 创建 `src/tools/finish/FinishTool.ts`
- [x] 继承 BaseTool，定义 name/description/parameters
- [x] 实现 execute：校验 summary 非空，返回 success(summary)
- [x] 创建 `src/tools/finish/index.ts` 导出

**验收标准**：
- finish 工具正确注册到 ToolManager ✅
- 空 summary 返回 error ✅
- 正常 summary 返回 success ✅

---

### Task 2：Agent 循环识别 finish

**优先级**：P0
**预估工作量**：小

- [x] 修改 `src/agent/Agent.ts` run() 循环
- [x] 工具执行后检测 toolCall.name === 'finish'
- [x] 检测到后 return { status: 'finished', steps, summary }，退出循环
- [x] 确保 abort() 仍可中断（在 finish 检测前检查 aborted）
- [x] 修改 `packages/shared/src/types/agent.ts` SendResult 新增 finished 分支

**验收标准**：
- finish 调用后循环正确结束，无多余 LLM 调用 ✅
- SendResult 包含 status: 'finished' 与 summary ✅
- abort 在 finish 前后均生效 ✅

---

### Task 3：shared 类型扩展

**优先级**：P0
**预估工作量**：小

- [ ] 修改 `packages/shared/src/types/agent.ts`
- [ ] DoneEventData 新增 reason: 'finished' 与 summary?: string
- [ ] 确保 shared 包构建通过

**验收标准**：
- 类型定义正确，agent-core 可引用
- 向后兼容：reason 为可选，旧代码不破坏

---

### Task 4：系统提示词引导

**优先级**：P1
**预估工作量**：小

- [x] 检查 Agent.ts 默认系统提示词
- [x] 追加 finish 使用说明（何时调用、summary 内容要求）
- [x] 确保提示词不破坏现有工具使用引导

**验收标准**：
- 提示词明确引导 LLM 使用 finish 结束任务 ✅
- 与现有工具说明风格一致 ✅

---

### Task 5：单测覆盖

**优先级**：P0
**预估工作量**：中

- [ ] 创建 `test/tools/finish/FinishTool.test.ts`
- [ ] 测试空 summary 返回 error
- [ ] 测试正常 summary 返回 success
- [ ] 创建 `test/agent/Agent.test.ts` 或扩展现有测试
- [ ] Mock LLM 场景：LLM 返回 finish 工具调用 → Agent 正确结束
- [ ] 测试 done 事件包含 reason: 'finished' 与 summary

**验收标准**：
- FinishTool 单测通过
- Agent 集成测试通过（finish 触发正确退出）

---

### Task 6：文档同步

**优先级**：P1
**预估工作量**：小

- [ ] 更新 `openspec/systems/tool-system.md` 工具清单（新增 finish）
- [ ] 更新 `openspec/systems/agent-engine.md` done 事件说明
- [ ] 更新根 Agent.md 事件流协议表

**验收标准**：
- 文档与代码实态一致

---

## 依赖关系

```
Task 1 (FinishTool) ──┬──→ Task 2 (Agent 循环) ──→ Task 5 (单测)
Task 3 (shared 类型) ──┘         ↑
Task 4 (提示词) ─────────────────┘
Task 6 (文档) 最后执行
```

- Task 1/3 可并行
- Task 2 依赖 Task 1/3
- Task 5 依赖 Task 2
- Task 6 最后执行
