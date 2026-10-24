# 对话会话保持与工具确认门控 - 任务拆解 (tasks.md)

> 设计依据：[design.md](./design.md) D1–D10。
> 范围仅 `packages/electron-main`；契约、rpc、agent-core、web 零改动。
> **状态（2026-10-24）**：Task 1–5 已完成；Task 6 自动化验证通过，Electron 手测待执行。

## 开发顺序

先落纯逻辑会话层，再改 RPC 适配，最后补测试与文档——保证每一步可独立验证。

---

## Task 1：electron-main 接入 Vitest ✅

- [x] `package.json`：`test` 脚本改为 `vitest run`，devDependencies 增加 `vitest`（移除仅供旧测试脚本使用的 `tsx`）
- [x] 新增 `vitest.config.ts`：`include: ['test/**/*.test.ts']`
- [x] 新增 `test/tsconfig.json`：沿用 agent-core 写法（extends 父配置、`noEmit`、include test + src）
- [x] 验证：`pnpm --filter @code-agent/electron-main test` 可运行

**依赖**：无（后续任务的测试基础设施）

---

## Task 2：新增 `ChatSession` ✅

文件：`src/rpc/services/ChatSession.ts`

- [x] 状态字段：`agent` / `configKey` / `projectPath` / `busy` / `dirty` / `pendingConfirms` / `openToolCalls`
- [x] `start(message)`：同步 busy 检查与置位 → 判定重建（dirty / 配置 / 路径）→ 返回包装生成器
- [x] 包装生成器：逐帧转发 + 跟踪 `message_complete` / `tool_call_result` + `finally` 统一清理
- [x] `confirm(toolCallId, ok)`：first-wins，未命中 warn 忽略
- [x] `abort()`：`agent.abort()` + settle 全部待决确认（false）
- [x] `onConfirm` 回调：登记 Promise 至待决表
- [x] 日志：重建原因、确认等待/结果、脏标记、异常决议均落 logger
- [x] Agent 工厂以构造参数注入（生产由 ChatServiceImpl 提供，仅单测替换）

**依赖**：无

---

## Task 3：`ChatServiceImpl` 适配 ✅

- [x] 构造 `ChatSession`（复用现有 `config` / `workspace` / `logger`）
- [x] `send()`：`session.start()` → `createRpcStream()` → `onAbort(() => session.abort())`
- [x] 捕获 `ChatSessionBusyError` → 返回立即失败流，业务码 `chat.BUSY`
- [x] `confirmTool(toolCallId, ok)` → `session.confirm(...)`，删除空实现与过期注释
- [x] 明确注释：取消链路、确认链路、忙锁

**依赖**：Task 2

---

## Task 4：单元测试 ✅

文件：`test/rpc/services/ChatSession.test.ts`（11 个用例）

- [x] 伪 Agent 工厂：可控异步生成器 + `abort` spy
- [x] 覆盖 [design.md §8](./design.md) 场景：
  复用 / 配置重建 / 路径重建 / 脏重建 / 完整闭环不重建 / busy / 确认放行 / 确认拒绝 /
  未知与重复决议 / abort 清理 / 返回值透传

**依赖**：Task 1、Task 2

---

## Task 5：文档同步 ✅

- [x] `openspec/systems/rpc-communication.md` §5 补充：会话保持、确认门控、忙锁错误码
- [x] 不新建「对话会话」子系统文档（体量不足以独立成篇，并入 rpc-communication §5）

**依赖**：Task 3（以最终实现为准）

---

## Task 6：全量验证

- [x] `pnpm --filter @code-agent/electron-main typecheck`
- [x] `pnpm --filter @code-agent/electron-main test`
- [x] `pnpm --filter @code-agent/electron-main build`
- [ ] Electron 手测：
  - [ ] 两轮对话，第二轮引用第一轮内容
  - [ ] 写文件触发确认卡片；拒绝后文件未变，对话继续
  - [ ] 确认等待中停止 → 无悬挂、可继续新对话
  - [ ] 流未结束时重复发送 → 提示忙碌（`chat.BUSY`）
  - [ ] 切换模型配置后新对话从新上下文开始

**依赖**：Task 1–3

---

## 交付边界

- 不改 web：UI 侧确认卡片、`confirmTool` 调用、错误展示均已就绪
- 不改契约：`chat.confirmTool` 签名与 `tool_call_confirm` 事件形态不变
- 不实现 `ask_user`（另立变更）
- 分批提交建议：`test` 基础设施 / `feat` 会话与确认 / `docs` 同步，各自独立成提交
