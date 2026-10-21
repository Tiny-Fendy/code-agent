# 工具系统（ToolManager 与工具生命周期）

> 本文档是工具系统子系统的**持续性设计文档**，随代码演进同步更新。
> 文件工具的原始变更记录见 `openspec/file-tools/`；单次变更走 `openspec/changes/`。

## 1. 定位

工具系统是 Agent 的"手脚"：把 LLM 的 Function Calling 决策转化为对真实环境（文件系统、Shell）的操作。由三部分组成——**接入标准**（工具长什么样）、**调度中心**（ToolManager）、**工具实现**（file/、shell/）。

## 2. 职责边界

| 职责 | 归属 | 说明 |
|------|------|------|
| 接入标准定义 | base.ts | Tool 接口 + BaseTool 抽象类 |
| 内置工具组装 | ToolManager 构造函数 | 唯一知道"有哪些内置工具"的地方 |
| 自定义工具注册入口 | ToolManager.register / registerAll | 宿主环境注入扩展能力 |
| Schema 导出 / 按名执行 / 确认查询 | ToolManager | 面向 Agent 的三个调度接口 |
| 路径安全 | PathGuard | 校验路径不逃逸出项目根目录 |
| 文件操作公共设施 | FsService | 文件读写等共享逻辑 |
| 工具能力实现 | file/（5 个）、shell/（1 个） | 纯能力类，不关心谁注册它 |

## 3. 接入标准（领域知识）

新工具接入只需继承 BaseTool 并声明四项元数据：

| 元数据 | 用途 |
|--------|------|
| name | LLM 调用名（kebab-case，全局唯一） |
| description | 给 LLM 的能力描述 |
| parameters | JSON Schema 参数定义 |
| requiresConfirmation | 是否高危（执行前需用户确认） |

BaseTool 统一提供：`toDefinition()` 生成 Function Calling schema、`success()` / `error()` 统一 ToolResult 形态。工具的 execute 接收 `(args, toolContext)`，toolContext 携带 projectPath 等环境信息。

**新增内置工具的流程：写工具类 → ToolManager 组装点加一行。Agent 永远不用改。**

## 4. 调度流程

```
Agent.callLLM() ←— ToolManager.getDefinitions()   # schema 列表随请求发给 LLM
LLM 返回 tool_call
Agent：requiresConfirmation(name)？→ 确认流（见 Agent 引擎文档）
Agent：execute(name, args, toolContext)             # 按名查找并执行
Agent：把 ToolResult 以 role='tool' 消息回灌上下文
```

## 5. 内置工具清单

| 工具 | 能力 | 确认 |
|------|------|------|
| list_dir | 目录树浏览 | 否 |
| read_file | 读文件（行号格式，支持分页） | 否 |
| search_by_regex | 正则内容搜索 | 否 |
| write_file | 写文件（覆盖） | 否 |
| edit_file | 精确替换编辑 | 否 |
| run_command | Shell 命令执行 | **是** |
| finish | 任务完成时显式结束循环 | 否 |
| ask_user | 请求用户选择或输入（经宿主回调） | 否 |

## 6. 关键设计决策

| 决策 | 理由 |
|------|------|
| 工具内置在 agent-core 包内，不抽独立包 | 所有运行环境都有 Node.js；工具是 Agent 的核心能力而非可选插件；避免多一层包间依赖与构建顺序 |
| 注册组装内聚 ToolManager，Agent 零工具依赖 | Agent 只依赖 Tool 抽象；加工具/宿主注入自定义工具均不动 Agent |
| 不用装饰器 / DI 容器做注册 | 规模（个位数工具）不需要自动发现；esbuild 管线会擦除装饰器元数据；显式组装点 > 隐式魔法，与学习项目目标一致 |
| 命令非零退出码作为正常结果返回 | 退出码与输出是 LLM 需要的"观察"，标记为 error 语义不当 |
| Shell 输出上限 + 超时强杀 | 防止单次回灌撑爆上下文（配合 ContextManager 入口截断双保险）、防止命令挂死 |
| 所有文件工具经 PathGuard | 统一安全边界，路径逃逸在工具入口即被拦截 |
| 用户交互能力放 ToolContext，不经 ToolManager | 调度层不承载宿主交互语义；自定义工具注入后同样可用；未注入时工具自行降级为错误观察 |

## 7. 已知限制与非目标

- 工具串行执行，无并行调度（Agent 引擎层限制）
- run_command 暂无常驻/后台进程支持（dev server 类命令），后续迭代
- 无工具权限分级、无 per-project 工具开关
- 自定义工具注入入口已就绪，但尚无真实使用场景验证
- ask_user 的超时与取消由宿主回调负责；回调不返回时工具调用会保持挂起（与确认流相同）

## 8. 变更记录

| 日期 | 变更 | 关联 change |
|------|------|------------|
| 2026-10-14 | 初版补录：接入标准、组装与调度流程、6 个内置工具、关键设计决策（均已落地） | `openspec/file-tools/`、本会话 shell 工具与组装点重构 |
| 2026-10-14 | PathGuard 修复：项目根在构造时归一化（realpathSync），修复符号链接形式的根路径（如 macOS /var/folders）下全部合法访问被误判为"符号链接指向项目外"的问题；新增工具层单测 `test/tools.test.ts`（29 项） | — |
| 2026-10-16 | finish 工具落地：第 7 个内置工具，LLM 显式调用结束任务循环；`@/` 别名配置统一测试导入路径 | `changes/finish-tool/` |
| 2026-10-21 | ask_user 工具落地：第 8 个内置工具，经 `ToolContext.requestUserInput` 向宿主请求用户选择/输入；支持单选、多选、自由文本；未接入能力时降级为错误观察 | `changes/ask-user-tool/` |
