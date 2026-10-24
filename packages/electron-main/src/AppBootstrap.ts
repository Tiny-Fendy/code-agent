/**
 * 主进程启动编排
 *
 * 把 Electron 的各种启动流程（静态路径、应用生命周期、RPC 装配、窗口创建）
 * 收敛在同一个类里；入口 index.ts 只负责创建实例并调用 bootstrap()。
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import type { MainServices } from '@code-agent/contracts';
import { RpcRouter, bindIpc } from '@code-agent/rpc/main';
import { registerServices } from './rpc/services';
import { MainWindow } from './window/MainWindow';
import { ConsoleLogger } from './logger';

// 契约键白名单：registerAll 读取 serviceName 的运行时保险（编译期仍由泛型约束）
const SERVICE_KEYS = ['config', 'chat', 'file'] as const satisfies ReadonlyArray<
  keyof MainServices
>;

export class AppBootstrap {
  private readonly logger = new ConsoleLogger();

  /** 启动应用：注册生命周期，等待 ready 后装配服务并创建窗口 */
  async bootstrap(): Promise<void> {
    this.setupPaths();
    this.registerLifecycle();
    await app.whenReady();
    await this.start();
  }

  /**
   * 静态资源路径
   *
   * 包根目录用 import.meta.dirname：ESM 下不写 __dirname，
   * 否则会与 electron-vite 注入的同名 shim 重复声明。
   */
  private setupPaths(): void {
    const distPath = path.join(import.meta.dirname, '../dist');
    process.env.DIST = distPath;
    process.env.VITE_PUBLIC = app.isPackaged
      ? distPath
      : path.join(distPath, 'renderer');
  }

  private registerLifecycle(): void {
    app.on('window-all-closed', () => {
      this.logger.info('window all closed', { platform: process.platform });
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });

    app.on('activate', () => {
      // macOS 点击 dock 且无窗口时重建窗口
      if (BrowserWindow.getAllWindows().length === 0) {
        this.createWindow();
      }
    });
  }

  /** ready 之后：RPC 服务装配 + 首窗 */
  private async start(): Promise<void> {
    const router = new RpcRouter<MainServices>({ serviceKeys: SERVICE_KEYS });
    await registerServices(router, app.getPath('userData'), this.logger);
    bindIpc(router);

    this.createWindow();

    this.logger.info('app ready', {
      mode: import.meta.env.MODE,
      userData: app.getPath('userData'),
    });
  }

  private createWindow(): void {
    new MainWindow({ logger: this.logger });
  }
}
