/**
 * FileServiceImpl 测试（镜像 src/rpc/services/FileServiceImpl.ts）
 *
 * 契约关注点：目录选择与工作区联动、文件树的过滤/排序/深度上限、
 * 不可读目录的容错、以及原样读取文件内容。文件系统用真实临时目录。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FileNode } from '@code-agent/contracts';

const { showOpenDialog } = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showOpenDialog } }));

import { FileServiceImpl } from '../../../src/rpc/services/FileServiceImpl';
import { WorkspaceState } from '../../../src/rpc/services/WorkspaceState';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'code-agent-file-'));
  showOpenDialog.mockReset();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 按路径查找节点，便于断言嵌套结构 */
function findNode(nodes: FileNode[], name: string): FileNode | undefined {
  for (const node of nodes) {
    if (node.name === name) return node;
    const found = node.children ? findNode(node.children, name) : undefined;
    if (found) return found;
  }
  return undefined;
}

describe('FileServiceImpl.openFolderDialog', () => {
  it('用户取消时返回 null 且不修改工作区', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const workspace = new WorkspaceState();
    const service = new FileServiceImpl(workspace);

    await expect(service.openFolderDialog()).resolves.toBeNull();
    expect(workspace.projectPath).toBeNull();
    expect(showOpenDialog).toHaveBeenCalledWith({
      title: '选择项目文件夹',
      properties: ['openDirectory'],
    });
  });

  it('未取消但没有选中路径时返回 null', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
    const workspace = new WorkspaceState();
    const service = new FileServiceImpl(workspace);

    await expect(service.openFolderDialog()).resolves.toBeNull();
    expect(workspace.projectPath).toBeNull();
  });

  it('选中目录后返回路径并写入工作区', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [root] });
    const workspace = new WorkspaceState();
    const service = new FileServiceImpl(workspace);

    await expect(service.openFolderDialog()).resolves.toBe(root);
    expect(workspace.projectPath).toBe(root);
  });
});

describe('FileServiceImpl.getFileTree', () => {
  it('过滤隐藏项与忽略目录，目录在前文件在后且各自按名称排序', async () => {
    await mkdir(path.join(root, 'beta'));
    await mkdir(path.join(root, 'alpha'));
    await writeFile(path.join(root, 'beta', 'f.txt'), 'x');
    await writeFile(path.join(root, 'b.md'), 'x');
    await writeFile(path.join(root, 'a.txt'), 'x');
    await writeFile(path.join(root, '.secret'), 'x');
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'node_modules', 'pkg.js'), 'x');
    await mkdir(path.join(root, 'dist'));
    await writeFile(path.join(root, 'dist', 'bundle.js'), 'x');

    const service = new FileServiceImpl(new WorkspaceState());
    const tree = await service.getFileTree(root);

    expect(tree.map((node) => [node.name, node.type])).toEqual([
      ['alpha', 'directory'],
      ['beta', 'directory'],
      ['a.txt', 'file'],
      ['b.md', 'file'],
    ]);
    expect(findNode(tree, '.secret')).toBeUndefined();
    expect(findNode(tree, 'node_modules')).toBeUndefined();
    expect(findNode(tree, 'dist')).toBeUndefined();

    const beta = findNode(tree, 'beta');
    expect(beta?.path).toBe(path.join(root, 'beta'));
    expect(beta?.children?.map((node) => node.name)).toEqual(['f.txt']);
  });

  it('超过最大深度的层级不再展开', async () => {
    // root/l1/l2/l3/l4/l5/l6/l7，把文件放在第 7 层深处
    let current = root;
    for (let i = 1; i <= 7; i += 1) {
      current = path.join(current, `l${i}`);
      await mkdir(current);
    }
    await writeFile(path.join(current, 'deep.txt'), 'x');
    await writeFile(path.join(root, 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'edge.txt'), 'x');

    const service = new FileServiceImpl(new WorkspaceState());
    const tree = await service.getFileTree(root);

    const l6 = findNode(tree, 'l6');
    expect(l6).toBeDefined();
    // 第 6 层已到上限：不再向下读目录
    expect(l6?.children).toEqual([]);
    expect(findNode(tree, 'l7')).toBeUndefined();
    expect(findNode(tree, 'deep.txt')).toBeUndefined();
    expect(findNode(tree, 'edge.txt')).toBeUndefined();
  });

  it('目录不可读时返回空数组而不是抛异常', async () => {
    const service = new FileServiceImpl(new WorkspaceState());

    await expect(service.getFileTree(path.join(root, 'not-exists'))).resolves.toEqual([]);
  });

  it('空目录返回空数组', async () => {
    const service = new FileServiceImpl(new WorkspaceState());

    await expect(service.getFileTree(root)).resolves.toEqual([]);
  });
});

describe('FileServiceImpl.readFile', () => {
  it('原样返回文件内容（UTF-8）', async () => {
    const file = path.join(root, 'a.txt');
    await writeFile(file, 'line1\n中文内容\n', 'utf-8');

    const service = new FileServiceImpl(new WorkspaceState());
    await expect(service.readFile(file)).resolves.toBe('line1\n中文内容\n');
  });

  it('文件不存在时向上抛错', async () => {
    const service = new FileServiceImpl(new WorkspaceState());

    await expect(service.readFile(path.join(root, 'missing.txt'))).rejects.toThrow();
  });
});
