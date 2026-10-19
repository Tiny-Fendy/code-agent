# Mock LLM Provider - 需求规格 (spec.md)

## 1. 背景

Agent 全链路验证目前只有两条路：单测（FakeProvider 私有夹具）与真实 LLM 联调。存在问题：

- 真实 LLM 联调消耗 token，开发验证阶段的**经济成本**高且不必要
- LLM 输出不确定，问题难以稳定复现；需要"用固定剧本驱动除 LLM 外的全链路"的手段
- 后期定位问题时，同样希望脱离真实 LLM，用 mock 数据重放流程

Agent 的工具链、确认流、上下文压缩、finish 检测等逻辑验证不依赖真实 LLM——一条剧本化的 assistant 消息序列即可驱动。

## 2. 目标

- 提供 `MockProvider`：以剧本（ChatMessage 序列）驱动，合成与真实 Provider **同构**的事件流，完整跑通 Agent ReAct 循环（除 LLM 本身）
- 切换机制**对原代码改动最小、外部零感知**：Agent / AgentOptions / contracts / 调用方零改动，切换点收在 LLM 层内部
- 双入口：
  - **类 API**：代码内精确控制（动态剧本、延迟等完整能力）
  - **环境变量**：跨包调试零代码接入（静态 JSON 剧本）
- Mock 是开发态工具，默认完全关闭，生产与测试零影响

## 3. 范围

| 项 | 归属 |
|----|------|
| `MockProvider` 类、`MockTurn`、模块级开关函数 | `agent-core/src/llm/MockProvider.ts`（新文件，自包含） |
| OpenAICompatibleProvider 入口委托 | `agent-core/src/llm/OpenAICompatible.ts`（仅入口数行） |
| 包入口导出 | `agent-core/src/index.ts` |
| Agent / AgentOptions / contracts / electron-main | **零改动** |

## 4. 详细需求

### R1：MockProvider 类

- 继承 `LLMProvider`，与 OpenAICompatibleProvider 同级
- 构造参数：`script: MockTurn[]`、`options?: MockProviderOptions`
- `MockTurn`：静态 `ChatMessage` 或动态函数 `(params: ChatCompletionParams) => ChatMessage | Promise<ChatMessage>`（动态函数可检查 `params.messages` 做有状态剧本，用于问题复现）
- `MockProviderOptions`：`chunkSize`（增量切分粒度，默认 4）、`delay`（每块延迟 ms，默认 0）、`onExhausted`（剧本耗尽行为，`'error' | 'loop'`，默认 `'error'`）
- `calls: ChatCompletionParams[]`：记录收到的全部请求，供断言与排查
- 每次 `chat()` 消耗一条剧本；耗尽时按 `onExhausted` 处理：`error` → yield Error 事件（Agent 走 llmFailed，明确暴露剧本不够用）；`loop` → 重复最后一条

### R2：事件合成规则（与真实 Provider 同构）

- content：按 `chunkSize` 切分逐块 yield `TextDelta`（按 Unicode 码点切分，避免截断多字节字符）
- toolCalls：`arguments` JSON 序列化后切分逐段 yield `ToolCallDelta`，data 形状与 OpenAICompatible 输出对齐：`{ toolCalls: [{ id, name, arguments: <累积片段> }] }`
- 结束：yield `MessageComplete`（完整消息）
- content 与 toolCalls 并存时，先文本后工具调用（与真实行为一致）

### R3：模块级开关（类 API 入口）

- `setMockProvider(provider)`：设置模块级 Mock 单例
- `clearMockProvider()`：清除（测试 afterEach 清理，防全局状态泄漏）
- 优先级：显式 `setMockProvider` > 环境变量 > 关闭

### R4：环境变量入口

- `CODE_AGENT_MOCK_SCRIPT=<path>`：指向 JSON 剧本文件（静态 ChatMessage 数组）
- **惰性初始化**：首次 `chat()` 调用时读取并创建单例，不在模块加载时读（规避 Electron 打包后 env 设置时机问题）
- JSON 剧本仅支持静态消息；动态剧本走类 API（能力分层）
- 读取/解析失败：**绝不回退到真实 LLM**（防止意外消耗 token），后续每次 `chat()` 均 yield Error 事件说明 mock 配置错误

### R5：安全约束

- 默认关闭：不设置开关时行为与现状完全一致
- mock 模式下不发任何网络请求
- MockProvider 对剧本消息返回深拷贝（`structuredClone`），避免同一消息对象被多次加入上下文造成共享引用

### R6：测试支持

- `test/llm/MockProvider.test.ts`（镜像结构）：事件合成、剧本消耗、耗尽行为、动态剧本、calls 记录、深拷贝
- OpenAICompatible 委托路径：setMockProvider 后 chat() 返回 mock 事件且不发网络请求
- 现有测试零改动通过

## 5. 非目标

- 不做录制/回放（真实 LLM 响应落盘重放）；动态剧本 + JSON 加载已覆盖，未来需要时 MockTurn 从文件加载即可，接口不用改
- 不模拟 token 用量、重试、限流等协议细节
- **不开放 Provider 注入点**（Agent/AgentOptions 不动；agent-engine.md 中"等出现第二种协议再抽象"的约定继续保留）
- JSON 剧本不支持动态函数

## 6. 验收标准

- [ ] MockProvider 事件流形状与 OpenAICompatible 同构，Agent 全链路（工具链、确认流、压缩、finish）可被剧本驱动
- [ ] 类 API：setMockProvider / clearMockProvider 生效，优先级正确
- [ ] 环境变量：CODE_AGENT_MOCK_SCRIPT 惰性加载 JSON 剧本生效，配置失败不回退真实 LLM
- [ ] 默认关闭下现有测试零改动通过
- [ ] systems/llm-access.md 补录完成
