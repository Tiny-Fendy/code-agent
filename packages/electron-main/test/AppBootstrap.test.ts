/**
 * AppBootstrap 测试（镜像 src/AppBootstrap.ts）
 *
 * 契约关注点：启动顺序（ready → RPC 装配 → 建窗）、静态路径环境变量、
 * 跨平台关闭行为、macOS activate 条件重建窗口。
 * electron / MainWindow / 服务组装根 / logger 全部替换为测试替身。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const h = vi.hoisted(() => {
  const sequence: string[] = [];
  const appHandlers = new Map<string, (...args: unknown[]) => void>();
  const app = {
    isPackaged: false,
    whenReady: vi.fn(async () => {
      sequence.push('whenReady');
    }),
    getPath: vi.fn(() => '/tmp/user-data'),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      appHandlers.set(event, cb);
    }),
    quit: vi.fn(),
  };
  const BrowserWindow = { getAllWindows: vi.fn((): unknown[] => []) };
  const registerServices = vi.fn(async (_router: unknown, _userDataPath: string, _logger: unknown) => {
    sequence.push('registerServices');
  });
  const bindIpc = vi.fn((_router: unknown) => {
    sequence.push('bindIpc');
  });
  const rpcRouter = vi.fn((_options: unknown) => {
    sequence.push('rpcRouter');
  });
  const mainWindow = vi.fn((_options: unknown) => {
    sequence.push('mainWindow');
  });
  const logInfo = vi.fn();

  return { sequence, appHandlers, app, BrowserWindow, registerServices, bindIpc, rpcRouter, mainWindow, logInfo };
});

vi.mock('electron', () => ({ app: h.app, BrowserWindow: h.BrowserWindow }));
vi.mock('../src/rpc/services/index.ts', () => ({ registerServices: h.registerServices }));
vi.mock('@code-agent/rpc/main', () => ({
  RpcRouter: class {
    constructor(options: unknown) {
      h.rpcRouter(options);
    }
  },
  bindIpc: (router: unknown) => h.bindIpc(router),
}));
vi.mock('../src/window/MainWindow', () => ({
  MainWindow: class {
    constructor(options: unknown) {
      h.mainWindow(options);
    }
  },
}));
vi.mock('../src/logger/index', () => ({
  ConsoleLogger: class {
    info(...args: unknown[]) {
      h.logInfo(...args);
    }
  },
}));

import { AppBootstrap } from '../src/AppBootstrap';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

beforeEach(() => {
  h.sequence.length = 0;
  h.appHandlers.clear();
  h.app.isPackaged = false;
  h.BrowserWindow.getAllWindows.mockReturnValue([]);
  delete process.env.DIST;
  delete process.env.VITE_PUBLIC;
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
  delete process.env.DIST;
  delete process.env.VITE_PUBLIC;
});

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
}

describe('AppBootstrap 启动顺序与装配', () => {
  it('ready 之后依次装配 Router、服务、IPC，再创建窗口', async () => {
    await new AppBootstrap().bootstrap();

    expect(h.sequence).toEqual([
      'whenReady',
      'rpcRouter',
      'registerServices',
      'bindIpc',
      'mainWindow',
    ]);
  });

  it('Router 带契约键白名单，服务组装使用 userData 路径与同一个 logger', async () => {
    await new AppBootstrap().bootstrap();

    expect(h.rpcRouter).toHaveBeenCalledWith({ serviceKeys: ['config', 'chat', 'file'] });
    expect(h.registerServices).toHaveBeenCalledTimes(1);
    const args = h.registerServices.mock.calls[0] as unknown[];
    expect(args[1]).toBe('/tmp/user-data');
    expect(typeof (args[2] as { info?: unknown }).info).toBe('function');
  });

  it('启动完成后记录 app ready 日志', async () => {
    await new AppBootstrap().bootstrap();

    expect(h.logInfo).toHaveBeenCalledWith(
      'app ready',
      expect.objectContaining({ userData: '/tmp/user-data' }),
    );
  });
});

describe('AppBootstrap 静态路径', () => {
  it('非打包模式：DIST 指向 dist，VITE_PUBLIC 指向 dist/renderer', async () => {
    h.app.isPackaged = false;

    await new AppBootstrap().bootstrap();

    const dist = process.env.DIST as string;
    expect(path.normalize(dist)).toBe(
      path.normalize(path.join(import.meta.dirname, '../dist')),
    );
    expect(process.env.VITE_PUBLIC).toBe(path.join(dist, 'renderer'));
  });

  it('打包模式：VITE_PUBLIC 与 DIST 相同', async () => {
    h.app.isPackaged = true;

    await new AppBootstrap().bootstrap();

    expect(process.env.VITE_PUBLIC).toBe(process.env.DIST);
  });
});

describe('AppBootstrap 生命周期', () => {
  it('非 macOS 关闭全部窗口后退出应用', async () => {
    setPlatform('linux');
    await new AppBootstrap().bootstrap();

    h.appHandlers.get('window-all-closed')?.();

    expect(h.app.quit).toHaveBeenCalledTimes(1);
  });

  it('macOS 关闭全部窗口后不退出应用', async () => {
    setPlatform('darwin');
    await new AppBootstrap().bootstrap();

    h.appHandlers.get('window-all-closed')?.();

    expect(h.app.quit).not.toHaveBeenCalled();
  });

  it('activate 时无窗口才重建窗口', async () => {
    await new AppBootstrap().bootstrap();
    const activate = h.appHandlers.get('activate');
    expect(activate).toBeTypeOf('function');
    expect(h.mainWindow).toHaveBeenCalledTimes(1);

    h.BrowserWindow.getAllWindows.mockReturnValue([{}]);
    activate?.();
    expect(h.mainWindow).toHaveBeenCalledTimes(1);

    h.BrowserWindow.getAllWindows.mockReturnValue([]);
    activate?.();
    expect(h.mainWindow).toHaveBeenCalledTimes(2);
  });
});
