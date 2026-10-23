# ask_user 工具 - 设计方案 (design.md)

## 1. 核心设计决策

### D1：ask_user 是标准内置工具，不是 Agent 特判

**决策**：实现为标准 `BaseTool`，由 `ToolManager.createBuiltinTools` 注册；Agent 不按工具名写分支。

**理由**：

- 工具调用是 LLM 表达「需要用户输入」的唯一合法方式
- 复用现有的 schema 校验、错误回灌、结果回传、`tool_call_start/result` 事件
- 与 `finish` 的工具化思路一致，新增成本最低
- 自定义工具也能复用同一交互能力（从 `ToolContext` 取回调）

### D2：交互回调走 ToolContext，不穿透 ToolManager

**决策**：`AgentOptions.onAskUser` 在 Agent 构造时挂到 `this.toolContext.requestUserInput`；工具从上下文自取。

**理由**：

- `ToolManager` 只负责调度，不应承载宿主交互语义
- `ToolContext` 已经是「宿主提供给工具的能力集合」（现有 `logger` 同构）
- 自定义工具通过 `register()` 注入后同样能拿到该能力
- 缺省不注入 → 工具层明确返回错误，而非引擎层隐式吞掉

### D3：不新增 AgentEvent 类型

**决策**：不新增 `user_ask` 事件；请求与回答分别由 `tool_call_start` / `tool_call_result` 承载。

**理由**：

- 在工具执行内部向 Agent 生成器 yield 事件需要额外的 push-pull 队列桥接，并引入并发与中断处理复杂度
- `tool_call_start.data.arguments` 已包含 question / options，UI 可直接渲染对话留痕
- 交互弹层由宿主回调直接驱动（与 `onConfirm` 的宿主用法同构），事件流只做记录
- 少一个事件类型，RPC 契约不变，宿主无需同步升级事件枚举

**代价**：请求的「实时送达」依赖宿主回调而非事件流。若未来 RPC 层希望仅靠事件流驱动 UI，再补事件类型即可，不影响工具契约。

### D4：回答契约按「有无 options」二选一

**决策**：`UserInputResponse` 同时提供 `selected?: string[]` 与 `text?: string`，按优先序解释：

1. `selected` 非空 → 选择结果
2. 否则 `text` 非空 → 自由输入 / 自定义补充
3. 两者皆空 → 未作答错误

**理由**：

- 单选、多选、自由输入共用一条返回通道，宿主实现简单
- 容忍宿主在「选项 + 其他输入」场景回传 text
- 回填内容是人类可读文本，LLM 无需解析嵌套结构

### D5：失败一律降级为错误观察

**决策**：无回调、回调异常、参数非法、空回答都返回 `success: false` 的 ToolResult。

**理由**：

- Agent 不能因为宿主缺能力而挂起
- 错误观察会回灌 LLM，让它改用其他工具或直接回答
- 绝不静默选择默认项——错误的选择比明确失败更糟

### D6：超时与取消由宿主负责

**决策**：工具层不设置超时，不引入 `AbortSignal`。

**理由**：

- 与现有 `onConfirm` 交互语义保持一致（回调 Promise 的完成时机由宿主掌控）
- Agent 的 `abort()` 只在检查点生效，无法中断已 await 的宿主 Promise
- 宿主可用 RPC 超时 / 弹层关闭自行 resolve 空回答，工具层已有对应错误路径

**限制记录**：若宿主回调永不 resolve，`run()` 会保持挂起。该限制与确认流相同，后续统一引入 `AbortSignal` 时一并解决。

### D7：一次一个问题

**决策**：参数只接受单个 `question`，不支持批量问题。

**理由**：批量问答显著增加 UI 与回答映射复杂度；LLM 可连续多次调用 `ask_user`，成本可控。

## 2. 接口变更

### 2.1 contracts 新增 `types/user-input.ts`

```ts
/** 用户输入选项 */
export interface UserInputOption {
  /** 选项文本（回填的唯一标识） */
  label: string;
  /** 选项说明（UI 展示用，可选） */
  description?: string;
}

/** 一次用户输入请求 */
export interface UserInputRequest {
  /** 问题（非空） */
  question: string;
  /** 选项；省略或空数组表示自由文本输入 */
  options?: UserInputOption[];
  /** 是否允许多选（仅 options 存在时有效，默认 false） */
  allowMultiple?: boolean;
}

/** 用户回答 */
export interface UserInputResponse {
  /** 选中的选项 label（有 options 时使用） */
  selected?: string[];
  /** 自由输入 / 自定义补充文本 */
  text?: string;
}

/** 宿主实现：把请求转发给 UI 并等待作答 */
export type UserInputCallback = (request: UserInputRequest) => Promise<UserInputResponse>;
```

contracts 入口导出上述类型。

### 2.2 `ToolContext` 扩展

```ts
export interface ToolContext {
  projectPath: string;
  logger?: Logger;
  /** 请求用户输入；未注入时工具应返回「不支持交互」错误 */
  requestUserInput?: UserInputCallback;
}
```

### 2.3 `AgentOptions` 扩展

```ts
export interface AgentOptions {
  onConfirm?: ToolConfirmCallback;
  /** 用户输入回调；未注入时 ask_user 降级为错误观察 */
  onAskUser?: UserInputCallback;
  logger?: Logger;
}
```

### 2.4 `AskUserTool`（agent-core/src/tools/ask-user/AskUserTool.ts）

```ts
export class AskUserTool extends BaseTool {
  name = 'ask_user';
  description = '当信息不足或需要用户在多个方案间决策时，向用户提问并等待回答。';
  parameters = {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要向用户提出的问题' },
      options: {
        type: 'array',
        description: '供用户选择的选项，2-4 个；省略表示自由文本输入',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['label'],
        },
        minItems: 2,
        maxItems: 4,
      },
      allowMultiple: { type: 'boolean', description: '是否允许多选，默认 false' },
    },
    required: ['question'],
  };
  requiresConfirmation = false;

  async execute(params, context): Promise<ToolResult> {
    // 1. 参数校验（question / options 2-4 / label）
    // 2. context.requestUserInput 缺失 → error('当前环境不支持用户交互')
    // 3. await 回调，异常 → error
    // 4. 回答映射：
    //      selected 非空 → success(`用户选择：${selected.join('、')}`)
    //      text 非空     → success(`用户输入：${text}`)
    //      皆空          → error('用户未作出选择')
    // 5. 单选场景 selected.length > 1 → error
  }
}
```

### 2.5 ToolManager 组装点

```ts
private createBuiltinTools(projectPath: string): Tool[] {
  return [
    // ...现有 7 个
    new AskUserTool(),
  ];
}
```

### 2.6 Agent 注入与提示词

```ts
this.toolContext = {
  projectPath,
  logger: this.logger,
  requestUserInput: options?.onAskUser,
};
```

`DEFAULT_SYSTEM_PROMPT` 追加：

```
ask_user 工具的使用：
- 信息不足或存在多个合理方案时，先调用 ask_user 征询，不要凭空假设
- 能通过工具自行确认的（读文件、搜索）不要问用户
- 一次只问一个问题，选项 2-4 个且互斥
```

## 3. 边界情况

| 场景 | 处理 |
|------|------|
| `question` 空白 | error：`ask_user 必须提供非空的 question 参数` |
| `options` 数量为 1 或 >4 | error：`options 数量必须为 2-4 个，或省略表示自由输入` |
| `option.label` 空白 | error：`options[1].label 不能为空` |
| 无 `options`，`text` 为空 | error：`用户未作出选择` |
| 无 `options`，回调返回 `selected` | 忽略 selected，按 text 路径处理（selected 为空则 error） |
| 单选返回多个 selected | error：`单选场景只能返回一个选项` |
| 宿主未注入回调 | error：`当前环境不支持用户交互` |
| 回调抛异常 | error：`用户交互失败: <message>`，不向上抛 |
| 用户中断（abort）发生在等待期间 | 回调返回后工具正常产出结果；下一检查点由 Agent 返回 `aborted`（限制同确认流） |
| 同一轮多个 ask_user | 串行执行，逐个等待作答 |

## 4. 与现有机制的关系

- **确认流**：`ask_user.requiresConfirmation=false`，不会触发 `tool_call_confirm`；确认与提问是两条独立通道
- **finish**：互不影响；LLM 可以在得到用户回答后继续调用工具，最终以 finish 结束
- **上下文压缩**：问答结果作为普通 tool 消息参与压缩，无特殊处理
- **日志**：复用 `ToolContext.logger`，不新增全局日志依赖
- **MockProvider**：事件流不变，脚本可直接模拟 ask_user 工具调用，无需额外适配

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| LLM 滥用 ask_user（该自己查的也问用户） | 系统提示词明确「能自行确认的不要问」 |
| 宿主回调迟迟不返回，任务挂起 | 宿主自行加超时并 resolve 空回答；工具返回「用户未作出选择」后 LLM 可继续 |
| 选项文案与 LLM 后续引用不一致 | 回填使用 `label` 原文，不做改写 |
| 宿主未接线导致功能不可用 | 明确错误观察 + 验收用例覆盖，避免静默失败 |
| 未来需要实时事件驱动 UI | 工具契约不变，仅需在 Agent 增加事件桥接，属于增量演进 |
