# IPC / RPC 通信子系统（应用组装视图）

> 渲染层（web）↔ 主进程（electron-main）的统一通信方案在本应用中的组装与使用。
> 通信机制本身（协议 / Router / 流状态机 / 客户端）已抽离为独立包 `@code-agent/rpc`，
> 机制设计文档见 [libs/rpc/openspec/systems/rpc.md](../../../../libs/rpc/openspec/systems/rpc.md)；
> 本文档只维护应用侧视图：服务清单、装配方式、业务语义接入。

状态：已落地（Unary + Server Streaming v2）。
Phase 1 已完成：机制抽离为独立包 `@code-agent/rpc`，契约包 `shared` → `contracts` 更名同批执行。

---

## 1. 定位与原则

应用侧在机制之上补充两条原则：

| 原则 | 含义 |
| --- | --- |
| 契约单源 | 服务接口只在 `contracts` 定义一次，客户端与服务端靠编译期约束对齐 |
| 安全面最小 | `contextIsolation: true` + `nodeIntegration: false`，渲染层只触达 transport |

机制层原则（哑管道 / 信封化错误 / 机制化生命周期 / 纯逻辑核心）见 rpc 包文档。

---

## 2. 分层结构

```
┌──────────────────────────────────────────────────────────────┐
│ @code-agent/rpc（机制包，零业务概念）                            │
│   protocol.ts  RPC 通道 / 信封 / 流帧 / RpcStream 句柄 / 错误   │
│   main/        RpcRouter + createRpcStream + bindIpc          │
│   preload/     exposeRpcTransport()（哑管道实现）               │
│   renderer/    createRpcClient 双层 Proxy + RpcStreamImpl     │
│   mock/        通用 mock Transport 框架（脚本化业务场景注入）    │
├──────────────────────────────────────────────────────────────┤
│ @code-agent/contracts（业务契约包，纯类型 + 常量）               │
│   rpc/contract.ts  ConfigService / ChatService / FileService  │
│   types/           AgentEvent / SendResult / AppConfig 等 DTO │
└──────────────┬───────────────────────────────┬────────────────┘
               │ 编译期类型约束                  │ 编译期类型约束
┌──────────────▼──────────────┐   ┌────────────▼─────────────────┐
│ electron-main/src/           │   │ web/src/bridge/               │
│   rpc/services/  服务实现     │   │   index.ts  客户端装配入口     │
│   preload/index.ts 传输入口   │   │   mock.ts   业务场景声明      │
│   index.ts       组装与启动   │   │                               │
└──────────────┬──────────────┘   └────────────┬─────────────────┘
               │ ipcMain                        │ window.transport
┌──────────────▼────────────────────────────────▼─────────────────┐
│ electron-main/src/preload/index.ts  一行 exposeRpcTransport()   │
└──────────────────────────────────────────────────────────────────┘
```

关键文件（相对仓库根目录）：

- 机制包：`libs/rpc/src/protocol.ts`、`src/main/`（Router / bindIpc / createRpcStream）、
  `src/preload/`、`src/renderer/`（client / stream）、`src/mock/`
- 服务契约：`packages/contracts/src/rpc/contract.ts`
- 服务端业务实现：`packages/electron-main/src/rpc/services/`
- 传输层：`packages/electron-main/src/preload/index.ts`（仅调用 `exposeRpcTransport()`，构建入口由 electron.vite.config.ts 指向）
- 客户端入口：`packages/web/src/bridge/`（`index.ts` 装配 / `mock.ts` 业务场景）

---

## 3. 服务清单与交互模式

| 服务（契约键） | 模式 | 说明 |
| --- | --- | --- |
| `config.get/set` | Unary | 应用配置读写 |
| `file.*` | Unary | 目录树等文件能力 |
| `chat.send` | Server Streaming | Agent 事件流（机制第一个深接入使用方，见 §5） |

机制支持的全部模式（含未落地的 client-stream / bidi 演进路径）见 rpc 包文档。
远期：terminal 服务接入时复用同一套流标识、终局与取消原语。

---

## 4. 服务注册与启动

主进程 `app.whenReady()`：

1. `new RpcRouter<MainServices>({ serviceKeys: SERVICE_KEYS })`（契约键白名单）
2. `registerServices(router, app.getPath('userData'))`：构造 `ConfigServiceImpl`（先 `load()` 预载配置缓存）/ `ChatServiceImpl` / `FileServiceImpl`，共享 `WorkspaceState`（当前项目路径）；
   `router.registerAll([...])` 数组注册——各实现类的 `serviceName` 字段即注册名，
   由契约接口 `ServiceDef<'config'>` 等显式声明并编译期对齐 `MainServices` 键（机制见 rpc 包文档 §11），
   缺字段或不在白名单即启动 throw；新增服务只写实现类并塞进数组
3. `bindIpc(router)`：注册 `ipcMain.handle`

依赖装配采用 Composition Root：整个主进程只有启动组装函数一个地方允许 `new` 服务，
所有类的依赖只出现在构造函数参数里，不引入 IoC 容器。

---

## 5. 业务失败的表达：Agent 深接入

`chat.send` 使用机制 7.6 节的"结果类型表达业务终局"位置：

- 终局结果 `SendResult = completed | llmFailed | maxSteps | aborted` 自身穷尽业务结局：
  Agent.run 四个退出点各 return 对应结果，LLM 上游失败这类业务失败随 end{completed} 的 result 送达
- AgentEvent 事件流不再含 error / done 结束事件（结束语义只有一处）
- 消费端收口只有一处：`onEnd` 先按协议三态分支，completed 内再按 SendResult 分业务终局

---

## 6. 错误模型应用约定

机制错误结构 `RpcErrorInfo` 与保留码见 rpc 包文档 §8。应用侧约定：

- 业务错误码带服务前缀（如 `chat.LLM_FAILED`），禁止 `RPC_` 前缀
- UI 对 `aborted` 终局静默复位（取消是独立终局态，不是错误）

---

## 7. 客户端与双环境

- 客户端装配入口 `web/src/bridge/index.ts`：创建 `createRpcClient<MainServices>()`，
  流式方法清单用 `satisfies StreamMethodsOf<MainServices>` 与契约绑定（机制见 rpc 包文档 §9）
- 纯浏览器（无 preload）下走 `bridge/mock.ts`：基于 `@code-agent/rpc/mock` 通用框架声明业务场景，
  client 与句柄一行不改跑在浏览器里，UI 可独立调试

---

## 8. 后续变更

- **rpc-communication-v2（Phase 0）✅ 已完成**：Server Streaming 终局机制重写（帧二态 / 终局三态 /
  双形态工厂 / 终局锁）+ 错误结构单源化 + 注册收口；Agent 主流程为第一个使用方（深接入）。
  规格与决策记录：[changes/rpc-communication-v2/](../changes/rpc-communication-v2/spec.md)
- **Phase 1 ✅ 已完成**：RPC 机制抽离为独立 workspace 包 `libs/rpc`（`@code-agent/rpc`，
  protocol / main / preload / renderer / mock 五个 subpath），`packages/shared` → `packages/contracts`
  （`@code-agent/contracts`）更名同批完成；行为零变化，Router 测试随包迁移。
  初版落地于 `packages/` 平级，后与 fetch-sse-client 一并归入 `libs/`（通用基础库目录，与业务包维护解耦）。
- **Phase 2（规划）**：rpc 包独立构建（双格式 + dts）、最小示例工程、版本与 CHANGELOG，具备发 npm 条件。

## 9. 变更记录

- 2026-10：机制设计内容迁出至 [libs/rpc/openspec/systems/rpc.md](../../../../libs/rpc/openspec/systems/rpc.md)，
  本文档瘦身保留应用组装视图（服务清单 / 装配 / 业务语义接入 / 变更历史）。
