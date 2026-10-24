# 工具参数 Schema 化（TypeBox）- 需求规格 (spec.md)

> 状态：待实施。本文档描述需求，选型推理见 design.md。

## 1. 背景

当前工具参数契约是「两层皮」：

- `parameters` 是手写的 JSON Schema 字面量，给 LLM 看
- `execute(params: Record<string, any>)` 内部靠 `params.xxx as string` 断言 + 手写校验代码兜底

两份事实来源靠人肉同步，且带来三类实际问题：

- 9 个内置工具里散布约 19 处 `as` 断言，字段名写错编译器不报错
- 参数校验逻辑（必填、类型、枚举、范围）在每个工具里重复手写，口径不一
- schema 改了就忘改校验代码（或反之），漂移没有任何机制兜底

## 2. 目标

- 引入 TypeBox 1.x，让每个工具的参数只有**一份事实来源**：TypeBox schema
  - 运行时：schema 本身就是 JSON Schema，直接作为 `parameters` 发给 LLM
  - 编译期：`Type.Static<typeof schema>` 推导参数类型，消灭 `as` 断言
  - 执行期：基类统一用 schema 做运行时校验，子类拿到的是已校验参数
- 参数形状校验（类型 / 必填 / 枚举 / 范围）全部下沉到 schema，工具内不再手写
- 校验失败以 `success: false` 的 `ToolResult` 返回，错误信息直接回灌 LLM，不抛异常

## 3. 核心契约形态

```ts
// 模块级：唯一事实来源
const readFileParams = Type.Object({
  file_path: Type.String({ minLength: 1, description: '要读取的文件路径' }),
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

export class ReadFileTool extends BaseTool<typeof readFileParams> {
  readonly parameters = readFileParams;   // 直接发给 LLM 的 JSON Schema

  protected async run(
    params: Type.Static<typeof readFileParams>,  // { file_path: string; offset?: number; limit?: number }
    context: ToolContext,
  ): Promise<ToolResult> { /* 业务逻辑，参数已校验 */ }
}
```

`BaseTool` 泛型化后持有校验入口，`execute` 收敛在基类：

1. `Schema.Compile(parameters)` 惰性编译校验器（实例级缓存）
2. `Check(raw)` 快速路径；失败时 `Schema.Errors()` 取明细拼错误信息
3. 校验通过 → 调用子类 `run(params, context)`

## 4. 详细需求

### R1：依赖引入

- 运行时依赖 `typebox`（1.x 主线，包名就是 `typebox`，**不是** `@sinclair/typebox`）
- 导入形态：`import Type from 'typebox'` + `import Schema from 'typebox/schema'`
- 需验证 NodeNext ESM 下子路径导入与 vitest 环境下均可正常工作

### R2：BaseTool 泛型化

- 签名：`abstract class BaseTool<S extends TSchema> implements Tool`
- 子类声明 `readonly parameters: S`；`run` 的参数类型由 `Type.Static<S>` 推导，schema 与类型强制同源
- `Tool` 接口**不泛型化**：`ToolManager` 按名字运行时分发，继续持有 `Map<string, Tool>`，`execute(params: Record<string, any>)` 签名不变
- `execute` 留在基类统一实现（校验 + 分发），子类只实现 `run`；保证「`run` 拿到的 `P` 是校验过的类型」这一契约不可能被子类绕过

### R3：校验执行策略

- 校验器实例级惰性编译并缓存（首次 `execute` 时），不随每次调用重建
- 快速路径 `Check()` 返回 boolean；仅失败时调用 `Schema.Errors()` 获取结构化明细
- 错误信息格式：`参数校验失败: <instancePath 或参数名>: <message>`，多条用 `;` 连接
- **不做中文翻译层**：错误消费者是 LLM（ToolResult 回灌）与开发者日志，结构化 `instancePath` + 英文 `message` 对模型更精确、更省 token（TypeBox 1.x 的 `Errors()` 自带 message，需要中文时可 `Locale.Set(zh_Hans)`，本期不启用）

### R4：校验分工边界

能用 JSON Schema 表达的一律进 schema：

- 类型、必填（`required`）、枚举（`Type.Union` + `Type.Literal` / 枚举）
- 数值范围（`minimum` / `maximum`）、字符串长度（`minLength` / `maxLength`）、数组长度（`minItems` / `maxItems`）

schema 表达不了的保留在 `run` 内手写：

- trim 后为空等带预处理的语义（schema 不做 coercion）
- `new URL()` 可解析性、`http:` / `https:` 协议白名单
- PathGuard 路径越界（依赖运行时项目根）
- 跨字段约束

### R5：九个内置工具全量迁移

| 工具 | 下沉到 schema 的校验 | 保留在 run 的校验 |
|------|---------------------|-------------------|
| list_dir | `path` 可选 string | 路径越界 |
| read_file | `file_path` 必填非空；`offset` / `limit` 正整数 | 路径越界 |
| search_by_regex | `pattern` 必填非空；其余可选 string | 正则合法性、路径越界 |
| write_file | `file_path` / `content` 必填 string | 路径越界 |
| edit_file | `file_path` / `old_string` / `new_string` 必填；`replace_all` 可选 boolean | 路径越界、old_string 存在性 |
| run_command | `command` 必填非空；`cwd` 可选；`timeout_ms` 范围 | cwd 路径越界 |
| finish | `summary` 必填非空 | trim 后空白 |
| ask_user | `question` 必填；`options` 数组 2-4 项、`label` 非空；`allowMultiple` 可选 boolean | trim 后空白 |
| web_fetch | `url` 必填且 ≤ 2000；`format` 三态枚举；`timeout_ms` 正数且 ≤ 120000 | URL 可解析性、协议白名单 |

迁移后工具实现内不再出现 `as string` / `as number` 类参数断言（`params` 字段访问由 `Type.Static` 保证）。

### R6：发给 LLM 的 schema 形态验证

- 确认 TypeBox 产出的 JSON Schema 被现有 `OpenAICompatibleProvider` 的 tools 链路原样接受（`toDefinition()` 透传）
- 若产出含 `$schema`（draft 2020-12）等字段，评估是否需要在 `toDefinition` 层剥除以兼容 OpenAI 风格服务
- schema 的 `description` 文案保持与现状一致，不因迁移改变模型可见信息

### R7：行为兼容性

- `ToolManager` 对外行为零变化：工具数量（9）、名称清单、`requiresConfirmation` 查询、未知工具错误均不变
- 工具的业务输出（成功内容、业务错误文案）不变
- 参数校验失败的错误文案允许变化（从手写中文变为结构化英文），对应测试断言同步更新
- 工具仍绝不抛异常：校验失败走 `ToolResult`，`run` 内异常由 `ToolManager.execute` 现有 try/catch 兜底

## 5. 非目标（明确不做）

| 项 | 理由 |
|----|------|
| RPC 契约层 schema 化（`ServiceDef` + Router 分发前校验） | 独立改动面，待工具层落地验证后单独立项 |
| `config.json` 磁盘解析校验 | 在 electron-main 包，随 RPC 契约层一并评估 |
| `AgentEvent` 流运行时校验 | 高频事件（text_delta）有性能约束，需单独设计抽样/分级策略 |
| Mock 剧本 JSON 校验 | 仅开发态，收益低 |
| web 端表单校验 | 明确排除；web 端若未来需要可选 Zod（表单生态），不受本决策约束 |
| 中文错误文案映射层 | 错误消费者是 LLM 与开发者，结构化英文更合适 |
| 参数 coercion（字符串转数字、trim 等） | 保持严格校验，LLM 传错形状就报错回灌，让模型自己修正 |
| `z.intersect` 式复杂组合 / 递归 schema | 现有工具参数全是扁平对象，不引入用不到的能力 |

## 6. 验收标准

- `agent-core` 新增依赖 `typebox`，NodeNext 构建与 vitest 运行均正常
- 9 个内置工具全部改为 `BaseTool<typeof schema>` 形态，实现内无参数 `as` 断言
- `BaseTool.execute` 统一校验入口：非法参数返回 `success: false` 且错误含参数路径信息
- `toDefinition()` 产出的 JSON Schema 与迁移前语义等价（required、枚举、范围不丢不变味）
- 测试与源文件一一对应迁移，参数非法用例改为断言结构化错误信息
- 全量测试零回归（业务行为用例不变）
- `openspec/systems/tool-system.md` 同步：参数契约章节、决策表、变更记录
