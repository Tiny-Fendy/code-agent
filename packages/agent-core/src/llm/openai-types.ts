/**
 * OpenAI 兼容 API 协议层原始类型
 *
 * 描述 OpenAI 兼容接口（OpenAI 官方、Azure OpenAI、DeepSeek、Moonshot，
 * 以及 vLLM / Ollama 等本地推理服务）流式响应的原始数据结构。
 *
 * 定位说明：
 * - 这是协议层类型，仅服务于 OpenAI 兼容系 Provider 的 SSE 解析
 * - 不属于 LLM 层抽象（跨 provider 的抽象见 LLMProvider.ts）
 * - 不进入 shared 包——它是 provider 实现细节，而非跨层共享契约
 *
 * 流式响应格式（SSE）：
 *   data: {"id":"...","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}
 *   data: {"id":"...","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}
 *   ...
 *   data: [DONE]
 */

/** SSE data: 行 JSON 解析后的单条流式数据块 */
export interface OpenAIStreamChunk {
  /** 响应 ID（同一次流式响应的所有数据块一致） */
  id?: string;
  /** 候选结果列表；当前实现只取 choices[0] */
  choices: OpenAIStreamChoice[];
}

/** 单条候选结果 */
export interface OpenAIStreamChoice {
  index: number;
  /** 增量数据：只携带本条数据块"新增的部分" */
  delta: OpenAIStreamDelta;
  /** 结束原因（stop / tool_calls / length 等）；流未结束时为 null */
  finish_reason: string | null;
}

/** 增量数据 */
export interface OpenAIStreamDelta {
  /** 角色，通常只在首个数据块出现 */
  role?: string;
  /** 文本片段，需逐块拼接为完整回复 */
  content?: string | null;
  /** 工具调用片段，与 content 互斥出现 */
  tool_calls?: OpenAIStreamToolCall[];
}

/**
 * 工具调用增量
 *
 * 关键特性：arguments 是逐段到达的 JSON 字符串片段（可能只有几个字符），
 * 必须按 index 累积拼接，待流结束后才能整体 JSON.parse。
 * 示例：
 *   第1块: {"index":0,"id":"call_xxx","function":{"name":"read_file","arguments":"{"}}
 *   第2块: {"index":0,"function":{"arguments":"\"path\":\"/"}}
 */
export interface OpenAIStreamToolCall {
  /** 工具调用序号：并发多个工具调用时用于区分各自的累积位置 */
  index: number;
  /** 调用 ID，通常只在首个片段出现 */
  id?: string;
  type?: string;
  function?: {
    /** 工具名，通常只在首个片段出现 */
    name?: string;
    /** JSON 字符串片段（不完整），需按 index 累积拼接 */
    arguments?: string;
  };
}
