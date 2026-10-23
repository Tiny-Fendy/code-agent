# @code-agent/web

> React 前端 — 渲染进程 UI

## 职责

- 对话界面（消息展示、输入框、流式输出）
- 文件树面板
- 终端面板
- 设置页面
- 状态管理（Zustand）
- 通过 bridge 层与主进程通信

## 目录结构

```
src/
├── main.tsx                 # 入口
├── App.tsx                  # 根组件（三栏布局骨架，薄组件只做编排）
├── domain/                  # 领域层：实体 / 领域服务 / 端口（纯 TS，可独立单测）
│   ├── conversation/        # 对话领域
│   │   ├── message.ts       # UI 消息模型（UIMessage / UIToolCall / 会话状态）
│   │   ├── eventMerger.ts   # AgentEvent 流 → 对话状态归并（纯函数）
│   │   └── index.ts
│   ├── file/                # 文件领域
│   │   └── tree.ts          # FileNode → antd Tree、basename、语言/围栏推导
│   └── config/              # 配置领域
│       └── settings.ts      # 设置表单值 ↔ AppConfig 映射（纯函数）
├── presentation/            # 表现层
│   ├── components/          # UI 组件（薄组件：只渲染 + 转接交互）
│   │   ├── Chat/            # 对话区域
│   │   │   ├── ChatArea.tsx     # 布局编排：消息列表 + 输入区
│   │   │   ├── MessageList.tsx  # 消息列表 + 自动滚动接线
│   │   │   ├── MessageItem.tsx  # 单条消息（用户气泡 / Markdown / 错误态 + 重试）
│   │   │   ├── ToolCallCard.tsx # 工具调用卡片（状态 + 确认按钮 + 结果）
│   │   │   ├── Markdown.tsx     # Markdown 渲染（GFM + 代码高亮）
│   │   │   └── ChatInput.tsx    # 输入区（Enter 发送 / 停止）
│   │   ├── FileTree/        # 文件树
│   │   │   ├── FileTreePanel.tsx    # 树渲染 + 打开项目/刷新
│   │   │   └── FilePreviewDrawer.tsx # 只读文件预览抽屉
│   │   ├── Terminal/        # 终端面板
│   │   ├── Settings/        # 设置面板
│   │   │   └── SettingsModal.tsx # 5 字段配置表单 + 连接测试（开关状态在 settingsStore）
│   │   ├── TopBar/          # 顶栏（环境标签 / 项目名 / 模型名 / 设置入口）
│   │   └── common/          # 通用组件
│   ├── store/               # Zustand stores（对话 / 项目 / 设置）
│   │   ├── chatStore.ts
│   │   ├── projectStore.ts
│   │   └── settingsStore.ts
│   ├── hooks/               # 自定义 hooks（副作用接线）
│   │   ├── useChatStream.ts   # 流订阅 / 停止 / 工具确认 / 重试
│   │   ├── useAutoScroll.ts   # 自动滚动 + 上滑暂停
│   │   └── useProjectActions.ts # 打开目录 / 刷新树 / 预览文件
│   └── styles/
│       └── global.css       # 全局样式与布局骨架
└── infrastructure/          # 基础设施层
    └── bridge/              # RPC 客户端层
        ├── index.ts         # 环境检测 + 导出类型化 rpc 客户端
        ├── mock.ts          # 纯 Web 调试用的 mock Transport
        └── global.d.ts      # window.transport 全局类型声明
```

> 注：RPC 客户端 Proxy、RpcStream 句柄的实现位于 `libs/rpc`（@code-agent/rpc），bridge 层只做组装与环境选择。

## Bridge 层设计

为了支持**纯 Web 环境独立调试 UI**，桥接层封装了类型化 RPC 客户端：

- **Electron 环境**：使用 `window.transport`（preload 暴露的哑管道）
- **纯 Web 环境**：使用 mock Transport（模拟主进程信封协议与流帧推送）

使用方式：

```typescript
import rpc from '@/bridge';

// 普通方法：Promise + 失败抛 RpcError
const config = await rpc.config.get();

// 流式方法：同步拿到事件句柄
const stream = rpc.chat.send('你好');
stream.on('text_delta', (data) => console.log(data.delta));
// 终局三态收口：completed（含 SendResult）/ failed / aborted
stream.onEnd((end) => { if (end.status === 'failed') console.error(end.error); });
stream.abort(); // 取消 → onEnd 收到 { status: 'aborted' }
```

好处：
- 开发 UI 时不需要启动 Electron，浏览器里直接调
- HMR 更快
- 方便写 UI 组件的 demo

mock 发送口令（纯浏览器调试用）：
- 默认：回显消息 + 流式文本
- `/fail ...`：业务失败终局（llmFailed），用于验证失败态与重试
- `/tool ...`：工具确认流（tool_call_start → tool_call_confirm 挂起 → confirmTool 决议后继续）

> 注：web 侧的 mock Transport 为自实现（`infrastructure/bridge/mock.ts`），因为确认流需要「挂起 → 外部决议 → 恢复」的时序，通用 mock 框架的静态脚本无法表达。

## 技术栈

- **框架**：React 18 + TypeScript
- **组件库**：Ant Design 5
- **图标**：@ant-design/icons
- **状态管理**：Zustand
- **构建**：Vite（Electron 环境下由 electron-vite 接管）

## 开发约定

1. **UI 不直接依赖 IPC**：所有与主进程的通信都通过 bridge 层
2. **状态集中管理**：跨组件共享的状态放 Zustand，组件内部状态用 useState
3. **流式渲染**：对话消息支持流式追加，不要等完整回复再渲染
4. **文档分层**：`openspec/changes/` 放单次需求文档；`openspec/systems/` 放核心子系统的方案设计文档（面向特性设计，非代码细节）：bridge 消费层、聊天 UI——长期维护、随设计演进持续更新（规范见根 Agent.md）

## 编码风格

核心原则：**重 TS 层、轻 UI 层** —— 逻辑尽量下沉到 TS 层，组件保持「薄」。

- **薄组件、厚逻辑**：组件只做两件事——渲染 UI、把交互事件转接给逻辑层。业务规则、数据加工、副作用编排一律写在 store / hook 里，组件文件中不出现大段过程式逻辑。
- **积极拆分**：组件只承担单一职责，体量膨胀或出现第二职责时立即拆分——界面拆子组件，可复用或复杂的逻辑（流订阅、事件绑定、滚动策略等）抽成自定义 hook。宁多一个文件，不堆一个大组件。
- **轻量级 DDD 分层**：代码按「表现层 / 领域层 / 基础设施层」组织，依赖方向单向：表现层 → 领域层 ← 基础设施层。领域层不依赖任何上层；基础设施层通过实现领域层定义的端口（接口）被使用（依赖倒置）。
  - **表现层（presentation/）**：`components/`、`store/`、`hooks/`、静态资源与样式。只负责渲染、交互与状态编排，不含业务规则；带业务语义的状态流转交给领域层。
  - **领域层（domain/）**：业务核心——实体、值对象、领域服务与端口定义。纯 TS，不依赖 React / DOM / Electron，可独立单测。如：Agent 事件流 → 消息模型的归并、会话状态机、diff 计算。
  - **基础设施层（infrastructure/）**：与外部世界的对接——`bridge/`（主进程 RPC 通信、mock transport）、本地持久化、环境检测。实现领域层定义的端口，为上层提供能力。
- **积极注释**：文件头写职责概述；导出的函数、hook、store action 写清意图与边界；优先解释「为什么这么写」，其次才是「做了什么」；复杂状态流转（如 Agent 事件 → UI 状态的映射）必须配注释。

## 运行

### 纯 Web 模式（UI 调试）

```bash
pnpm --filter @code-agent/web dev
```

### Electron 模式（完整应用）

在根目录运行：

```bash
pnpm dev
```

## 依赖

- `@code-agent/contracts` — 共享类型与服务契约
- `@code-agent/rpc` — RPC 通信机制（renderer 客户端 / mock 框架）
