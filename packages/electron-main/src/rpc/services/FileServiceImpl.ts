/**
 * FileService 实现：目录选择对话框 + 文件树 + 读文件
 *
 * 文件树递归时跳过隐藏文件和常见的大体积目录（node_modules / dist 等），
 * 并限制最大深度，避免巨型目录拖垮主进程。
 */

import { dialog } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileNode, FileService } from '@code-agent/contracts';
import type { WorkspaceState } from './WorkspaceState';

/** 递归跳过的目录名 */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache']);
/** 文件树最大递归深度 */
const MAX_DEPTH = 6;

export class FileServiceImpl implements FileService {
  constructor(private readonly workspace: WorkspaceState) {}

  async openFolderDialog(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: '选择项目文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const projectPath = result.filePaths[0];
    this.workspace.setProjectPath(projectPath);
    return projectPath;
  }

  async getFileTree(projectPath: string): Promise<FileNode[]> {
    return this.buildTree(projectPath, 0);
  }

  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }

  private async buildTree(dir: string, depth: number): Promise<FileNode[]> {
    if (depth >= MAX_DEPTH) return [];

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const nodes: FileNode[] = [];
    for (const entry of entries) {
      // 隐藏文件 / 忽略目录不进树
      if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children: await this.buildTree(fullPath, depth + 1),
        });
      } else if (entry.isFile()) {
        nodes.push({ name: entry.name, path: fullPath, type: 'file' });
      }
    }

    // 目录在前、文件在后，各自按名称排序
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
}
