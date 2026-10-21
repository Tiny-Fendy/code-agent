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

- [ ] domain：AgentEvent → 消息模型归并（text_delta 追加、tool_call 生命周期、message_complete 收口）
- [ ] domain：会话状态机（idle / streaming / awaiting_confirm / aborted / failed / done）
- [ ] 新增依赖：react-markdown + 语法高亮
- [ ] 组件：MessageList / MessageItem（三态气泡）/ ToolCallCard（工具卡片）/ ChatInput
- [ ] 组件：工具确认卡片（tool_call_confirm → confirmTool）
- [ ] hook：useChatStream（流订阅、事件归并接线、abort / retry）
- [ ] 自动滚动：滚动容器监听 + 上滑暂停 + 回到底部按钮

**验收**：mock 模式下完整走通 发送 → 流式 → 工具卡片 → 确认 → 终局；/fail 触发失败态与重试。

---

## 阶段 ③：文件树 + mock 增强

- [ ] mock：假文件树（多层目录）、假文件内容、openFolderDialog 返回假路径
- [ ] mock：chat.send 推 tool_call_start / tool_call_result / tool_call_confirm 序列，confirmTool 挂起模拟
- [ ] 组件：FileTreePanel（antd Tree + 打开项目按钮）
- [ ] 文件预览：点击文件 → readFile → 预览（抽屉或中栏标签页）
- [ ] projectStore：projectPath / fileTree / activeFile 状态

**验收**：mock 模式下打开假项目、展开目录、点击文件看到假内容。

---

## 阶段 ④：设置面板

- [ ] 组件：SettingsModal（5 字段表单）
- [ ] settingsStore：读取回填、保存、测试连接状态
- [ ] 顶栏设置入口接线

**验收**：mock 模式下打开设置、回填、保存后顶栏模型名同步更新。
