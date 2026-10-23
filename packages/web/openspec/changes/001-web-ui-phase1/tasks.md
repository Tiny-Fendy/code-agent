# Web UI 第一期（纯 UI 部分） - 任务拆解 (tasks.md)

按四个阶段推进，每个阶段完成后在纯浏览器 mock 模式可独立验证，阶段间向用户确认。

---

## 阶段 ①：目录迁移 + 状态层 + 三栏骨架

- [ ] `src/bridge` → `src/infrastructure/bridge`（index / client / stream / mock / global.d.ts）
- [ ] `src/styles` → `src/presentation/styles`
- [ ] 建立 `src/domain/` 目录（本阶段先落事件归并骨架）
- [ ] 三个 Zustand store：chatStore / projectStore / settingsStore
- [ ] 重写 App.tsx：去掉冒烟页，改为三栏布局骨架
  - 顶栏：Logo、环境标签、模型名、设置入口
  - 左栏：文件树占位
  - 中栏：对话区占位
  - 底部：终端预留位（不渲染内容）
- [ ] 更新根 Agent.md 与文档中的路径引用

**验收**：typecheck 通过；浏览器打开可见三栏骨架，模型名正常读取。

---

## 阶段 ②：对话区完整化

- [x] domain：AgentEvent → 消息模型归并（text_delta 追加、tool_call 生命周期、message_complete 收口）
- [x] domain：会话状态机（idle / streaming / awaiting_confirm）
- [x] domain：Vitest 单测覆盖 7 种事件 + 3 类终局 + 确认决议（16 个用例）
- [x] 新增依赖：react-markdown + remark-gfm + rehype-highlight + highlight.js
- [x] 组件：MessageList / MessageItem（三态气泡）/ ToolCallCard（工具卡片）/ ChatInput
- [x] 组件：工具确认卡片（tool_call_confirm → confirmTool）
- [x] hook：useChatStream（流订阅、事件归并接线、abort / retry；流句柄模块级共享）
- [x] 自动滚动：滚动容器监听 + 上滑暂停 + 回到底部按钮
- [x] mock：支持 `/fail`（业务失败终局）与 `/tool`（确认流挂起-恢复）

**验收**：已通过浏览器验证 —— 普通流式对话、`/fail` 失败态与重试、`/tool` 工具卡片→允许→结果、停止中断（显示「已停止」）、自动滚动与回到底部按钮均正常。

---

## 阶段 ③：文件树 + 文件预览

- [x] mock：假文件树（多层目录）、假文件内容（6 个文件）、openFolderDialog 返回假路径
- [x] mock：chat.send 推 tool_call_start / tool_call_result / tool_call_confirm 序列，confirmTool 挂起模拟（阶段②已完成）
- [x] domain：FileNode → antd Tree 数据转换、路径取名、语言推断、代码围栏构造（13 个单测）
- [x] projectStore：projectPath / fileTree / activeFile / 预览加载与错误状态
- [x] hook：useProjectActions（打开目录 / 刷新 / 预览，统一错误提示）
- [x] 组件：FileTreePanel（antd Tree + 打开项目 + 刷新）
- [x] 文件预览：点击文件 → readFile → 右侧抽屉只读预览（语法高亮）
- [x] 顶栏展示当前项目名

**验收**：已通过浏览器验证 —— 打开假项目后树正确渲染（src 默认展开）、点击 index.ts 抽屉打开并出现 `hljs language-typescript` 高亮、顶栏显示「项目：demo」、控制台无 error。

---

## 阶段 ④：设置面板

- [ ] 组件：SettingsModal（5 字段表单）
- [ ] settingsStore：读取回填、保存、测试连接状态
- [ ] 顶栏设置入口接线

**验收**：mock 模式下打开设置、回填、保存后顶栏模型名同步更新。
