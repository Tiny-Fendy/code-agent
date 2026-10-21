# 服务注册名显式化（serviceName 字段）

## 背景

v2 方案（rpc-communication-v2/design.md D12a）选择的服务注册名来源是**类名推导**：
`registerAll` 通过 `constructor.name` 去 `ServiceImpl` 后缀、首字母小写得到契约键。

实践后确认这是隐藏规则：注册名的正确性依赖"实现类必须命名为 `<Key>ServiceImpl`"这一
命名约定，代码里没有任何显式表达；类重命名、构建压缩改名都会静默漂移，只能靠运行时
白名单兜底，可读性与工具链支持都差。

## 决策变更

**推翻 D12a 的类名推导，改为契约接口显式声明服务名**：

1. 契约侧新增 `ServiceDef<N>` 基础接口，每个服务契约显式携带字面量名：

   ```ts
   export interface ServiceDef<N extends string> {
     readonly serviceName: N;
   }
   export interface ConfigService extends ServiceDef<'config'> { ... }
   ```

2. `Router.registerAll` 改为直接读取实例的 `serviceName` 字段；删除 `serviceNameOf`
   类名推导函数及其导出。实例缺字段或不在 `serviceKeys` 白名单即启动 throw（fail fast）。

3. `MainServices` 键与服务名的一致性由两层保证：
   - 实现类 `implements` 契约接口，`serviceName` 被字面量类型强制，写错编译报错
   - 契约文件内 `ServiceNameMismatch` 工具类型编译期断言：键 ≠ serviceName 即报错，
     提示含具体键名

4. 客户端 `RpcClient` 类型映射用 `as` 子句排除 `serviceName` 元字段，
   `rpc.config` 的服务/方法提示不受影响，元字段不会被"调用"。

## 影响面

| 位置 | 变更 |
| --- | --- |
| `packages/contracts/src/rpc/contract.ts` | 新增 ServiceDef / ServiceNameMismatch；3 个服务接口接入；编译期断言 |
| `libs/rpc/src/main/Router.ts` | 删 serviceNameOf；registerAll 读 serviceName 字段 |
| `libs/rpc/src/renderer/client.ts` | RpcClient 映射排除 serviceName 元字段 |
| `packages/electron-main/src/rpc/services/*.ts` | 3 个实现类补 `readonly serviceName = '...' as const` |
| `libs/rpc/test/main/Router.test.ts` | 删 serviceNameOf 用例；registerAll 用例改字段方式；新增缺字段 throw 用例 |

## 取舍记录

- 字段名用 `serviceName` 而非 `name`：服务接口里 `name` 过于通用，易与业务字段撞名。
- 元字段放普通接口属性（而非 unique symbol brand）：运行时可直接读取、写法直白；
  代价是契约方法面多一个元字段，由客户端类型映射排除、服务端实现类各一行声明承担。
- `StreamMethodsOf` 无需改动：`serviceName` 是 string 属性，不匹配函数签名，映射为 never。

## 验收

- 全仓 typecheck 通过（含契约一致性编译期断言）
- `@code-agent/rpc` 测试 20/20 通过（含缺字段 fail fast、白名单 fail fast 用例）
- web 侧 `satisfies StreamMethodsOf` 清单与 `rpc.<service>` 提示不受影响
