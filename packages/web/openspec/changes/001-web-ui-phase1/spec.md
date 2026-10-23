# Web UI 第一期（纯 UI 部分） - 需求规格 (spec.md)

## 1. 背景

`@code-agent/web` 是桌面应用的渲染进程 UI（React 18 + Antd 5 + Zustand）。PRD 第一期规划了六大模块：三栏布局、对话系统、项目上下文、文件操作、终端、设置。

当前主进程仅有 config / chat / file 三个 RPC 服务，**没有 terminal 服务**，终端面板的契约与主进程实现均不存在。因此本轮范围收敛为**纯 UI 部分**，终端面板推迟到 terminal 服务落地后单独实现（布局上预留位置即可）。

---

## 2. 目标

- 完成三栏布局骨架：顶栏（模型信息 + 设置入口）、左侧文件树、中间对话区、底部终端预留位
- 对话区完整化：消息列表、三态视觉（用户 / 助手 / 工具）、工具调用卡片、工具确认流、停止 / 重试、自动滚动、Markdown 渲染
- 文件树：目录浏览 + 文件点击预览
- 设置面板：AppConfig 5 字段表单 + 连接测试
- 全程可在纯浏览器 mock 模式下调试验证（不启动 Electron）

---

## 3. 非目标（本轮不做）

| 项 | 原因 |
|----|------|
| 终端面板 | 主进程无 terminal 服务，无契约可对接；仅布局预留位置 |
| 文件写入 / 编辑 | 契约只有 readFile，无写接口 |
| 会话持久化 / 多会话 | 第一期 PRD 未要求，chat.send 无会话 id 参数 |
| Electron 真机联调 | 主进程 chat/file 实现进度独立，本轮以 mock 验收 |

---

## 4. 详细需求

### 4.1 三栏布局骨架

- 顶栏：应用标识、Mock/Electron 环境标签、当前模型名（来自 config.get）、设置按钮
- 左栏：文件树面板（宽度约 260px，可后续调整），本轮先渲染骨架与占位
- 中栏：对话区，占满剩余宽度
- 底部：终端预留位（本轮不渲染内容，仅保留布局位置概念）

### 4.2 对话区

**消息列表**：
- 用户消息右对齐气泡；助手消息左对齐
- 助手消息支持 Markdown 渲染（代码块语法高亮）
- 工具调用以卡片形式穿插展示：工具名、参数摘要、执行状态（执行中 / 成功 / 失败）、结果摘要

**流式输出**：
- text_delta 增量追加，不等待完整回复
- 默认自动滚动到底部；用户上滑查看历史时暂停自动滚动，出现「回到底部」按钮

**工具确认流**：
- 收到 tool_call_confirm 事件时，UI 呈现确认卡片（Modal 或内联按钮）
- 用户选择后调用 rpc.chat.confirmTool(toolCallId, ok)，确认期间该轮处于挂起态

**停止 / 重试**：
- 流式进行中：发送按钮变为停止按钮，调用 stream.abort()
- 终局失败（llmFailed / maxSteps / failed）：消息区呈现失败态并提供「重试」（重发上一条用户消息）

### 4.3 文件树

- 打开项目：按钮触发 rpc.file.openFolderDialog，成功后加载树
- 树数据：rpc.file.getFileTree(projectPath)，目录可展开 / 折叠
- 点击文件：rpc.file.readFile 读取内容，在中栏或抽屉预览（只读）

### 4.4 设置面板

- 表单字段对齐 AppConfig：baseUrl / apiKey / model / temperature / maxTokens
- 打开时 rpc.config.get 回填；保存调 rpc.config.set
- 「测试连接」按钮调 rpc.config.testConnection，展示 ok / error

### 4.5 架构与分层（对齐 Agent.md 编码风格）

- 轻量 DDD 三层，依赖单向：presentation → domain ← infrastructure
- presentation/：components、store（Zustand）、hooks、styles
- domain/：事件归并（AgentEvent → 消息模型）、会话状态机等纯 TS 逻辑，可独立单测
- infrastructure/：bridge（现有 src/bridge 迁入）

### 4.6 mock transport 增强（支撑纯浏览器验收）

- 模拟 tool_call_start / tool_call_result / tool_call_confirm 事件序列与 confirmTool 挂起
- 假文件树 / 假文件内容；openFolderDialog 返回假路径
- 触发方式约定（如 /fail 前缀触发失败流）

---

## 5. 验收标准

1. `pnpm --filter @code-agent/web typecheck` 通过
2. `pnpm --filter @code-agent/web dev` 纯浏览器模式下：
   - 三栏骨架渲染正确，顶栏显示 mock 模式与模型名
   - 对话：发送消息可见流式输出、工具卡片、确认流可操作、停止 / 重试可用
   - 文件树：可打开假项目、展开目录、点击文件看到假内容
   - 设置：可读取 / 保存 / 测试连接
