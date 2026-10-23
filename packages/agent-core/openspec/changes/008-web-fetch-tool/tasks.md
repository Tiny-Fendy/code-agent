# web_fetch 工具 - 任务清单 (tasks.md)

> 状态：Task 1-3 已实施（2026-10-23）。任务按依赖顺序排列。

## Task 1：WebFetchTool 实现与注册

**优先级**：P0
**预估工作量**：中

- [x] 新建 `packages/agent-core/src/tools/web-fetch/WebFetchTool.ts`
- [x] 新建 `packages/agent-core/src/tools/web-fetch/index.ts` 导出
- [x] 参数校验：URL 协议白名单 + 长度上限、`format` 枚举、`timeout_ms` 正数且上限 120000
- [x] 请求形态：固定 GET、浏览器 UA、`accept` 文档优先、`redirect: 'follow'`
- [x] 响应处理：流式读取 5 MiB 上限、UTF-8 解码、二进制只报元信息
- [x] 内容转换：turndown 转 Markdown、去标签转纯文本、原样 HTML、`<title>` 回显
- [x] 输出格式化：状态行、最终 URL（重定向时）、content-type、标题、内容
- [x] 错误语义：`[invalid]` / `[timeout]` / `[network]`，任何 HTTP 响应均视为成功观察
- [x] 日志：发起 info、完成 info（含 bytes / durationMs / truncated）、失败 warn
- [x] `requiresConfirmation = true`（每次请求前确认）
- [x] `ToolManager.createBuiltinTools` 注册 `new WebFetchTool()`（内置工具 8 → 9）
- [x] 依赖：`turndown`（运行时）+ `@types/turndown`（开发）

**验收标准**：

- 工具不抛异常，非法输入全部以 `success: false` 返回
- `getDefinitions()` 中包含 `web_fetch`
- turndown 在 Node ESM 下可直接使用，无需额外 DOM 依赖

---

## Task 2：单元测试

**优先级**：P0
**预估工作量**：中

- [x] 新建 `packages/agent-core/test/tools/web-fetch/WebFetchTool.test.ts`
  - 元数据：name / `requiresConfirmation=true` / 必填项 / format 枚举 / 仅三个参数
  - URL 边界：空、超 2000 字符、不可解析、`file:` / `ftp:` 被拒
  - format 边界：非法值被拒；markdown / text / html 三态各一条；JSON 不受影响
  - timeout 边界：非正数报错、超上限截断为 120000
  - 请求形态：固定 GET、浏览器 UA、accept、redirect follow、无 body
  - 响应：404 视为成功、204 无内容、二进制只报元信息、重定向回显最终 URL
  - 上限：5 MiB 字节截断、10000 字符内容截断
  - 失败：fetch reject → `[network]`；超时 → `[timeout]`
  - 日志：发起 / 完成 info、失败 warn
- [x] 更新 `packages/agent-core/test/tools/ToolManager.test.ts`：工具名改为 `web_fetch`，计数 9
- [x] 全量测试通过（222 项，原 195 项零回归）

**验收标准**：

- 用例按 spec R2-R11 编写，不按实现倒推
- 全部 stub `globalThis.fetch`，无真实网络请求

---

## Task 3：文档同步

**优先级**：P1
**预估工作量**：小

- [x] `openspec/systems/tool-system.md`：内置工具清单新增 `web_fetch`（9 个）、职责边界补 `web-fetch/`、决策表补只读抓取相关条目、已知限制补鉴权与取消通道
- [x] 勾选本 tasks.md 与 spec.md 验收项
- [x] `tool-system.md` 变更记录追加一行

**验收标准**：

- 文档与代码实态一致

---

## 依赖关系

```
Task 1 (实现 + 注册 + 依赖)
   └─ Task 2 (测试)
        └─ Task 3 (文档)
```

## 提交规划

- 批次 1（feat）：WebFetchTool + index + ToolManager 注册 + package.json/lockfile 依赖
- 批次 2（test）：WebFetchTool 单测 + ToolManager 计数与命名同步
- 批次 3（docs）：change 三件套 + systems/tool-system.md 同步
