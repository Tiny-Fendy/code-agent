/**
 * 工具基类与接口
 *
 * 工具系统是 Agent 能力的延伸——Agent 通过调用工具来与外部世界交互。
 * 每个工具就是一个"函数"，有名称、描述、参数 schema，LLM 决定什么时候调用它。
 *
 * 参数契约（009-tool-schema-typebox）：
 * - 子类以 TypeBox schema 作为参数的唯一事实来源，直接持有在 `parameters` 上
 * - `execute` 收敛在基类：先按 schema 校验，通过后分发到子类 `run`
 * - `run` 的参数类型由 `Type.Static<S>` 推导，与 schema 强制同源，且保证已校验
 */

import type { TSchema, Static } from 'typebox';
import Schema from 'typebox/schema';
import type { Validator } from 'typebox/schema';
import type { TLocalizedValidationError } from 'typebox/error';
import type { ToolDefinition, ToolResult, ToolContext } from '@code-agent/contracts';

/**
 * Tool 接口
 *
 * 所有工具都必须实现这个接口。Agent 通过 ToolManager 统一调度。
 * 接口保持非泛型：ToolManager 按名字运行时分发，泛型信息在此层级被擦除。
 */
export interface Tool {
  /** 工具名称（唯一标识，只能是字母数字下划线） */
  name: string;

  /** 工具描述（指导模型何时使用，越精准越好） */
  description: string;

  /** 参数 schema（JSON Schema 格式，type: object + properties） */
  parameters: Record<string, any>;

  /** 是否需要用户确认后才能执行 */
  requiresConfirmation: boolean;

  /**
   * 执行工具
   * @param params LLM 解析出的参数（未经校验的原始值）
   * @param context 工具执行上下文（项目路径等宿主环境信息）
   */
  execute(params: Record<string, any>, context: ToolContext): Promise<ToolResult>;

  /** 转换为 LLM 需要的 tool definition 格式 */
  toDefinition(): ToolDefinition;
}

/**
 * BaseTool 抽象基类
 *
 * 泛型 S 为子类的 TypeBox 参数 schema 类型：schema 同时决定发给 LLM 的
 * JSON Schema 与 `run` 的参数类型（Type.Static<S>），编译器强制两边同源。
 */
export abstract class BaseTool<S extends TSchema = TSchema> implements Tool {
  abstract name: string;
  abstract description: string;
  abstract readonly parameters: S;
  abstract requiresConfirmation: boolean;

  /** 参数校验器：首次 execute 时由 schema 编译并缓存，不随调用重建 */
  private validator?: Validator<S>;

  /**
   * 统一执行入口：先按 schema 校验参数，校验失败以错误 ToolResult 返回，
   * 通过后分发到子类 `run`。子类不得覆写本方法——「run 拿到的参数已校验」
   * 这一契约由基类保证（TS 无 final 方法，靠约定守住）。
   */
  async execute(raw: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const validator = (this.validator ??= Schema.Compile(this.parameters));
    if (!validator.Check(raw)) {
      const [, errors] = validator.Errors(raw);
      return this.error(`参数校验失败: ${formatValidationErrors(errors)}`);
    }
    return this.run(raw, context);
  }

  /**
   * 业务实现入口。params 已通过 schema 校验，类型为 Static<S>。
   *
   * 校验分工：形状（类型/必填/枚举/范围）由 schema 承担；语义（trim 空白、
   * URL 协议白名单、路径越界等）仍在本方法内校验。
   */
  protected abstract run(params: Static<S>, context: ToolContext): Promise<ToolResult>;

  toDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters as Record<string, any>,
    };
  }

  /** 工具：成功返回 */
  protected success(content: string): ToolResult {
    return { success: true, content };
  }

  /** 工具：失败返回 */
  protected error(message: string): ToolResult {
    return { success: false, content: '', error: message };
  }
}

/**
 * 拼装参数校验错误：`<instancePath>: <message>`，多条以 `;` 连接。
 * 错误消费者是 LLM（随 ToolResult 回灌）与开发者日志，保留英文 message
 * 与结构化路径，不做中文翻译。required 类错误的 instancePath 为空，
 * 此时 message 本身已含参数名，直接使用。
 */
function formatValidationErrors(errors: TLocalizedValidationError[]): string {
  return errors
    .map((e) => (e.instancePath ? `${e.instancePath}: ${e.message}` : e.message))
    .join('; ');
}
