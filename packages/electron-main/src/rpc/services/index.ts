/**
 * 服务组装根（Composition Root，见 design.md 第 9 节）：
 * 主进程唯一允许 new 服务的地方；依赖全部显式组装，禁止业务类内部 new 依赖。
 *
 * 注册收口（D12a）：registerAll 传入实例数组，注册名读取各实现类的 serviceName 字段
 * （契约 ServiceDef 显式声明，编译期与 MainServices 键对齐）；白名单不符启动即 throw。
 */

import type { Logger, MainServices } from '@code-agent/contracts';
import type { RpcRouter } from '@code-agent/rpc/main';
import { ChatServiceImpl } from './ChatServiceImpl';
import { ConfigServiceImpl } from './ConfigServiceImpl';
import { FileServiceImpl } from './FileServiceImpl';
import { WorkspaceState } from './WorkspaceState';

export async function registerServices(
  router: RpcRouter<MainServices>,
  userDataPath: string,
  logger: Logger,
): Promise<void> {
  const workspace = new WorkspaceState();

  const configService = new ConfigServiceImpl(userDataPath);
  await configService.load(); // 预载缓存，供 ChatService 同步创建 Agent

  router.registerAll([
    configService,
    new ChatServiceImpl(configService, workspace, logger),
    new FileServiceImpl(workspace),
  ]);
}
