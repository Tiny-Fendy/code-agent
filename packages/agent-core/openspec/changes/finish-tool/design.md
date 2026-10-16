# finish 工具 - 设计方案 (design.md)

## 1. 核心设计决策

### D1：finish 是工具而非特殊事件

**决策**：finish 实现为标准 Tool 接口，而非 Agent 内部硬编码的特殊逻辑。

**理由**：
- LLM 只能通过工具调用来表达意图，无法直接 yield 事件
- 工具机制天然支持 schema 校验、错误回灌、结果回传
- 与现有 6 个内置工具保持同构，新增成本最低

### D2：Agent 循环的退出时机

**决策**：在工具执行循环内检测到 finish 后，**立即**结束本轮，不再进入下一轮 LLM 调用。

**流程**：
```
for (const toolCall of toolCalls) {
  // 确认机制（finish 不需要确认）
  // 执行工具
  // 回灌结果
  
  if (toolCall.name === 'finish') {
    yield { type: 'done', data: { reason: 'finished', summary: result.content } };
    return; // 退出 run()，不再继续
  }
}
```

**理由**：
- finish 的语义就是「终止」，继续循环违背其意图
- 立即退出避免 LLM 在收到 finish 结果后产生多余的思考/回复
- 与 abort() 的退出方式对齐（都是立即 return）

### D3：done 事件的 reason 扩展

**决策**：扩展 `done` 事件的 data，新增 `reason: 'finished'`，并携带 `summary` 字段。

**现有 reason**：
- `'stop'`：LLM 自然结束（无工具调用）
- `'aborted'`：用户中断
- `'max_steps'`：超出最大步数

**新增**：
- `'finished'`：LLM 主动调用 finish 工具结束
- `summary`：finish 工具返回的总结内容

**理由**：UI 需要区分「任务完成」与「等待输入」两种结束态，展示不同的完成样式。

### D4：系统提示词引导策略

**决策**：在 Agent 的默认系统提示词模板中，追加 finish 使用说明。

**内容要点**：
- 明确 finish 是结束任务的唯一正确方式
- 说明 summary 应包含的要素（成果、变更、遗留问题）
- 禁止「仅回复文字作为结束」的暗示

**理由**：LLM 需要显式引导才能稳定调用 finish，否则容易退化到自然结束。

## 2. 接口变更

### AgentEventType 扩展（shared/types/agent.ts）

```typescript
export type AgentEventType =
  | 'text_delta'
  | 'tool_call_start'
  | 'tool_call_confirm'
  | 'tool_call_result'
  | 'context_compact'
  | 'message_complete'
  | 'error'
  | 'done';

// done 事件的 data 类型扩展
interface DoneEventData {
  reason?: 'stop' | 'aborted' | 'max_steps' | 'finished';
  steps?: number;
  summary?: string; // 仅 reason='finished' 时存在
}
```

### FinishTool 类（agent-core/tools/finish/FinishTool.ts）

```typescript
export class FinishTool extends BaseTool {
  name = 'finish';
  description = '任务完成时调用，输出最终总结并结束当前对话循环';
  parameters = {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '任务完成情况的简要总结' },
    },
    required: ['summary'],
  };
  requiresConfirmation = false;

  async execute(params: { summary?: string }): Promise<ToolResult> {
    if (!params.summary?.trim()) {
      return this.error('finish 工具必须提供非空的 summary 参数');
    }
    return this.success(params.summary);
  }
}
```

## 3. 边界情况

| 场景 | 处理 |
|------|------|
| 空 summary | finish 返回 error，Agent 继续循环，LLM 修正后重新调用 |
| finish 与其他工具并行调用 | 按顺序执行，finish 后的工具仍执行并回灌，但循环在 finish 后结束 |
| finish 调用后 abort() | abort 优先，循环立即中断，yield done(reason: 'aborted') |
| LLM 多次调用 finish | 第一次 finish 生效，后续 finish 作为普通工具执行（不会再次触发退出） |

## 4. 与现有机制的关系

- **工具确认**：finish 无需确认（requiresConfirmation=false），不触发 tool_call_confirm
- **上下文压缩**：finish 调用前的压缩检查正常执行，不受影响
- **错误恢复**：finish 参数错误时按标准工具错误处理，回灌 error 给 LLM 修正

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| LLM 不调用 finish，退化为自然结束 | 系统提示词强制引导；done(reason: 'stop') 作为兜底仍可用 |
| LLM 过早调用 finish，任务实际未完成 | 提示词中明确「仅在所有子任务完成后调用」；用户可追问继续 |
| 旧版本 Agent 不认识 finish 工具 | finish 未在 schema 中时，LLM 不会尝试调用，无兼容性问题 |
