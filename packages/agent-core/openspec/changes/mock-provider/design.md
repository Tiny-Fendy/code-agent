# Mock LLM Provider - 设计方案 (design.md)

## 1. 核心设计决策

### D1：切换点收在 LLM 层内部，外部零感知

**决策**：不开放 Provider 注入点，`OpenAICompatibleProvider.chat()` 入口判断 mock 开关后委托，Agent 及所有调用方零改动。

**理由**：
- Mock 是开发态工具而非正式功能，不值得动公共 API（AgentOptions 加字段 + 类型挪包）
- 委托后 Agent 拿到的仍是一个 LLMProvider，事件流同构，上下游完全无感
- 代价是 OpenAICompatible 混入数行 mock 判断——相比改构造签名的代价小得多

**被否方案**：AgentOptions 增加 `llmProvider` 注入（改动面大，mock 不配拥有正式扩展位）；AgentConfig 加 `mockScript` 字段（污染生产配置类型）。

### D2：MockProvider 独立类，OpenAICompatible 薄委托

**决策**：全部 mock 逻辑（剧本、事件合成、calls 记录、开关管理）收在 `MockProvider.ts` 一个自包含文件内；OpenAICompatible 仅入口数行委托。

```typescript
// OpenAICompatible.ts —— 全文件唯一改动
async *chat(params: ChatCompletionParams): AsyncGenerator<LLMEvent> {
  if (mockEnabled()) {
    yield* mockStream(params);   // 委托给模块级 MockProvider 单例
    return;
  }
  // ...原有真实请求逻辑，零改动
}
```

**理由**：职责污染降到最小；MockProvider 保持可单测、可复用（临时脚本、未来 electron-main 调试入口直接 import）。

### D3：事件流与真实 Provider 严格同构

**决策**：Mock 合成的事件 data 形状与 OpenAICompatible 输出逐字段对齐。

对照基准（contracts AgentEvent 与 OpenAICompatible 实态）：

| 事件 | data 形状 | Mock 合成方式 |
|------|-----------|---------------|
| TextDelta | `{ delta: string }` | content 按码点按 chunkSize 切分逐块 yield |
| ToolCallDelta | `{ toolCalls: [{ id, name, arguments: string }] }` | 每个 toolCall 的 `JSON.stringify(arguments)` 切分，每次 yield 携带**全部 toolCall 的累积状态**（与 buildPartialToolCalls 一致） |
| MessageComplete | `{ message: ChatMessage }` | 剧本消息深拷贝后 yield |
| Error | `{ message: string }` | 剧本耗尽 / 配置失败 |

content 与 toolCalls 并存时先文本后工具（与真实流一致）。**同构是本设计的硬约束**——只有形状一致，Agent 的事件转发、tool_calls 累积、UI 渲染管线才被真实驱动。

### D4：双入口与优先级

**决策**：`显式 setMockProvider > 环境变量 > 关闭`。

| 入口 | 用途 | 剧本能力 |
|------|------|----------|
| 类 API `setMockProvider(provider)` | 代码内精确控制：动态剧本、delay、chunkSize、onExhausted | 静态 + 动态函数 |
| 环境变量 `CODE_AGENT_MOCK_SCRIPT=<path>` | 跨包调试零代码接入（electron-main 等） | 静态 JSON 数组 |

**理由**：env 入口满足"不改宿主代码即可切 mock"的调试诉求；类 API 承载 env 表达不了的动态剧本（函数可检查 `params.messages` 做有状态复现）。两者互不冲突，显式设置优先。

### D5：环境变量惰性初始化 + 失败安全

**决策**：
- 首次 `chat()` 时检查 `CODE_AGENT_MOCK_SCRIPT` 并加载 JSON 创建单例（模块加载时不读，规避 Electron 打包后 env 设置时机问题）；此后不再重复读盘
- 加载失败（文件不存在 / JSON 解析失败 / 结构非法）：进入**错误态单例**，后续每次 `chat()` 均 yield Error 事件说明 mock 配置错误，**绝不回退真实 LLM**

**理由**：mock 配置错误时静默走真实请求会意外消耗 token，违背本特性初衷；fail-loud 是唯一安全选择。

### D6：剧本耗尽行为

**决策**：默认 `'error'`——yield Error 事件（`Mock 剧本已耗尽（第 N 次调用）`），Agent 走 llmFailed，明确暴露剧本不够用；可选 `'loop'` 重复最后一条。

**理由**：静默循环会掩盖"剧本覆盖不足"的事实；显式失败便于发现剧本缺口。loop 供特定复现场景手动开启。

### D7：剧本消息深拷贝

**决策**：MessageComplete 返回 `structuredClone(剧本消息)`。

**理由**：Agent 会把消息对象 addMessage 进上下文；loop 模式或重复剧本条目会导致同一对象引用被多次加入，共享可变状态易埋雷。拷贝成本可忽略。

## 2. 接口定义

```typescript
// src/llm/MockProvider.ts —— 自包含，含类 + 模块级开关
import { LLMProvider, LLMEventType, type ChatCompletionParams, type LLMEvent } from './LLMProvider.js';
import type { ChatMessage } from '@code-agent/contracts';

/** 剧本条目：静态消息，或按请求动态生成（可检查上下文做有状态剧本） */
export type MockTurn =
  | ChatMessage
  | ((params: ChatCompletionParams) => ChatMessage | Promise<ChatMessage>);

export interface MockProviderOptions {
  /** 文本/参数增量切分粒度（字符），默认 4 */
  chunkSize?: number;
  /** 每块之间的延迟（ms），默认 0；手动观察流式效果时用 */
  delay?: number;
  /** 剧本耗尽行为：'error'（默认，yield Error 事件）| 'loop'（重复最后一条） */
  onExhausted?: 'error' | 'loop';
}

export class MockProvider extends LLMProvider {
  /** 收到的全部请求记录，供断言与排查 */
  readonly calls: ChatCompletionParams[] = [];

  constructor(
    private readonly script: MockTurn[],
    private readonly options: MockProviderOptions = {},
  ) {
    super('mock', 'mock://');   // apiKey/baseUrl 占位，mock 不发网络请求
  }

  async *chat(params: ChatCompletionParams): AsyncGenerator<LLMEvent> { /* 消耗剧本 + 合成事件流 */ }
}

// ---- 模块级开关（OpenAICompatible 委托用；类 API 入口） ----
export function setMockProvider(provider: MockProvider): void;
export function clearMockProvider(): void;
export function mockEnabled(): boolean;                 // 显式 > env > false
export function mockStream(params: ChatCompletionParams): AsyncGenerator<LLMEvent>;  // 取当前单例委托
```

**JSON 剧本格式**（`CODE_AGENT_MOCK_SCRIPT` 指向的文件，静态 assistant 消息数组）：

```json
[
  { "role": "assistant", "content": "", "toolCalls": [{ "id": "call_1", "name": "list_dir", "arguments": { "path": "." } }] },
  { "role": "assistant", "content": "项目根目录包含 src、test 等。" }
]
```

注意剧本条目是 **LLM 的回复**（assistant 消息），不是用户消息——每次 `chat()` 的返回对应一轮 assistant 响应。

## 3. 事件合成时序

```
chat(params)
  ├─ calls.push(params)
  ├─ 取剧本：动态函数则 await 执行 → ChatMessage；耗尽按 onExhausted
  ├─ content 非空：按码点 chunkSize 切分 → 逐块 yield TextDelta（块间 delay）
  ├─ toolCalls 非空：逐个切分 arguments JSON 串 → yield ToolCallDelta（携带累积状态数组）
  └─ yield MessageComplete(structuredClone(message))
```

## 4. 边界情况

| 场景 | 处理 |
|------|------|
| 剧本耗尽 | onExhausted='error'（默认）→ Error 事件；'loop' → 重复最后一条（仍深拷贝） |
| 动态函数抛异常 | 捕获 → Error 事件（`Mock 剧本执行失败: ...`），不中断调用方 |
| env 文件不存在 / JSON 非法 | 错误态单例，每次 chat() yield Error 事件，绝不回退真实 LLM |
| chunkSize ≤ 0 | 构造时归一为默认值 4 |
| emoji 等多字节字符 | 按 Unicode 码点（[...str]）切分，不截断 |
| content 与 toolCalls 并存 | 先文本增量后工具增量，最后 MessageComplete |
| 同一消息多次消耗（loop/重复条目） | structuredClone 隔离引用 |
| 测试间全局状态泄漏 | clearMockProvider()，单测 afterEach 调用 |

## 5. 与现有机制的关系

- **Agent 引擎**：零改动。mock 事件走既有 callLLM 分发，TextDelta/ToolCallDelta 透传、MessageComplete 组装、Error → llmFailed 全部复用
- **日志变更（openspec/changes/logging，未实施）**：相互独立无文件冲突；logging 落地后可在委托分支补一条 debug 埋点（`mock 模式启用`），非必须
- **现有测试**：默认关闭，零改动通过；AgentRun.test.ts 的 FakeProvider（事件级边缘用例注入）与 MockProvider（消息级剧本驱动）互补，不互替
- **electron-main**：本次零改动；未来调试入口可通过 env（零代码）或 import setMockProvider（精细控制）接入

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| mock 与真实事件形状漂移 | D3 对照表作为契约；单测断言 data 逐字段形状 |
| 全局状态影响测试 | clearMockProvider + afterEach 清理；默认关闭 |
| env 配置错误静默烧 token | D5 fail-loud，错误态单例绝不回退 |
| 剧本覆盖不足导致流程中断 | 耗尽默认 error 显式暴露；calls 记录辅助排查 |
