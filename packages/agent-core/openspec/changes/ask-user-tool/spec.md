# ask_user 工具 - 需求规格 (spec.md)

> 状态：已实施（Task 1-5，2026-10-21）；宿主接线见 tasks.md Task 6。本文档描述需求，实现见源代码。

## 1. 背景

Agent 当前只能单向执行：LLM 在信息不足（方案取舍、参数偏好、目标范围不明确）时，只能猜测或直接失败，无法在执行中途向用户征询。

现有最接近的能力是「高危工具确认流」，但它是**二元决策**（通过 / 拒绝，返回 boolean），无法承载：

- 多选项单选 / 多选
- 自由文本输入
- 选择结果作为结构化观察回灌给 LLM

同时，宿主（Electron UI）与 Agent 之间缺少一条可复用的「请求用户输入 → 回填答案」通道。

## 2. 目标

- 新增内置标准工具 `ask_user`：LLM 在需要用户决策时主动调用
- 支持两种提问形态：选项选择（2-4 个，可单选/多选）与自由文本输入
- 用户回答以 `ToolResult` 回灌上下文，LLM 继续 ReAct 循环
- 交互请求经宿主回调直达 UI，与 AgentEvent 过程流解耦（不新增事件类型）
- 宿主未接入交互能力时优雅降级（返回错误观察，不挂起、不静默猜测）

## 3. 工具定义

| 属性 | 值 |
|------|-----|
| name | `ask_user` |
| description | 当信息不足或需要用户在多个方案间决策时，向用户提问并等待回答；不要用它询问是否可以使用工具 |
| parameters | `question: string`（必填）<br>`options?: Array<{label: string; description?: string}>`（选填，2-4 个）<br>`allowMultiple?: boolean`（选填，默认 false） |
| requiresConfirmation | `false`（本工具即为交互行为，无需二次确认） |
| 实现位置 | `agent-core` 内置 |

参数语义：

- `options` 省略或为空数组 → 自由文本输入
- `options` 存在 → 用户从选项中作答；`allowMultiple=true` 时可选多个
- `allowMultiple` 仅在 `options` 存在时有意义

## 4. 详细需求

### R1：工具注册

- `ask_user` 作为 agent-core 内置工具，随 `ToolManager` 构造自动注册
- 与 `finish` 同级，在 `createBuiltinTools` 组装点加一行，Agent 不做工具名特判
- 不依赖 `projectPath`

### R2：交互回调注入链路

- `contracts` 新增用户交互类型：`UserInputOption` / `UserInputRequest` / `UserInputResponse` / `UserInputCallback`
- `AgentOptions` 新增可选 `onAskUser?: UserInputCallback`
- `ToolContext` 新增可选 `requestUserInput?: UserInputCallback`（与 `logger` 同为宿主能力，缺省不注入）
- Agent 构造时把 `options.onAskUser` 挂到 `toolContext.requestUserInput`
- `ToolManager` 不感知该能力：工具从 `context` 自取，自定义工具同样可用

### R3：回答映射

- 有选中项：`ToolResult.content = 用户选择：A、B`（顿号分隔）
- 无选中项但 `text` 非空：`ToolResult.content = 用户输入：<text>`
- 两种情况均返回 `success: true`
- 空回答（既无选中也无文本）→ `success: false`，错误文案说明用户未作答

### R4：参数校验

以下情况返回 `success: false`，由 LLM 自行修正后重试（不抛异常）：

- `question` 缺失或空白
- `options` 提供了但数量不在 2-4 之间
- 任一 `option.label` 缺失或空白
- 单选场景（`allowMultiple` 非 true）返回了多个选中项

### R5：降级策略

| 场景 | 行为 |
|------|------|
| 宿主未注入 `onAskUser` | 返回错误观察：`当前环境不支持用户交互` |
| 回调抛出异常 | 返回错误观察：`用户交互失败: <message>`，不向上抛 |
| 回调返回空回答 | 返回错误观察：`用户未作出选择` |

绝不静默选择默认项或猜测答案。

### R6：系统提示词引导

- 默认系统提示词新增 `ask_user` 使用原则：
  - 信息不足或存在多个合理方案时，先问再动手
  - 能通过工具自行确认的信息（读文件、搜索）不要问用户
  - 一次只问一个问题，选项控制在 2-4 个且互斥
- 自定义 `systemPrompt` 时由调用方自行决定，框架不强行追加

### R7：日志

- 请求发起 / 收到回答：`info`（含选项数量、耗时）
- 未接入回调、回调异常、空回答、参数非法：`warn`
- 日志经 `ToolContext.logger` 输出（缺省 `NullLogger`）

### R8：事件流

- **不新增 AgentEvent 类型**
- 请求内容随既有的 `tool_call_start`（`arguments` 含 question/options）送达 UI，回答随 `tool_call_result` 留痕
- 交互弹层本身由宿主回调驱动，事件流只负责对话记录

## 5. 交互时序

```
LLM 返回 tool_call(ask_user)
  → Agent yield tool_call_start
  → ToolManager.execute → AskUserTool.execute
  → context.requestUserInput(request)          # 宿主回调，等待 UI 回答
  ← response
  → ToolResult（用户选择/用户输入）
  → Agent yield tool_call_result
  → role='tool' 消息回灌上下文
  → 下一轮 LLM 思考
```

## 6. 非目标

- 不新增 `AgentEvent` 类型，不引入事件队列桥接
- 不做引擎级超时与取消管理（宿主回调负责；与现有确认流保持一致）
- 不支持一次调用提交多个问题（一次一个）
- 不做默认选项 / 预选 / 倒计时
- 不做 `electron-main` 侧 RPC 接线（另批协作，见 tasks Task 6）

## 7. 验收标准

- [x] `ask_user` 出现在 `ToolManager.getDefinitions()`，LLM 可见
- [x] 注入 `onAskUser` 后，回调收到完整 request（question / options / allowMultiple 原样透传）
- [x] 单选、多选、自由输入三种回答均正确映射为 ToolResult 并回灌
- [x] 未注入回调 / 回调异常 / 空回答 / 参数非法均返回错误观察，Agent 循环不中断
- [x] `tool_call_start` 与 `tool_call_result` 事件顺序正确，无需新增事件类型
- [x] 全量测试无回归，typecheck 通过
