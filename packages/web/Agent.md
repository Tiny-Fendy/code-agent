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
├── main.tsx           # 入口
├── App.tsx            # 根组件
├── components/        # UI 组件
│   ├── Chat/          # 对话区域
│   ├── FileTree/      # 文件树
│   ├── Terminal/      # 终端面板
│   ├── Settings/      # 设置面板
│   └── common/        # 通用组件
├── store/             # Zustand stores
│   ├── chatStore.ts
│   ├── projectStore.ts
│   └── settingsStore.ts
├── hooks/             # 自定义 hooks
├── utils/             # 工具函数
├── bridge/            # RPC 客户端层
│   ├── index.ts       # 环境检测 + 导出类型化 rpc 客户端
│   ├── client.ts      # 双层 Proxy 客户端（service + method 运行时拼装）
│   ├── stream.ts      # RpcStreamImpl 流句柄（on/once/onEnd/abort）
│   ├── mock.ts        # 纯 Web 调试用的 mock Transport
│   └── global.d.ts    # window.transport 全局类型声明
└── styles/
    └── global.css     # 全局样式
```

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
stream.onEnd((err) => {/* err?.code === 'ABORTED' 表示取消 */});
stream.abort(); // 取消
```

好处：
- 开发 UI 时不需要启动 Electron，浏览器里直接调
- HMR 更快
- 方便写 UI 组件的 demo

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
4. **组件粒度适中**：不过度拆分，也不让单个组件太大

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

- `@code-agent/shared` — 共享类型
