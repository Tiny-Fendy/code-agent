# 第二期开发大纲（Phase 2：地基夯实）

## 1. 背景与定位

第一期（Phase 1）已完成主链路闭环：UI 发送消息 → RPC 单通道 → ChatSession → Agent ReAct 循环 → 流式事件回填 UI。大量实现是"能用就行"的临时方案。

第二期不急于堆功能，先把地基打扎实：**先架构，后功能**。功能写得快，但地基不稳会让后续每个功能都背上复杂度。

参考对象：Claude Code、OpenCode。

## 2. 第一期能力基线

| 域 | 已有能力 |
|----|---------|
| Agent 引擎 | ReAct 循环、上下文压缩（80% 阈值 + 摘要）、finish 工具、maxSteps |
| 工具系统 | 文件 ×5（list/read/write/edit/search）、run_command、ask_user、web_fetch；确认门控 |
| LLM | OpenAI 兼容 Provider（fetch-sse-client 流式）、Mock Provider（剧本模式） |
| 会话 | ChatSession 保持（配置/路径快照重建、脏检测）、busy 锁、confirm 桥接 |
| RPC | 契约驱动、单通道 dispatch、三态流终局、serviceName 显式注册 |
| UI | 聊天气泡、工具调用卡片、确认卡片、流式渲染、设置面板、文件树 |
| 质量 | Vitest 全包覆盖（agent-core 226 / electron-main 11 / web 34 / rpc 22 / sse 90） |

## 3. 对标差距（Claude Code / OpenCode）

| 能力 | Claude Code | OpenCode | 本项目 | 归因 |
|------|------------|----------|--------|------|
| Plan / Build 双模式 | ✅ | ✅ | ❌ | 缺工具元数据模型 |
| 权限规则持久化 | ✅ settings.json | ✅ ask/allow/deny | ⚠️ 仅逐次确认 | 缺持久化层 + 规则引擎 |
| 会话持久化 / 历史 | ✅ | ✅ | ❌ | 缺持久化层 |
| TodoWrite 任务清单 | ✅ | ✅ | ❌ | 功能层，依赖持久化 |
| Subagent（Task） | ✅ | ✅ | ❌ | 第三期 |
| Slash commands | ✅ | ✅ | ❌ | 第三期 |
| LSP 诊断回流 | — | ✅ | ❌ | 第三期 |
| MCP 客户端 | ✅ | ✅ | ❌ | 第三期 |
| 错误分类与重试 | 内建 | 内建 | ⚠️ 全部 llmFailed | 引擎健壮性 |
| Abort 信号链 | 内建 | 内建 | ⚠️ 只置标志不打断网络 | 引擎健壮性 |

## 4. 方向决策

第二期主线 = **四大地基任务（A→B→C→D）+ 测试基建穿插**。
功能层只在地基就绪后落地对应部分，不提前写。

```
A. 持久化基础设施
   └─→ 解锁：会话持久化 / 权限规则 / TodoWrite / UI 偏好

B. Agent 引擎健壮性
   └─→ 解锁：流式交互可靠性、长任务稳定性、多会话前提

C. 工具元数据与安全模型
   └─→ 解锁：Plan/Build 双模式（白名单）、权限规则匹配

D. 权限引擎（规则模型）
   └─→ 解锁：权限规则 UI（allow once / always / deny）
```

测试基建（e2e 全链路、LLM mock server）穿插在 A/B/C/D 中，不单独占阶段。

---

## 5. 地基任务卡

> 每个任务的详细规格后续在对应包的 `openspec/changes/NNN-xxx/` 中产出，此处只定边界与验收。

### A. 持久化基础设施

**包**：`packages/electron-main`（存储归主进程所有）

**目标**：统一所有"写盘"行为的抽象，后续功能不再各自手写 JSON 读写。

**范围**：
- `JsonFileStore` 抽象：读 / 写 / 原子写入（tmp + rename）/ 损坏恢复（.bak 回滚）
- Schema 版本化：`version` 字段 + migration 链（v1 → v2 顺序执行）
- 数据分区规划：
  - `config.json` —— 应用配置（现有，迁入新抽象）
  - `permissions.json` —— 权限规则（D 阶段用）
  - `sessions/<sessionId>.jsonl` —— 会话流水（第二期功能用）
- `ConfigServiceImpl` 重构到新抽象之上（行为不变）

**验收**：模拟断电写入（进程崩溃）不丢已确认数据；损坏文件自动从 .bak 恢复；migration 链有单测覆盖。

### B. Agent 引擎健壮性

**包**：`packages/agent-core`

**目标**：修掉已知的 P1/P2 缺陷，把"流式 + 取消 + 重试"做成可靠能力。

**范围**：
- **AbortController 全链路**：Agent 持有 abort signal → 透传 OpenAICompatibleProvider → SSEClient（已支持 signal）。修掉第一期遗留的 busy 残余窗口（abort 后需等下一个 chunk 才释放锁）
- **LLM 错误分类与重试**：429 / 5xx / 网络错误可重试（指数退避 + 次数上限），4xx 业务错误直接失败；错误事件携带 `retryable` 语义
- **Session 生命周期显式状态机**：`idle / running / awaiting_confirm / aborting` 合法转移表，替代现在 busy 布尔 + confirm 表的散状管理
- **工具结果大小统一管控**：截断策略收口（目前分散在 ContextManager 与工具自身）

**验收**：abort 后 busy 立即释放（<100ms）；429 自动重试且 UI 可见重试过程；状态机非法转移抛错。

### C. 工具元数据与安全模型

**包**：`packages/agent-core`

**目标**：给每个工具打上结构化元数据，供 Plan 模式白名单与权限规则匹配消费。

**范围**：
- 009 typebox schema 迁移收尾（在途）
- 工具元数据模型：`readOnly / destructive / network / requiresConfirmation / paramPatterns`
- `run_command` 安全边界：工作目录约束（PathGuard 风格）、危险命令模式清单（rm -rf / sudo / > 系统路径等）
- 白名单生成器：按模式（plan / build）输出工具子集

**验收**：每个工具声明完整元数据；plan 模式下只读工具可用、写工具在列表中不可见（而非仅靠提示词约束）。

### D. 权限引擎（规则模型）

**包**：`packages/electron-main` + `packages/contracts`

**目标**：把"每次确认"升级为"规则匹配"，参考 Claude Code 的权限模型。

**范围**：
- 规则 DSL：`<tool>(<paramPattern>)` 形式（如 `edit_file(**)`、`run_command(git *)`）
- 三级决策：`deny > ask > allow`，规则自上而下匹配
- 规则持久化到 `permissions.json`（依赖 A）
- 决策点接入 ChatSession 的 confirm 路由：先查规则引擎，命中 allow/deny 直接短路，否则才弹 UI 确认
- "总是允许"在 UI 确认卡片上落规则（功能层入口，本阶段只做引擎与数据模型）

**验收**：规则命中后不再弹确认；deny 规则直接返回拒绝结果；规则写入后可持久化并在重启后生效。

---

## 6. 测试基建（穿插）

| 项 | 归属 | 说明 |
|----|------|------|
| e2e 全链路用例 | `packages/electron-main` | mock transport 跑 RPC → ChatSession → Agent 串通，覆盖 send / confirm / abort / busy |
| LLM mock HTTP server | `packages/agent-core/test` | 真实 HTTP 层 mock（当前只注入 fetchImpl），验证协议兼容性 |
| 存储层故障注入 | electron-main A 任务 | 模拟崩溃 / 损坏 / 并发写 |

---

## 7. 功能层清单（地基就绪后按序落地）

| 功能 | 依赖地基 | 包 |
|------|---------|----|
| 会话持久化 + 历史列表 | A | electron-main + web |
| 权限规则 UI（"总是允许"落规则、规则管理页） | A + D | electron-main + web |
| Plan / Build 双模式 | C | agent-core + web + contracts |
| TodoWrite 任务清单 | A | agent-core + web |

---

## 8. 明确不做（第三期候选）

Subagent / Task 工具、MCP 客户端、LSP 诊断回流、Slash commands、Hooks、Git 集成（/commit /pr）、多会话 Tab、worktree 并行。

---

## 9. 推进方式

1. 每个地基任务先在其归属包的 `openspec/changes/` 下产出 **spec + design + tasks**（编号续各包现状）
2. 设计评审通过后再写代码
3. 单任务完成后立即同步对应 `openspec/systems/` 持久化设计文档
4. 全程 Vitest，测试按功能设计编写，不对着代码反推
