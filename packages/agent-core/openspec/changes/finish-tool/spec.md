# finish 工具 - 需求规格 (spec.md)

## 1. 背景

技术方案第一期工具清单中包含 `finish` 工具：Agent 任务完成时主动调用，输出总结并结束循环。当前实现依赖 LLM 返回 `finish_reason: 'stop'` 自然结束，没有显式的 finish 机制，导致：

- Agent 可能在完成主要工作后继续无意义的"还有什么可以帮忙"式追问
- 无法区分「任务完成」与「等待用户输入」两种结束状态
- UI 无法感知「任务已完成」的语义，无法展示完成态

## 2. 目标

- LLM 在确认任务完成后，通过调用 `finish` 工具显式结束循环
- finish 调用携带 `summary` 参数，作为最终总结回传给用户
- Agent 检测到 finish 调用后，不再进入下一轮思考，直接输出 done 事件

## 3. 工具定义

| 属性 | 值 |
|------|-----|
| name | `finish` |
| description | 任务完成时调用，输出最终总结并结束当前对话循环 |
| parameters | `summary: string`（必填） |
| requiresConfirmation | `false` |
| 实现位置 | `agent-core` 内置 |

## 4. 详细需求

### R1：finish 工具注册

- finish 作为 agent-core 内置工具，随 ToolManager 构造时自动注册
- 与 list_dir / read_file 等文件工具同级，通过 createBuiltinTools 注入
- 不依赖 projectPath（无路径操作），构造函数可传空字符串或省略

### R2：Agent 循环识别 finish

- Agent 在工具执行阶段检测到 `finish` 被调用后：
  - 正常执行 finish 工具，获取 summary 内容
  - 将 summary 作为 tool 结果回灌到上下文（保持协议完整性）
  - **不再进入下一轮 LLM 调用**，直接 yield `done` 事件
  - done 事件的 data 中标记 `reason: 'finished'`，与 `reason: 'stop'`（自然结束）区分

### R3：系统提示词引导

- Agent 的系统提示词中需明确告知 LLM：
  - 任务完成后**必须**调用 finish 工具结束，而非仅回复文字
  - finish 的 summary 应包含：完成了什么、关键变更、遗留问题（如有）

### R4：边界处理

- finish 被调用时若 summary 为空或缺失，返回错误结果，Agent 继续循环（由 LLM 修正后重新调用）
- finish 不阻止用户中断（abort）——即使 finish 已调用，abort 仍可生效
- 同一轮内 finish 与其他工具被并行调用时，finish 优先处理，其余工具结果正常回灌，但循环在 finish 后结束

## 5. 事件流

正常完成场景：

```
... (tool_call_start) → (tool_call_result: finish) → done(reason: 'finished')
```

对比自然结束场景：

```
... (text_delta) → (message_complete) → done(reason: 'stop')
```

## 6. 非目标

- 不实现「自动 finish」——由 LLM 显式调用，Agent 不猜测任务是否完成
- 不实现 finish 前的用户确认（finish 是只读操作，无破坏性）
- 不实现多轮 finish 嵌套（子 Agent 场景留待后续）

## 7. 验收标准

- [ ] finish 工具注册到 ToolManager，LLM 可见
- [ ] Agent 检测到 finish 调用后正确结束循环，yield done(reason: 'finished')
- [ ] summary 内容正确回传，包含在 tool 结果与最终 done 事件中
- [ ] 空 summary 返回错误，Agent 继续循环
- [ ] 系统提示词包含 finish 使用引导
