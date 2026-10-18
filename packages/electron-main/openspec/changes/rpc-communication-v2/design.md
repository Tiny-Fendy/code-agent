# IPC / RPC 通信方案 v2 — 设计提案 (design.md)

> 状态：**已实现（Phase 0 + Phase 1）**。需求见 [spec.md](./spec.md)。
> v0.2 重新定位：设计对象是渲染层 ↔ 主进程的**整套 IPC 通信方案**；
> Server Streaming（流式）是四种交互模式之一，也是本次唯一动工的模式。
> 决策记录（D1–D16）见文末；实现任务与验收见 [tasks.md](./tasks.md) / [check.md](./check.md)。

## 1. 统一世界观：一次调用 = 建立 → 数据消息 → 唯一终局

所有交互模式共用同一个心智模型：

1. **建立**：渲染层发起 `rpc:invoke { service, method, args }`，机制定位 handler
2. **数据消息**：0..n 条，按调用标识（streamId）多路复用
3. **终局**：**恰好一个**，携带成败与结构化错误 / 结果；终局后释放全部资源

四种模式的区别只是数据消息的**数量与方向**：

| 模式 | 数据消息 | 终局载体 | 状态 |
| --- | --- | --- | --- |
| Unary | 0 条 | invoke 响应信封本身（**一帧即终局**） | ✅ v1 |
| Server Streaming | 主 → 渲染 0..n 条 `next` | 主 → 渲染 1 个 `end` 帧 | ⚠️ v1 → v2 重写 |
| Client Streaming | 渲染 → 主 0..n 条 | 主 → 渲染 1 个响应信封 | 🔲 未来 |
| Bidi Streaming | 双向 0..n 条 | 双向各一个 `end`（细节二期再定） | 🔲 未来 |

这就是"流式是 RPC 的一环"的含义：Sink、终局状态机、取消不是流式专属组件，
而是通信机制**生命周期层**的通用原语，只是恰好在 Server Streaming 模式第一次被需要。
判断一个方法走哪种模式只看契约签名：`Promise<T>` 即 Unary；`RpcStream<E, R>` 即 Server Streaming。

分层结构与文件布局见系统文档第 2 节，本文不重复，只设计协议与两端 API。

## 2. 协议全景

固定三条逻辑通道，新增服务 / 方法 / 交互模式都不加通道：

| 通道 | 方向 | 职责 |
| --- | --- | --- |
| `rpc:invoke` | 渲染 → 主 | 建立一切调用；同时承载 Unary 的终局（响应信封） |
| `rpc:stream` | 主 → 渲染 | Server Streaming 的数据帧与终局帧，按 streamId 复用 |
| `rpc:invoke('__stream', 'cancel', [streamId])` | 渲染 → 主 | 取消信号；机制保留方法，不占业务契约 |

### 2.1 Unary 信封（v1 保留，错误类型单源化）

```typescript
type RpcResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: RpcErrorInfo };
```

### 2.2 Streaming 帧：数据帧 + 终局帧（两态）

```typescript
// 替代 v1 的 next / return / throw 三帧
type StreamFrame<E extends StreamEvent = StreamEvent, R = unknown> =
  | { streamId: string; kind: 'next'; value: E }
  | { streamId: string; kind: 'end'; value: StreamEnd<R> };

type StreamEnd<R> =
  | { status: 'completed'; result: R }
  | { status: 'failed'; error: RpcErrorInfo }
  | { status: 'aborted' };
```

### 2.3 统一错误结构

```typescript
// shared 单源：unary 信封与流终局共用（F22）
interface RpcErrorInfo {
  code: string;          // 业务自定义码为主；机制保留码见第 6 节
  message: string;
  data?: unknown;        // 结构化附加信息，必须可结构化克隆
}
```

- web 侧抛出的异常类仍可叫 `RpcError`（throwable 包装），线上传输的只有 `RpcErrorInfo`
- 每条流**恰好一个** `end` 帧，end 之后机制不再发任何帧（F12/F14）
- failed 是**任务结果**而不是程序异常；handler / 泵崩溃才是异常，由机制兜底成 failed

### 2.4 建立与取消（沿用 v1 链路，语义微调）

- 建立：流式方法 invoke 响应**立即**返回 `{ ok: true, data: { __stream: streamId } }`
  （同步给句柄，订阅先于帧到达），随后在 `rpc:stream` 推帧
- 取消：消费端 `abort()` → 保留方法 `__stream.cancel(streamId)`
  → Router 终结为 `aborted` 并触发 Sink 的 abort 钩子
- aborted 独立成态，不再借用错误码或业务事件表达

## 3. Unary 模式（v2 行为不变）

- Router 统一 catch handler 异常 → `{ ok:false, RPC_HANDLER_ERROR }`，异常不逃逸到 IPC
- web 侧 Proxy 拆信封：`ok:false` 抛 `RpcError`，业务 try/catch 读 code/message
- v2 唯一改动：错误结构与流终局统一为 `RpcErrorInfo`（同形状，行为零变化）

## 4. Server Streaming 模式 v2

### 4.1 双角色

```
主进程（生产端）                              渲染层（消费端）
┌──────────────────────┐   next 帧（0..n）   ┌──────────────────────┐
│ RpcStreamSink<E,R>   │ ───────────────────→ │ RpcStream<E,R>       │
│  emit(event)         │                      │  on(type, cb)        │
│  end(result?)        │ ─── end 帧（恰好1）─→ │  onEnd(result)       │
│  error(err)          │                      │                      │
│  onAbort(cb)         │ ←── __stream.cancel ─ │  abort()             │
└──────────────────────┘                      └──────────────────────┘
```

- **Sink（生产端）**：推模式 API。emit/end/error 都是业务可主动调用的普通方法，覆盖回调驱动源
- **Handle（消费端）**：现 `RpcStream` 的演进，终局从 `(err?) => void` 升级为穷尽三态的判别结构
- **终局**：不是异常、不是业务事件，而是通道状态机的终态，恰好到达一次

业务只负责"什么时候 emit / end / error"，其余由机制保证。

### 4.2 生产端 API

```typescript
interface RpcStreamSink<E extends StreamEvent, R = void> {
  // —— 写侧（核心机制）——
  emit(event: E): boolean;              // 推数据；open 返回 true，终局后返回 false
  end(result?: R): void;                // 正常结束（first-wins，重复调用无效）
  error(error: RpcErrorInfo): void;     // 失败结束（first-wins）
  onAbort(cb: () => void): void;        // 消费端取消钩子
  readonly aborted: boolean;
  readonly closed: boolean;             // 是否已经到达任一终局

  // —— 本地旁路（保留 v1 能力，供日志/测试）——
  on<T>(type: T, cb): () => void;
  onEnd(cb: (result: StreamEnd<R>) => void): () => void;
}
```

### 4.3 两种源接入方式（同一工厂的双形态）

```typescript
// 形态 A：推模式（回调驱动源，如子进程）—— 空参创建，拿到句柄自己写
function createRpcStream<E extends StreamEvent, R = void>(): RpcStreamSink<E, R>;

// 形态 B：拉模式（AsyncGenerator 源，如 Agent）—— 自动泵
function createRpcStream<E extends StreamEvent, R = void>(
  gen: AsyncGenerator<E, R>,
): RpcStreamSink<E, R>;
```

形态 A 示例（未来 terminal 服务的样子）：

```typescript
run(cmd: string) {
  const stream = createRpcStream<TermEvent, { exitCode: number }>();
  const child = spawn(cmd, [], { cwd: this.workspace.projectPath });
  child.stdout.on('data', d => stream.emit({ type: 'stdout', data: d.toString() }));
  child.stderr.on('data', d => stream.emit({ type: 'stderr', data: d.toString() }));
  child.on('close', code => {
    if (stream.aborted) return;                       // 取消终局已锁，不再 end
    code === 0
      ? stream.end({ exitCode: code })
      : stream.error({ code: 'EXIT_NONZERO', message: `进程退出码 ${code}`, data: { exitCode: code } });
  });
  child.on('error', err => stream.error({ code: 'SPAWN_FAILED', message: err.message }));
  stream.onAbort(() => child.kill('SIGTERM'));
  return stream;
}
```

形态 B 的自动映射：`gen.next()` 值 → emit；`return R` → end(R)；`throw` → error(RPC_HANDLER_ERROR)；
消费端 abort → gen.return() 释放 + aborted 终局。

### 4.4 消费端 API

```typescript
interface RpcStream<E extends StreamEvent, R = void> {
  on<T extends E['type']>(
    type: T,
    cb: (data: Extract<E, { type: T }>['data']) => void,
  ): () => void;
  once<T extends E['type']>(type: T, cb): () => void;

  /** 唯一终局入口：判别联合逼出穷尽处理（F9） */
  onEnd(cb: (result: StreamEnd<R>) => void): () => void;

  abort(): void;
}
```

UI 收敛形态（loading 状态只有一个收口）：

```typescript
stream.on('text_delta', d => append(d.delta));
stream.onEnd((end) => {
  setStreaming(false);
  switch (end.status) {
    case 'completed': markDone(end.result); break;
    case 'failed':    showError(`${end.error.code}: ${end.error.message}`); break;
    case 'aborted':   markCancelled(); break;   // 取消不是报错，不弹错误提示
  }
});
```

时序保证沿用 v1：构造即同步订阅 onStream → streamId 绑定前的帧进 buffer 重放
→ 收到 end 帧派发 onEnd、清空事件回调、退订全局监听。

### 4.5 终局状态机

```
                         emit() 有效 / next 帧
              ┌──────────────────────────────┐
              │                              │
        ┌─────▼─────┐  end(result)   ┌───────────────┐
        │           │ ─────────────→ │  completed    │
 创建 → │   open    │  error(err)    ├───────────────┤
        │           │ ─────────────→ │    failed     │ ──→ closed
        └─────┬─────┘                ├───────────────┤
              │  cancel (远端/本地)   │   aborted     │
              └────────────────────→ └───────────────┘
```

机制保证（Router 与两侧句柄共同实现）：

1. 三个终局入口（end / error / cancel）走**同一把锁**：同 tick 内"服务 end"与"远端 cancel"竞争也只产生一个 end 帧
2. 终局后：emit 丢弃（返回 false）；end/error 重复调用 no-op；注册表项删除
3. handler 同步阶段就抛异常（连流都没建起来）：仍走 invoke 信封 `{ ok:false }`；
   流建立之后的一切失败都走 end(failed)，不再回到信封
4. 形态 B 下 gen 意外 throw / 泵自身异常：兜底 end(failed, RPC_HANDLER_ERROR)，流绝不悬挂
5. 消费端句柄收到 end 帧后：派发 onEnd → 清空事件回调 → 退订全局 onStream（v1 清理语义保留）

## 5. 取消模型（跨模式视角）

```
渲染层 stream.abort()
  → transport.invoke('__stream', 'cancel', [streamId])   # 保留方法，不占业务契约
  → Router 终局锁竞争（若已 completed/failed 则 no-op）
  → gen.return() 释放生成器 / 触发 Sink onAbort 钩子
  → end{aborted} 帧 + 注册表清理
  → 渲染层 onEnd({ status:'aborted' })
```

- Unary 没有取消（一帧即终局，调用寿命只有一次 IPC 往返）；取消是**有数据消息阶段**的模式才需要的生命周期操作
- 未来 client-stream / bidi：渲染→主方向的取消沿用 `__stream.cancel` 同一条链路，服务端取消则是反向 end 帧，二期再细化

## 6. 错误模型（跨模式统一）

| 失败类型 | 产生者 | Unary | Streaming v2 |
| --- | --- | --- | --- |
| 服务 / 方法不存在 | Router | 信封 `{ok:false}` | 同左（句柄建立前，走信封） |
| Handler 程序异常 | Router catch | 信封 RPC_HANDLER_ERROR | `end{failed, RPC_HANDLER_ERROR}` |
| 业务失败 | 服务显式表达 | 抛异常 → RPC_HANDLER_ERROR（过粗，v2 不强行改） | `end{failed, {code:业务码,...}}`，有机制级位置 |
| 取消 | 消费端 abort | — | `end{aborted}`（独立态，不是错误） |

机制保留错误码收敛为：`RPC_SERVICE_NOT_FOUND` / `RPC_METHOD_NOT_FOUND` / `RPC_HANDLER_ERROR`
（统一占用 `RPC_*` 保留段，D11）；业务码约定带服务前缀（如 `chat.LLM_FAILED`），不得使用 `RPC_` 前缀。
原 `ABORTED` 从"错误码"变为"终局状态"，不再出现在 error.code 里。
（Unary 业务错误码如何获得机制级位置是另一个独立议题，本次不扩面。）

## 7. 未来模式的演进路径（本次只保证不设障）

- **Client Streaming**：新增渲染→主方向的数据帧（新帧 kind 或复用 `rpc:stream` 双向化，D8 决策），
  终局仍是主→渲染的唯一信封；streamId 在建立时由 invoke 响应分配，规则不变
- **Bidi**：两端各持 Sink + Handle，终局帧双向各一；终局锁、取消钩子、资源清理逻辑直接复用
- 本次协议决策需要满足：帧按 streamId 归属与方向无关、终局判别结构对称、
  取消不绑定"只能由消费端发起"的假设

## 8. 服务注册收口：名字从实现类推导（v2 顺带改进）

v1 注册时名字是手写字符串，与契约键、类名三处可漂移：

```typescript
// v1：现状（services/index.ts）
router.registerService('chat', new ChatServiceImpl(configService, workspace));
```

v2 约定：**实现类命名为 `<Pascal(契约键)>ServiceImpl`**，注册名由类名机械推导，
启动处只负责 new 实例（依赖组装仍显式手工构造，不引入容器）：

```typescript
// v2 提案
registerAll(router, [
  await ConfigServiceImpl.create(userDataPath),  // 或先 new 再 load()
  new ChatServiceImpl(configService, workspace),
  new FileServiceImpl(workspace),
]);

// 推导规则：constructor.name 去掉 'ServiceImpl' 后缀，首字母小写
// ConfigServiceImpl → config；ChatServiceImpl → chat；FileServiceImpl → file
function serviceNameOf(instance: object): keyof MainServices {
  const pascal = instance.constructor.name.replace(/ServiceImpl$/, '');
  return (pascal.charAt(0).toLowerCase() + pascal.slice(1)) as keyof MainServices;
}
```

配套约束：

- `registerAll` 的参数类型绑定契约：`ReadonlyArray<MainServices[keyof MainServices]>`，
  传入未实现契约的对象编译报错；推导名不在 `keyof MainServices` 中时启动即 throw（fail fast）
- Router 底层的单实例注册签名同时收紧泛型兜底：
  `registerService<K extends keyof MainServices>(name: K, service: MainServices[K])`
- **风险**：`constructor.name` 依赖类名不被改写。electron-vite 主进程默认不 mangle，当前安全；
  若未来开启压缩改名，要么配置保留类名，要么回退到方案 (b)
- 取舍：若宁可要静态完全保证，用带键对象字面量 `registerAll(router, { config: new ConfigImpl(...) })`——
  键仍是手写但编译器校验键集合与实例类型，且压缩安全（D12 二选一）

## 9. 依赖装配：Composition Root（不引入 IoC 容器）

类逐渐增多、依赖多层嵌套时，混乱的病根不是"没有容器"，而是 `new` 散落在各处、
全局单例随取随用、构造函数里做 I/O。约定采用 **Composition Root（组装根 / Pure DI）**：
整个主进程只有启动组装函数一个地方允许 `new` 服务，所有类的依赖只出现在构造函数参数里。

```typescript
// 唯一组装根：依赖图自上而下读一遍即懂（示意，非最终代码）
export async function buildApp(router: RpcRouter, userDataPath: string) {
  const config = await ConfigServiceImpl.create(userDataPath); // L1 无依赖基础设施
  const workspace = new WorkspaceState();
  const modelClient = new ModelClient(config);                 // L2 只依赖 L1
  const agentFactory = new AgentFactory(config, modelClient);  // L3 依赖 L1+L2
  registerAll(router, [                                        // L4 RPC 适配层
    config,
    new ChatServiceImpl(agentFactory),
    new FileServiceImpl(workspace),
  ]);
}
```

六条纪律：

1. 只有组装根能 `new` 服务；业务类构造函数里禁止 `new` 依赖，需要就声明在参数里
2. 依赖全部在 constructor 签名可见，禁止 import 全局单例实例（Service Locator）
3. 构造函数不做 I/O；异步初始化走静态 `create()`，组装根按拓扑顺序 await
4. 生命周期显式：进程级单例在组装根建一次；每次调用新建的对象注入**工厂函数**（如 `(msg) => Agent`），不注入容器
5. 组装函数超过一屏时按层拆子组装函数（`buildModelStack(deps)`），返回该层实例，依赖仍单向向上传
6. 循环依赖零容忍——手工组装下它在构造参数里肉眼可见；出现说明边界划错，抽公共下层

升级触发条件（满足才重新评估，不以类数量为标准）：插件 / 贡献点机制、请求级作用域 +
统一拦截链（鉴权 / 日志 / 重试）、几十个服务的延迟装配。届时的第三档是约 50 行的
**微型显式容器**（`Map<Token, (c) => T>` 工厂表 + 单例缓存 + 递归 resolve），
仍不要元数据 / 装饰器；不直接上 Nest 级框架。

## 10. Agent 的接入方式（第一个使用方）

机制与 Agent 解耦，ChatServiceImpl 是纯适配层。Agent 侧有两种深度：

- **浅接入（适配层映射）**：Agent.run 维持现状，ChatServiceImpl 用形态 B 包一层，
  识别事件流里的 `error` / `done` 事件转成 error()/end()，事件本身继续透传给 UI。
  优点：Agent 零改动；缺点：事件与终局仍双轨，适配器要懂 Agent 语义。
- **深接入（推荐）**：`run()` 签名改为 `AsyncGenerator<AgentEvent, SendResult>`，
  删除 AgentEvent 中的 `error` / `done`（结束语义全部走生成器返回值），
  四个退出点（完成 / LLM 失败 / 超步数 / abort）分别 return 对应结果。
  优点：事件流只剩过程数据，终局语义只有一处；缺点：agent-core 与 App.tsx 冒烟代码要跟着改。

## 11. 机制包抽离规划（独立 workspace 包，未来可发 npm）

> 状态：**Phase 1 已完成**（`libs/rpc` 建包 + 机制迁移 + `shared` → `contracts` 更名同批落地，
> 行为零变化、Router 测试随包迁移全绿）；Phase 2（独立构建 / 发 npm）未启动。

RPC 机制与业务物理分离，避免机制代码散落在三个应用包内，也为本方案沉淀为可复用 / 可发布资产做准备。
**从第一天就独立成 workspace 包，不塞进应用契约包内部**——契约包装的是业务 DTO 与服务契约（含 AgentEvent），
pnpm monorepo 下新建包零额外成本，混放反而要二次搬迁。

**包位置**：`libs/rpc`——通用基础库目录，与业务应用包（`packages/`）维护解耦
（初版按 D16 落地于 `packages/` 平级，Phase 1 完成后与 fetch-sse-client 一并归入 `libs/`）。
依赖方向：electron-main / electron-preload / web 各自只依赖 rpc 包的对应子路径；
agent-core 不依赖 rpc 包（它只产事件，不知道传输存在）。

包形态（暂定包名 `@code-agent/rpc`，发布前改中性名成本低）按运行环境做 subpath exports：

| 子路径 | 内容 | 来源 | electron 依赖 |
| --- | --- | --- | --- |
| `@code-agent/rpc/protocol` | 通道常量、信封、帧、StreamEnd、RpcErrorInfo、Sink/Handle 类型 | `shared/src/rpc/protocol.ts` | 无 |
| `@code-agent/rpc/main` | RpcRouter、createRpcStream（Sink + 状态机）、bindIpc | `electron-main/src/rpc/Router.ts`、`bindIpc.ts` | peerDependency |
| `@code-agent/rpc/preload` | `exposeRpcTransport()`：一行 contextBridge 暴露哑管道 | `electron-preload/src/index.ts` | peerDependency |
| `@code-agent/rpc/renderer` | createRpcClient 双层 Proxy、消费端句柄（buffer 重放 / 自动退订） | `web/src/bridge/client.ts`、`stream.ts` | 无 |
| `@code-agent/rpc/mock` | mock Transport（信封 + 假帧 + 取消），供使用方浏览器独立调试 | `web/src/bridge/mock.ts` | 无 |

**契约包同步更名：`packages/shared`（`@code-agent/shared`）→ `packages/contracts`（`@code-agent/contracts`）**。

rpc 机制抽走后，该包只剩业务 DTO（AgentEvent / ToolCall / AppConfig / FileNode）、
MainServices 服务契约与常量——全是被两个以上包消费的纯类型合同，"shared" 命名过于宽泛，
"contracts" 同时涵盖数据契约与行为契约，且与机制包形成对仗：**机制走 `@code-agent/rpc`，应用说什么话走 `@code-agent/contracts`**。
内部目录结构不动，仅包名、目录名与全仓 import 前缀变更；`rpc/contract.ts` 留在该包。

**留在应用层、不进 rpc 包**：

- `contract.ts`（MainServices 与业务 DTO）——消费方各自定义服务契约是库的使用方式
- 第 8 节的 registerAll / 类名推导约定——这是**应用组装约定**，库只提供泛型 `registerService<K, T>`
- `services/` 全部业务实现与第 9 节的组装根

泛化审计（抽离时必须满足）：通道名以常量导出且可配置、`StreamEvent` 约束不含业务字段、
`RPC_*` 保留码通用、Router 不 import electron（现状已满足）、全包无 Agent / chat 概念。

节奏：

- **Phase 0（✅ 已完成）**：v2 在现有位置实现 + 测试全绿，不边写边迁（避免双战线），包名一律不动
- **Phase 1（✅ 已完成）**：建 `libs/rpc` 并迁移机制文件；**同一次重排内**完成 shared → contracts 更名与全仓 import 改写
  （两件事都要全仓改 import，合并只痛一遍）；行为零变化、测试随包搬走
- **Phase 2**：独立构建（tsup / unbuild 双格式 dts）、最小示例工程、版本与 CHANGELOG，具备发 npm 条件

## 12. 影响面（预估，不含任务拆解）

- `shared/src/rpc/protocol.ts`：帧二态化、StreamEnd / RpcErrorInfo、Sink 类型、RpcStream 泛型 R
- `electron-main/src/rpc/Router.ts`：状态机重写（终局锁）、双形态工厂、取消路径改造 + 测试重写
- `web/src/bridge/stream.ts`：onEnd 三态、buffer/清理逻辑适配
- `web/src/bridge/client.ts`、`mock.ts`：终局结构适配
- `electron-main/src/rpc/Router.ts` / `services/index.ts`：registerService 泛型收紧、registerAll 统一收口（第 8 节）
- Unary 链路：仅错误类型更名 / 单源，行为不变
- 视 D5 决定是否改 `agent-core` 的 Agent.run 与 `shared` AgentEvent
- Phase 1 另起任务：新建 `libs/rpc`，上述机制文件迁移与全仓 import 改写（第 11 节）

## 13. 开放决策点（待讨论）

| # | 决策点 | 候选 | 当前倾向 |
| --- | --- | --- | --- |
| D1 | 帧形态 | (a) `next / end` 单终局帧，三态在 value 里；(b) 保守保留 `return/throw`，仅补 result 字段 | (a)：终局唯一、成败对称，状态机更简单 |
| D2 | 生产端形态 | (a) 推模式空参 + generator 重载双形态；(b) 只留推模式，拉模式源由业务自己 for-await 转发 | (a)：拉模式只有一处适配器，放机制里避免每个服务重写 |
| D3 | 终局是否带结果 R | (a) 泛型 `R`，completed 携带结果；(b) 终局无数据，结束就是结束 | (a)：terminal 退出码、Agent 步数统计有自然位置；无结果时 R=void 零成本 |
| D4 | 取消的表达 | (a) 独立三态 `aborted`；(b) `failed{code:'CANCELLED'}` 二态 | (a)：取消是用户意图不是错误，UI 不应弹错误提示 |
| D5 | Agent 接入深度 | (a) 深接入：删 done/error 事件，走 generator 返回值；(b) 浅接入：适配层映射 | (a)：否则机制的纯粹性在第一个用户身上就破功 |
| D6 | 错误结构命名 | 跨模式单源类型 `RpcErrorInfo`，web 侧 throwable 包装保留 `RpcError` 类 | 倾向单源，减少概念数 |
| D7 | Sink 本地旁路 | 保留 on/onEnd（服务端可监听自己的流，测试/日志用）还是只留写侧 + onAbort | 倾向保留，v1 已有且 Router 测试依赖 |
| D8 | 反向流预留 | 帧协议/通道是否现在就为 renderer→main 数据帧留命名位 | 倾向**不预留**：YAGNI，二期加新帧 kind 即可，不破坏现协议 |
| D9 | 空闲看门狗 | 本次是否加无帧超时自动终结 | 倾向不加；若加仅作为 Router 可选配置，终局仍归 failed(IDLE_TIMEOUT) |
| D10 | 取消与标准 AbortSignal 互操作 | (a) 仅自有 `abort()`；(b) `abort()` 之外，消费端可传入外部 `AbortSignal` 联动取消，句柄另暴露只读 `signal` 反映终局；(c) 全面 AbortSignal 化（onEnd 也改成 signal 风格） | (b)：内部链路仍是 `__stream.cancel`，对外与 fetch / tRPC 一致；UI 可把组件卸载、超时、用户停止统一接一个 controller；(c) 过度，丢掉穷尽三态回调 |
| D11 | 错误码命名空间 | (a) 机制保留码收敛为固定枚举（占用 `RPC_*` 保留段），业务码自由字符串；(b) 在 (a) 基础上约定业务码带服务前缀（`chat.LLM_FAILED`），用模板字面量类型给提示但不强制；(c) gRPC 式全数字码 | (a)+(b)：机制码与业务码物理隔离防冲突，服务前缀是低成本约定；数字码在自有业务里可读性差，不采用 |
| D12 | 服务注册名来源 | (a) 类名推导：约定 `<Key>ServiceImpl`，registerAll 收实例数组，`constructor.name` 去后缀小写化；(b) 带键对象字面量 registerAll({ config: new ... })，键手写但编译期校验；(c) 维持 v1 手写字符串 + 泛型收紧 | (a)：新增服务只写实现类、塞进数组，零字符串；代价是依赖类名不被 mangle + 命名约定；(b) 为压缩安全的退路 |
| D13 | 是否用装饰器自注册 | (a) 不用：维持 D12(a) 数组注册；(b) `@RpcService()` 装饰器 + 收集器 + barrel 副作用导入自动注册 | (a)：装饰器只省掉数组一行，却引入隐式注册、barrel 维护、实现类与框架耦合；且不解决依赖装配（无元数据仍须手工 new） |
| D14 | 多层依赖的装配方式 | (a) Composition Root（唯一组装根手工 new + 六条纪律）；(b) 微型显式容器（Token→工厂表，无元数据）；(c) Nest 级 IoC 框架（装饰器 + 元数据 + 生命周期） | 现阶段 (a)：容器是可选便利工具而非 DI 前提；(b) 作为触发条件达成后的升级档；(c) 与工具链和项目规模均不匹配 |
| D15 | RPC 机制是否抽独立包 | (a) v2 落地后新建独立 workspace 包（subpath exports：protocol/main/preload/renderer/mock），contract 与组装约定留应用层，Phase 2 再发 npm；(b) 长期留在应用三包内；(c) 现在就边写 v2 边抽 | (a)：业务 / 机制物理分离且为 npm 发布铺路；独立包而非契约包子目录，避免二次搬迁；(c) 双战线不采用 |
| D16 | rpc 包位置与 shared 更名 | 位置：(a) `packages/rpc` 与应用包平级；(b) 仓库内再开 libs/ 子目录分组。更名：(a) shared → **`@code-agent/contracts`**；(b) `@code-agent/shared-types`；(c) `@code-agent/api`；(d) 不更名 | 位置 (b)（后续修正）：rpc 与 fetch-sse-client 是通用基础库而非业务拆分，维护周期不同，归入 `libs/`；更名 (a)：数据契约 + 行为契约都被 contracts 涵盖，与 rpc 包对仗；(b) 放不进运行时合同时会打脸，(c) 易与 HTTP API 混淆且 agent-core 语义不符。Phase 1 与抽包同批执行 |

## 14. 变更记录

- v0.1（讨论稿）：仅以"流式生命周期原语"立题，提出 Sink/Handle、next/end 帧、三态终局、双形态工厂
- v0.2（讨论稿）：重新定位为**整套 IPC/RPC 通信方案的 v2 设计**——补统一世界观（建立 → 数据消息 → 唯一终局）、
  协议全景、跨模式取消与错误模型、未来模式演进路径；本次动工范围为 Unary（仅错误类型单源化）
  与 Server Streaming（终局机制重写）；列出 D1–D9 待决策
- v0.3（讨论稿）：行业调研后补 D10（取消与标准 AbortSignal 互操作，倾向外部 signal 联动）、
  D11（错误码命名空间：机制码占 `RPC_*` 保留段 + 业务码服务前缀约定），第 6 节保留码同步更名
- v0.4（讨论稿）：补第 8 节服务注册收口——注册名从实现类名机械推导（`<Key>ServiceImpl` → 契约键）、
  registerAll 统一入口、registerService 泛型收紧；列 D12（类名推导 vs 带键对象字面量）
- v0.5（讨论稿）：补第 9 节依赖装配纪律（Composition Root / Pure DI + 六条纪律 + 微型容器升级触发条件）、
  第 11 节机制包抽离规划（独立 workspace 包 `@code-agent/rpc`，五个环境子路径，Phase 0/1/2 节奏）；
  列 D13（不引入注册装饰器）、D14（不引入 IoC 容器）、D15（v2 后抽独立包，远期发 npm）
- v0.6（讨论稿）：第 11 节定稿包位置为 `packages/rpc`（与应用包平级，agent-core 不依赖它），
  并确定 `packages/shared` 同步更名 `packages/contracts`（`@code-agent/contracts`），
  更名与抽包合并在 Phase 1 同一次重排；列 D16
- v1.0（实施）：Phase 0 落地（帧二态 / 终局三态 / 双形态工厂 / 注册收口 / Agent 深接入）；
  Phase 1 落地——机制五面（protocol / main / preload / renderer / mock）迁入 `packages/rpc`，
  `shared` → `contracts` 更名与全仓 import 改写同批完成，preload 收口为 `exposeRpcTransport()` 一行调用，
  web mock 拆为 rpc 包通用框架 + 应用侧业务场景声明；构建 / typecheck / 全部测试（Router 20 + agent-core 94）验证零回归
- v1.1（实施）：D16 位置决策修正——rpc 与 fetch-sse-client 属通用基础库（非业务拆分），
  从 `packages/` 迁入新开 `libs/` 目录；pnpm-workspace 增加 `libs/*`，消费方 tsconfig references 同步，
  构建 / typecheck / 测试再次验证零回归
