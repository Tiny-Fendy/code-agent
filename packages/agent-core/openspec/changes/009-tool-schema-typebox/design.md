# 工具参数 Schema 化（TypeBox）- 设计方案 (design.md)

## 0. 选型对照

| 维度 | Zod 4 | TypeBox 1.x | json-schema-to-ts | 手写泛型 |
|------|-------|-------------|-------------------|----------|
| 主产物 | TS 类型（schema 靠 `z.toJSONSchema()` 翻译） | **JSON Schema 本身**（类型靠 `Type.Static` 推导） | 现有 schema 字面量 | 手写 interface |
| 翻译损耗 | 有：`transform` / `custom` 无法转 schema，会抛错 | 无（不存在翻译层） | 无 | 无 |
| 运行时校验 | `safeParse` | `Schema.Compile().Check/Parse`（JIT 编译） | 无 | 无 |
| 错误信息 | 英文 issue 树，文案生态丰富 | 结构化 `keyword/instancePath` + 自带 message，内置 locale（含 zh_Hans） | — | — |
| 生态 | 极大（表单、tRPC） | 中等（Fastify 系）；1.x 资料少于 0.x | 小 | — |
| 体积 | 较大 | 核心小，校验器独立子模块 | 0（纯类型） | 0 |

**关键判断**：本项目的 schema 消费者是 **LLM**（JSON Schema 提示词），不是 TS 编译器。TypeBox 的「schema 为主产物、类型为推导副产物」与这个方向完全一致；Zod 方向相反，且其最大优势（前端表单生态）因 web 端被明确排除而用不上。

## 1. 核心设计决策

### D1：选型 TypeBox 1.x（`typebox` 包）

**决策**：引入 `typebox`（1.4.3+），不使用旧命名线 `@sinclair/typebox`（0.34.x）。

**理由**：

- 工具参数的 JSON Schema 零转换直达 LLM，`parameters = schema` 就是发给模型的东西
- `typebox/schema` 子模块提供 `Compile` / `Check` / `Errors`，校验能力按需引入
- 未来 RPC 契约层（ServiceDef schema 化）同样是「schema 即协议描述」的场景，TypeBox 可无缝延伸

**代价**：

- 1.x 是新大版本，网上资料多为 0.x 写法（`Value.Check`），排查问题时需注意甄别
- 无 `transform` / 链式 `refine`，跨字段约束需手写（本期工具参数无此需求）
- 团队认知成本：`Type.Union([Type.Literal('a'), ...])` 组合式写法

### D2：schema 即唯一事实来源，泛型参数强制同源

**决策**：子类形态固定为

```ts
const xxxParams = Type.Object({ ... });          // 模块级 const：唯一事实来源

export class XxxTool extends BaseTool<typeof xxxParams> {
  readonly parameters = xxxParams;
  protected async run(params: Type.Static<typeof xxxParams>, context: ToolContext) { ... }
}
```

基类签名：`abstract class BaseTool<S extends TSchema> implements Tool`，`run` 的参数类型写作 `Type.Static<S>`。

**理由**：

- 泛型参数 `S` 同时决定「发给 LLM 的 schema」和「`run` 的参数类型」，两边由同一个 `typeof xxxParams` 推出，**编译器强制同源**，不可能漂移
- schema 定义为模块级 const 而非类字段字面量，是因为类体内无法 `typeof` 自身字段
- `Tool` 接口保持非泛型：`ToolManager` 是运行时分发器，泛型信息在它的层级本来就被擦除，不污染接口

**备选方案（已否决）**：`BaseTool<P>` 直接泛型参数类型、schema 另写字段——P 与 schema 的关联编译器无法检查，又回到两层皮。

### D3：校验收敛到基类，`execute` 不下放

**决策**：`BaseTool` 实现 `execute`（校验 + 调用 `run`），子类只实现 `run`。

**理由**：

- 「`run` 的参数是校验过的类型」这一契约由基类保证，子类无法绕过
- 19 处 `as` 断言与散落的形状校验代码一次性消除
- 校验失败统一返回 `success: false` + 结构化错误，行为口径一致

**代价**：`execute` 在基类不能用 `abstract`/`final` 关键字组合表达「禁止覆写」——TS 没有 final 方法。靠约定 + code review 守住；子类没有动机覆写（覆写后类型契约失效，编译器会因 `run` 缺失报错）。

### D4：校验执行策略——编译缓存 + 两阶段

**决策**：

- 校验器在实例首次 `execute` 时 `Schema.Compile(parameters)` 并缓存为私有字段
- 每次调用先 `Check(raw)`（快速路径，只回 boolean）
- 仅失败时调 `Schema.Errors(parameters, raw)` 拿 `TLocalizedValidationError[]`，拼成 `参数校验失败: /url: <message>; /timeout_ms: <message>`

**理由**：

- `Compile` 是 JIT 生成校验函数，有成本，必须缓存；参数对象很小，失败时二次校验取明细的重复开销可忽略
- 两阶段避免在热路径上分配错误数组

### D5：不做中文错误翻译层

**决策**：校验错误直接使用 TypeBox `Errors()` 自带的英文 `message` + `instancePath`，本期不启用 `Locale.Set(zh_Hans)`，不自建映射层。

**理由**：

- 错误消费者是 LLM（随 `ToolResult.error` 回灌）与开发者日志，**没有终端用户**
- 对模型而言，`/options: expected array to have >= 2 items` 比中文散文更精确、更省 token
- 现有手写中文断言（如「2-4」）随迁移更新为结构化英文断言

### D6：校验分工——形状进 schema，语义留 run

**决策**：

| 层 | 负责 | 例子 |
|----|------|------|
| schema | 类型、必填、枚举、数值/字符串/数组范围 | `minLength`、`minimum`、`Union([Literal(...)])`、`minItems: 2` |
| `run` | 预处理语义、外部资源、跨字段 | trim 后空白、`new URL()`、协议白名单、PathGuard 越界 |

**理由**：JSON Schema 无 coercion、无法表达「trim 后非空」和运行时环境约束（项目根）；强塞进 schema 只能靠 `refine` 类扩展，TypeBox 对此支持弱，反而破坏「schema 可序列化直达 LLM」的纯净性。

### D7：不做 coercion

**决策**：开启严格校验，不做类型强转（`"30000"` 不转成 `30000`）。

**理由**：LLM 传错形状应该收到错误并自我修正，静默强转会掩盖模型行为问题，也让 schema 与真实约束不一致。

## 2. 风险与验证项

| # | 风险 | 验证方式 | 缓解 |
|---|------|----------|------|
| R1 | TypeBox 产出 schema 含 `$schema` / draft 2020-12 关键字，OpenAI 兼容服务可能拒绝 | 样板阶段打印 `toDefinition()` 实测 | 必要时在 `toDefinition` 层剥除 `$schema`；`parameters` 字段本身保持原样 |
| R2 | NodeNext ESM 下 `import Schema from 'typebox/schema'` 子路径解析 | 样板阶段 typecheck + 单测运行 | typebox 1.4.3 `exports` 已声明 `./schema` 子路径，预期可用 |
| R3 | `Type.Static` 在现有工具参数形态上的推导正确性（可选字段、枚举） | 样板工具（read_file）单测覆盖 | 现有参数全是扁平对象，属 TypeBox 最稳的场景 |
| R4 | vitest（bundler 解析）与 tsc（NodeNext）双环境下导入一致性 | 样板阶段同时跑 typecheck 与 test | 两者都读 `exports` 字段，预期一致 |

## 3. 样板验证切片

第一步只落地 `base.ts` + `ReadFileTool` + 其测试，验证通过标准：

1. `pnpm -F @code-agent/agent-core typecheck` 通过
2. `ReadFileTool.test.ts` 全绿，非法参数断言为结构化英文错误
3. 打印 `new ReadFileTool(...).toDefinition()`，确认 schema 形态可直接发给 LLM（R1/R2 风险关闭）

样板验收后再批量迁移剩余 8 个工具。

## 4. 后续扩展方向（本期不做）

- **RPC 契约层**：`ServiceDef` 增加可选 schema 字段，`Router` 分发前统一校验——与工具层共享 TypeBox，一次投入全服务受益
- **config.json**：`Schema.Compile().Parse()` 替换 `as Partial<AppConfig>`，失败回退默认值 + 日志
- **AgentEvent 流**：仅校验结构型事件或开发模式开启，`text_delta` 高频事件不校验
