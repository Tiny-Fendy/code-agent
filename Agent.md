# Code Agent

> AI 代码开发助手桌面软件 — 学习实战项目

## 项目简介

这是一个学习性质的 Agent 开发项目，目标是从零搭建一个桌面端代码助手，对标 Claude Code / TRAE Work 的编程核心功能。

- **性质**：学习实战，非商业化产品
- **技术栈**：TypeScript + Vite + Electron + React + Ant Design
- **核心学习目标**：Agent 引擎（ReAct 循环）、工具系统、上下文管理

## 文档

| 文档 | 说明 |
| --- | --- |
| [PRD 需求文档](./docs/prd.html) | 产品需求、功能范围、竞品分析 |
| [技术方案](./docs/tech-design.html) | 架构设计、包结构、技术选型 |

## 项目结构

Monorepo（pnpm workspace），共 5 个内部包：

```
packages/
├── shared/              # 共享类型与常量（所有包共用）
├── agent-core/          # ⭐ Agent 核心引擎（ReAct / 工具 / 上下文 / LLM）
├── electron-main/       # Electron 主进程（窗口 / IPC / 本地服务）
├── electron-preload/    # Preload 安全桥接层
└── web/                 # React 前端（渲染进程）
```

**依赖关系**（箭头表示依赖方向）：

```
web → electron-preload → shared
electron-main → agent-core → shared
```

## 快速开始

### 环境要求

- Node.js >= 18
- pnpm >= 8

### 安装依赖

```bash
pnpm install
```

### 开发模式

```bash
pnpm dev
```

该命令会：
1. 先构建 shared 和 agent-core 包
2. 启动 electron-vite dev（同时启动渲染层 Vite dev server + Electron 主进程）

### 构建

```bash
pnpm build
```

### 类型检查

```bash
pnpm typecheck
```

## 开发路线

- [x] 阶段 0：需求分析 + 技术方案
- [x] 阶段 1：工程搭建（Monorepo 骨架 + Hello World）
- [ ] 阶段 2：对话基础（流式 API 调用 + 聊天 UI）
- [ ] 阶段 3：Agent 引擎（ReAct 循环 + 工具系统）
- [ ] 阶段 4：文件系统工具
- [ ] 阶段 5：终端工具
- [ ] 阶段 6：上下文管理 + 设置面板

## 各包文档

每个包目录下有独立的 `Agent.md`，包含该包的职责、核心模块、开发注意事项：

- [`@code-agent/shared`](./packages/shared/Agent.md)
- [`@code-agent/agent-core`](./packages/agent-core/Agent.md) ⭐ 核心学习包
- [`@code-agent/electron-main`](./packages/electron-main/Agent.md)
- [`@code-agent/electron-preload`](./packages/electron-preload/Agent.md)
- [`@code-agent/web`](./packages/web/Agent.md)

## 开发约定

1. **Agent 核心优先**：agent-core 是学习重点，保持纯 TS，不依赖 UI 或 Electron
2. **类型先行**：跨包通信的类型定义在 shared 中，确保前后端类型一致
3. **安全第一**：preload 层只暴露必要的 API，不直接暴露 Node.js 能力
4. **渐进式开发**：每个阶段有明确的可运行产出，不追求一步到位
5. **禁止中间层 re-export**：除了包入口文件（`index.ts`）做统一对外导出外，包内部模块之间**不做 re-export**，该从哪里引用就从哪里直接引用，避免不必要的间接层
6. **积极创建单元测试用例**：不止要开发功能，还要构建起完善的代码质量防护体系
7. **积极编写注释**：注释不嫌多，切忌只写代码、不写注释。注释颗粒度要细致——不仅要写清"做什么"（功能说明），关键的设计点和改动处还必须写清"为什么"（设计思路与改动原因），让后续阅读者能快速理解代码背后的意图与来龙去脉

## 版本管理原则

1. **Commit message 用中文**：提交说明必须使用中文描述，功能说明要简洁精炼、不写长篇大论，不超过 50 字（英文单词计 1 字，固定术语组合计 1 字，如 `git pull`）
2. **分批提交**：一次提交只承载一类变更，按功能、UI、文档、配置等类别拆分提交，不把无关改动混在一起
3. **禁止强推**：不对已推送的提交执行 `git push --force`，历史修订用新提交解决，保证远程历史可追溯
4. **敏感信息不入库**：`.env`、密钥、token 等一律不提交，只通过 `.gitignore` 之外的方式（本地环境、模板文件）管理
