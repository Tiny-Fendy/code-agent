/**
 * 主窗口封装
 *
 * 收敛 BrowserWindow 的创建参数、页面加载、开发模式 DevTools 与关闭通知，
 * 让启动编排只关心「开一个窗口 / 窗口已关闭」。
 */

import { BrowserWindow } from 'electron';
import path from 'node:path';
import type { Logger } from '@code-agent/contracts';

export interface MainWindowOptions {
  logger: Logger;
}

export class MainWindow {
  private readonly win: BrowserWindow;

  constructor({ logger }: MainWindowOptions) {
    this.win = new BrowserWindow({
      title: 'Code Agent',
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      webPreferences: {
        preload: path.join(import.meta.dirname, '../preload/index.mjs'),
        // 安全配置
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    this.load();
    this.openDevToolsInDevelopment();

    this.win.on('closed', () => {
      logger.info('window closed');
    });
  }

  /** 开发环境加载 Vite dev server，生产环境加载静态文件 */
  private load(): void {
    if (process.env.VITE_DEV_SERVER_URL) {
      this.win.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
      this.win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
    }
  }

  private openDevToolsInDevelopment(): void {
    if (import.meta.env.MODE === 'development') {
      this.win.webContents.openDevTools();
    }
  }
}
