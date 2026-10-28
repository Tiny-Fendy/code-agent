# 工具系统（ToolManager 与工具生命周期）

> 本文档是工具系统子系统的**持续性设计文档**，随代码演进同步更新。
> 文件工具的原始变更记录见 `openspec/file-tools/`；单次变更走 `openspec/changes/`。

## 1. 定位

工具系统是 Agent 的"手脚"：把 LLM 的 Function Calling 决策转化为对真实环境（文件系统、Shell、网络）的操作。由三部分组成——**接入标准**（工具长什么样）、**调度中心**（ToolManager）、**工具实现**（file/、shell/、web-fetch/、ask-user/、finish/）。

## 2. 职责边界

| 职责 | 归属 | 说明 |
|------|------|------|
| 接入标准定义 | base.ts | Tool 接口 + BaseTool 抽象类（含参数 schema 统一校验入口） |
| 内置工具组装 | ToolManager 构造函数 | 唯一知道"有哪些内置工具"的地方 |
| 自定义工具注册入口 | ToolManager.register / registerAll | 宿主环境注入扩展能力 |
| Schema 导出 / 按名执行 / 确认查询 | ToolManager | 面向 Agent 的三个调度接口 |
| 路径安全 | PathGuard | 校验路径不逃逸出项目根目录 |
| 文件操作公共设施 | FsService | 文件读写等共享逻辑 |
| 工具能力实现 | file/（5 个）、shell/（1 个）、web-fetch/（1 个）、ask-user/（1 个）、finish/（1 个） | 纯能力类，不关心谁注册它 |

## 3. 接入标准（领域知识）

新工具接入只需继承 `BaseTool<typeof 参数schema>` 并声明四项元数据：

| 元数据 | 用途 |
|--------|------|
| name | LLM 调用名（kebab-case，全局唯一） |
| description | 给 LLM 的能力描述 |
| parameters | TypeBox schema——**参数的唯一事实来源**（见下方契约） |
| requiresConfirmation | 是否高危（执行前需用户确认） |

### 参数契约（schema 同源）

每个工具的参数以模块级 TypeBox schema 为唯一事实来源，一份定义三处消费：

- **发给 LLM**：schema 运行时就是 JSON Schema（draft-07 风格），`toDefinition()` 原样透传
- **编译期类型**：`run` 的参数类型写作 `Type.Static<typeof schema>`，与 schema 由同一泛型推出，编译器强制同源
- **运行时校验**：`BaseTool.execute` 统一入口——惰性编译 `Validator` 缓存 → `Check` 快速路径 → 失败时 `Errors` 拼结构化错误（`参数校验失败: /path: message`）回灌 LLM

子类只实现 `protected abstract run(params, context)`，**不得覆写 `execute`**——「run 拿到的参数已校验」由基类保证。

**校验分工**：形状（类型/必填/枚举/范围）一律进 schema；schema 表达不了的语义（trim 后空白、`new URL()` 可解析性、协议白名单、PathGuard 越界、跨字段约束）留在 `run` 内。不做 coercion——LLM 传错形状就报错回灌，让模型自我修正。

BaseTool 统一提供：`toDefinition()` 生成 Function Calling schema、`success()` / `error()` 统一 ToolResult 形态。run 接收 `(params, toolContext)`，toolContext 携带 projectPath 等环境信息。

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
| write_file | 写文件（覆盖/新建，会丢数据） | **是** |
| edit_file | 精确替换编辑 | **是** |
| run_command | Shell 命令执行 | **是** |
| finish | 任务完成时显式结束循环 | 否 |
| ask_user | 请求用户选择或输入（经宿主回调） | 否 |
| web_fetch | 网页/只读接口抓取（format 转 markdown/text/html） | **是** |

## 6. 关键设计决策

| 决策 | 理由 |
|------|------|
| 参数 schema 用 TypeBox 作唯一事实来源 | schema 运行时即 JSON Schema 可直接发 LLM，`Type.Static` 同源推导编译期类型；一份定义消除 schema 与参数类型的双写漂移 |
| 参数校验收敛到 BaseTool.execute，子类只实现 run | 「run 拿到的参数已校验」由基类保证；消除 9 个工具各自的参数 as 断言与重复形状校验 |
| 校验错误保留结构化英文，不做中文翻译层 | 消费者是 LLM（ToolResult 回灌）与开发者日志；结构化英文 + instancePath 更精确、省 token |
| 形状进 schema、语义留 run，不做 coercion | 类型/必填/枚举/范围由 schema 表达；trim 空白、URL 可解析性、PathGuard 越界等语义留 run；LLM 传错形状就报错回灌，让模型自我修正 |
| 工具内置在 agent-core 包内，不抽独立包 | 所有运行环境都有 Node.js；工具是 Agent 的核心能力而非可选插件；避免多一层包间依赖与构建顺序 |
| 注册组装内聚 ToolManager，Agent 零工具依赖 | Agent 只依赖 Tool 抽象；加工具/宿主注入自定义工具均不动 Agent |
| 不用装饰器 / DI 容器做注册 | 规模（个位数工具）不需要自动发现；esbuild 管线会擦除装饰器元数据；显式组装点 > 隐式魔法，与学习项目目标一致 |
| 命令非零退出码作为正常结果返回 | 退出码与输出是 LLM 需要的"观察"，标记为 error 语义不当 |
| Shell 输出上限 + 超时强杀 | 防止单次回灌撑爆上下文（配合 ContextManager 入口截断双保险）、防止命令挂死 |
| 所有文件工具经 PathGuard | 统一安全边界，路径逃逸在工具入口即被拦截 |
| 用户交互能力放 ToolContext，不经 ToolManager | 调度层不承载宿主交互语义；自定义工具注入后同样可用；未注入时工具自行降级为错误观察 |
| HTTP 工具只放行 http/https 且限长 | 挡住 `file:` / `data:` 等本地或异常协议，是网络工具唯一强制边界；校验在 I/O 之前完成 |
| 响应做「字节 + 字符」双层截断 | 5 MiB 字节上限保护内存与带宽，10000 字符上限保护上下文窗口；两级职责不同 |
| 收到 4xx/5xx 仍返回 success | 状态码是 LLM 需要推理的观察，与 run_command 把非零退出码当正常结果同一理由 |
| 门控等待用 `ToolContext.signal` 协作式中断 | 工具自己知道什么资源需要清理；若在 Agent 层硬切 `execute`，会留下孤儿回调与僵尸子进程 |
| web_fetch 只做 GET 且每次确认 | 与 Claude Code / opencode 的「只读抓取 + 权限优先」一致；写请求交给 run_command |

## 7. 已知限制与非目标

- 工具串行执行，无并行调度（Agent 引擎层限制）
- run_command 暂无常驻/后台进程支持（dev server 类命令），后续迭代
- 无工具权限分级、无 per-project 工具开关
- 自定义工具注入入口已就绪，但尚无真实使用场景验证
- ask_user 等待期间监听 `ToolContext.signal`（run 级取消信号，由 Agent 注入），中断返回「用户交互已被中断」；超时仍由宿主回调负责
- 运行中的工具不响应中断：`run_command` 子进程、`web_fetch` 请求只能等自身超时或自然结束（属后续「长任务取消」议题）
- web_fetch 不支持自定义请求头，需要鉴权的地址抓不了；无域名黑白名单、不拦截内网地址；重定向中间跳链不可见
- web_fetch 的图片等二进制内容只回显元信息（ToolResult 无附件通道），且不缓存响应

## 8. 变更记录

| 日期 | 变更 | 关联 change |
|------|------|------------|
| 2026-10-14 | 初版补录：接入标准、组装与调度流程、6 个内置工具、关键设计决策（均已落地） | `openspec/file-tools/`、本会话 shell 工具与组装点重构 |
| 2026-10-14 | PathGuard 修复：项目根在构造时归一化（realpathSync），修复符号链接形式的根路径（如 macOS /var/folders）下全部合法访问被误判为"符号链接指向项目外"的问题；新增工具层单测 `test/tools.test.ts`（29 项） | — |
| 2026-10-16 | finish 工具落地：第 7 个内置工具，LLM 显式调用结束任务循环；`@/` 别名配置统一测试导入路径 | `changes/003-finish-tool/` |
| 2026-10-21 | ask_user 工具落地：第 8 个内置工具，经 `ToolContext.requestUserInput` 向宿主请求用户选择/输入；支持单选、多选、自由文本；未接入能力时降级为错误观察 | `changes/007-ask-user-tool/` |
| 2026-10-23 | web_fetch 工具落地：第 9 个内置工具，Agent 首次具备出网能力；仅 GET、参数 url/format/timeout_ms、format 三档（turndown 转 Markdown）、5 MiB + 10000 字符双层截断、每次调用确认；设计对标 Claude Code `WebFetch` 与 opencode `webfetch` | `changes/008-web-fetch-tool/` |
| 2026-10-24 | 工具参数契约重构：引入 typebox，BaseTool 泛型化（schema 同源 + 校验收敛到 execute），9 个内置工具全量迁移，消除全部参数 as 断言；行为收紧点：run_command/web_fetch 的 timeout_ms 超上限从截断变报错、ask_user 空数组 options 从省略变报错 | `changes/009-tool-schema-typebox/` |
| 2026-10-25 | 门控等待可中断：`ToolContext` 新增可选 `signal`（Agent 每个 run 注入）；ask_user 用该信号协作式中断等待，返回「用户交互已被中断」；运行中工具（run_command / web_fetch）暂不响应中断 | `changes/010-abortable-gates/` |
