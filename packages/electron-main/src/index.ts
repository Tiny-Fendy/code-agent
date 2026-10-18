/**
 * Electron 主进程入口
 */

import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { MainServices } from '@code-agent/contracts';
import { RpcRouter, bindIpc } from '@code-agent/rpc/main';
import { registerServices } from './rpc/services';
import { ConsoleLogger } from './logger';

const logger = new ConsoleLogger();

// 契约键白名单：registerAll 类名推导的运行时保险（编译期仍由泛型约束）
const SERVICE_KEYS = ['config', 'chat', 'file'] as const satisfies ReadonlyArray<
  keyof MainServices
>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 用于构建后的静态资源路径
const DIST_PATH = path.join(__dirname, '../dist');
process.env.DIST = DIST_PATH;
process.env.VITE_PUBLIC = app.isPackaged
  ? DIST_PATH
  : path.join(DIST_PATH, 'renderer');

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    title: 'Code Agent',
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      // 安全配置
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 开发环境加载 Vite dev server，生产环境加载静态文件
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // 本地开发模式下自动打开 DevTools
  if (import.meta.env.MODE === 'development') {
    win.webContents.openDevTools();
  }

  win.on('closed', () => {
    logger.info('window closed');
    win = null;
  });
}

// 当 Electron 完成初始化并准备创建浏览器窗口时调用
app.whenReady().then(async () => {
  // RPC：注册服务（config / chat / file）并接上 IPC
  const router = new RpcRouter<MainServices>({ serviceKeys: SERVICE_KEYS });
  await registerServices(router, app.getPath('userData'));
  bindIpc(router);

  createWindow();

  logger.info('app ready', {
    mode: import.meta.env.MODE,
    userData: app.getPath('userData'),
  });

  app.on('activate', () => {
    // 在 macOS 上，当点击 dock 图标并且没有其他窗口打开时，
    // 通常在应用程序中重新创建一个窗口
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 当所有窗口关闭时退出应用（除了 macOS）
app.on('window-all-closed', () => {
  logger.info('window all closed', { platform: process.platform });
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
