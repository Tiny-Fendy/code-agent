# 工具参数 Schema 化（TypeBox）- 任务清单 (tasks.md)

> 状态：Task 1-4 已实施（2026-10-24）。任务按依赖顺序排列。

## Task 1：基类改造 + ReadFileTool 样板验证

**优先级**：P0
**预估工作量**：中

- [x] 引入依赖：`typebox`（1.4.3，运行时）
- [x] 改造 `packages/agent-core/src/tools/base.ts`
  - `BaseTool<S extends TSchema>` 泛型化，`execute` 收敛基类（惰性编译 Validator + Check + Errors）
  - 新增 `protected run(params: Static<S>, context)`（**过渡态为非 abstract**，存量工具仍覆写 `execute`；Task 2 完成后改为 abstract）
  - `Tool` 接口不变；`toDefinition` 不变
  - 错误拼装：`参数校验失败: <path>: <message>` 多条 `;` 连接（required 类错误路径为空时直接用 message）
- [x] 迁移 `ReadFileTool` 为样板：模块级 schema + `run` 实现，删除手写形状校验与 `as` 断言
- [x] 迁移 `test/tools/file/ReadFileTool.test.ts`：新增空字符串 / 非正 offset 断言结构化错误，补 offset 分段行号用例
- [x] 样板验证（关闭 design.md R1/R2/R3/R4）
  - typecheck 通过（NodeNext 子路径导入正常，存量工具零改动兼容）
  - `toDefinition()` 实测：产出干净 draft-07 形态，无 `$schema` 字段，可直接发 LLM
  - vitest 运行正常，全量 225 项测试零回归

**验收标准**：

- ReadFileTool 内无参数 `as` 断言；非法参数返回 `success: false` 且错误含参数路径
- 业务行为（读取、越界、截断）测试零回归

---

## Task 2：剩余 8 个工具全量迁移

**优先级**：P0
**预估工作量**：中

- [x] 迁移 `ListDirTool` / `SearchByRegexTool` / `WriteFileTool` / `EditFileTool`
- [x] 迁移 `RunCommandTool`（`command` 非空、`timeout_ms` 1-300000 进 schema；trim 空白与 cwd 越界留 `run`；**超上限从截断变为报错**）
- [x] 迁移 `FinishTool`（`summary` 必填非空进 schema；trim 空白留 `run`）
- [x] 迁移 `AskUserTool`（`options` minItems 2 / maxItems 4 进 schema；trim 空白留 `run`；**空数组从「等价省略」变为报错**）
- [x] 迁移 `WebFetchTool`（`url` maxLength 2000、`format` 用 `Type.Enum` 产出 enum 关键字、`timeout_ms` 1-120000 进 schema；URL 解析与协议白名单留 `run`；**超上限从截断变为报错**）
- [x] `run` 从过渡态非 abstract 改为 abstract（base.ts）
- [x] 全量 typecheck 通过

**验收标准**：

- 9 个工具实现内均无参数 `as` 断言（grep 验证为零）
- 各工具业务输出与业务错误文案不变
- 9 个测试失败全部是断言层的预期差异（中文文案 → 结构化英文、截断 → 报错、enum 形态），属 Task 3 迁移范围

---

## Task 3：测试全量迁移

**优先级**：P0
**预估工作量**：中

- [x] `FinishTool.test.ts`：空 / 缺失 summary 断言结构化错误；空白 summary 断言保留 run 层中文文案
- [x] `AskUserTool.test.ts`：options 数量 / 非数组断言结构化错误；空数组用例改写为「报错且不触达回调」（行为收紧）
- [x] `WebFetchTool.test.ts`：缺失 url 断言结构化错误；超时上限用例改写为「超上限报错」+ 新增「上限边界 120000 正常透传」
- [x] `ToolManager.test.ts` 未改动，全绿（对外行为零变化）
- [x] 全量测试 226 项通过（原 225 + 新增 1 项边界用例）

**验收标准**：

- 用例按 spec R4/R5 分工断言：形状错误由 schema 层报、语义错误由 `run` 报
- 无「假通过」：每条断言针对具体错误路径而非仅 `success: false`

---

## Task 4：文档同步

**优先级**：P1
**预估工作量**：小

- [x] `openspec/systems/tool-system.md`：新增/更新「参数契约」章节（schema 唯一事实来源、校验分工边界、错误格式），决策表补 TypeBox 选型条目，变更记录追加
- [x] 勾选本 tasks.md 与 spec.md 验收项

**验收标准**：

- 文档与代码实态一致

---

## 依赖关系

```
Task 1 (基类 + 样板 + 风险关闭)
   └─ Task 2 (全量迁移)
        └─ Task 3 (测试迁移)
             └─ Task 4 (文档)
```

## 提交规划

- 批次 1（feat）：base.ts 改造 + 9 工具迁移 + package.json 依赖（中间态不留断点，一次性提交）
- 批次 2（test）：全部测试迁移
- 批次 3（docs）：change 三件套勾选 + systems/tool-system.md 同步

## 后续立项（不在本期）

- RPC 契约层 schema 化（contracts `ServiceDef` + libs/rpc Router 统一校验）
- electron-main `config.json` 解析校验
