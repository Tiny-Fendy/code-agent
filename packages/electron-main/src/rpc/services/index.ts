/**
 * 服务注册：构造三个服务实现并挂到 Router
 *
 * 注册名与 shared/src/rpc/contract.ts 的 MainServices 键一一对应：
 * config / chat / file。
 */

import type { RpcRouter } from '../Router';
import { ChatServiceImpl } from './ChatServiceImpl';
import { ConfigServiceImpl } from './ConfigServiceImpl';
import { FileServiceImpl } from './FileServiceImpl';
import { WorkspaceState } from './WorkspaceState';

export async function registerServices(router: RpcRouter, userDataPath: string): Promise<void> {
  const workspace = new WorkspaceState();

  const configService = new ConfigServiceImpl(userDataPath);
  await configService.load(); // 预载缓存，供 ChatService 同步创建 Agent

  router.registerService('config', configService);
  router.registerService('chat', new ChatServiceImpl(configService, workspace));
  router.registerService('file', new FileServiceImpl(workspace));
}
