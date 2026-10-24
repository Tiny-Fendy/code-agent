/**
 * MainWindow 测试（镜像 src/window/MainWindow.ts）
 *
 * 契约关注点：窗口安全配置与最小尺寸、开发环境加载 dev server / 生产加载静态页、
 * 仅开发模式打开 DevTools、关闭事件写日志。electron 用假 BrowserWindow 替换。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { Logger } from '@code-agent/contracts';

const electron = vi.hoisted(() => {
  const instances: Array<{
    options: Record<string, any>;
    loadURL: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    webContents: { openDevTools: ReturnType<typeof vi.fn> };
  }> = [];

  class BrowserWindow {
    options: Record<string, any>;
    loadURL = vi.fn();
    loadFile = vi.fn();
    on = vi.fn();
    webContents = { openDevTools: vi.fn() };

    constructor(options: Record<string, any>) {
      this.options = options;
      instances.push(this as never);
    }
  }

  return { BrowserWindow, instances };
});

vi.mock('electron', () => ({ BrowserWindow: electron.BrowserWindow }));

import { MainWindow } from '../../src/window/MainWindow';

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const originalDevServerUrl = process.env.VITE_DEV_SERVER_URL;

beforeEach(() => {
  electron.instances.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalDevServerUrl === undefined) {
    delete process.env.VITE_DEV_SERVER_URL;
  } else {
    process.env.VITE_DEV_SERVER_URL = originalDevServerUrl;
  }
  vi.unstubAllEnvs();
});

function lastWindow() {
  return electron.instances[electron.instances.length - 1];
}

describe('MainWindow 创建与安全配置', () => {
  it('创建窗口时带上标题、尺寸与隔离配置', () => {
    delete process.env.VITE_DEV_SERVER_URL;

    new MainWindow({ logger });

    expect(electron.instances).toHaveLength(1);
    const { options } = lastWindow();
    expect(options).toMatchObject({
      title: 'Code Agent',
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
  });

  it('preload 指向构建产物目录下的 preload/index.mjs', () => {
    delete process.env.VITE_DEV_SERVER_URL;

    new MainWindow({ logger });

    const preload = lastWindow().options.webPreferences.preload as string;
    expect(path.normalize(preload)).toBe(
      path.normalize(path.join(import.meta.dirname, '../../src/preload/index.mjs')),
    );
  });
});

describe('MainWindow 页面加载', () => {
  it('存在 VITE_DEV_SERVER_URL 时加载开发服务器，不加载本地文件', () => {
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173';

    new MainWindow({ logger });

    const win = lastWindow();
    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:5173');
    expect(win.loadFile).not.toHaveBeenCalled();
  });

  it('没有 dev server 时加载 renderer/index.html', () => {
    delete process.env.VITE_DEV_SERVER_URL;

    new MainWindow({ logger });

    const win = lastWindow();
    expect(win.loadFile).toHaveBeenCalledTimes(1);
    expect(win.loadFile.mock.calls[0][0]).toMatch(/renderer[/\\]index\.html$/);
    expect(win.loadURL).not.toHaveBeenCalled();
  });
});

describe('MainWindow 开发模式与关闭事件', () => {
  it('MODE=development 时打开 DevTools', () => {
    delete process.env.VITE_DEV_SERVER_URL;
    vi.stubEnv('MODE', 'development');

    new MainWindow({ logger });

    expect(lastWindow().webContents.openDevTools).toHaveBeenCalledTimes(1);
  });

  it('非开发模式不打开 DevTools', () => {
    delete process.env.VITE_DEV_SERVER_URL;

    new MainWindow({ logger });

    expect(lastWindow().webContents.openDevTools).not.toHaveBeenCalled();
  });

  it('窗口关闭时通过 logger 记录', () => {
    delete process.env.VITE_DEV_SERVER_URL;

    new MainWindow({ logger });

    const win = lastWindow();
    const closedHandler = win.on.mock.calls.find(([event]) => event === 'closed')?.[1];
    expect(closedHandler).toBeTypeOf('function');

    closedHandler();

    expect(logger.info).toHaveBeenCalledWith('window closed');
  });
});
