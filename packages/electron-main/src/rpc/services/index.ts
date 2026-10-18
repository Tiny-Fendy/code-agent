/**
 * 服务组装根（Composition Root，见 design.md 第 9 节）：
 * 主进程唯一允许 new 服务的地方；依赖全部显式组装，禁止业务类内部 new 依赖。
 *
 * 注册收口（D12a）：registerAll 传入实例数组，服务名由类名机械推导
 * （ChatServiceImpl → chat），零手写字符串；白名单不符启动即 throw。
 */

import type { MainServices } from '@code-agent/contracts';
import type { RpcRouter } from '@code-agent/rpc/main';
import { ChatServiceImpl } from './ChatServiceImpl';
import { ConfigServiceImpl } from './ConfigServiceImpl';
import { FileServiceImpl } from './FileServiceImpl';
import { WorkspaceState } from './WorkspaceState';

export async function registerServices(
  router: RpcRouter<MainServices>,
  userDataPath: string,
): Promise<void> {
  const workspace = new WorkspaceState();

  const configService = new ConfigServiceImpl(userDataPath);
  await configService.load(); // 预载缓存，供 ChatService 同步创建 Agent

  router.registerAll([
    configService,
    new ChatServiceImpl(configService, workspace),
    new FileServiceImpl(workspace),
  ]);
}
