/**
 * 文件系统服务
 *
 * 封装 Node.js fs API + ripgrep，提供统一的异步文件操作接口。
 * 所有方法接收已通过 PathGuard 校验的绝对路径。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Dirent } from 'node:fs';
import { rgPath } from 'ripgrep';

const execFileAsync = promisify(execFile);

/** 文件配置常量 */
export const FILE_CONFIG = {
  MAX_FILE_SIZE_READ: 100 * 1024, // 单次读取最大 100KB
  MAX_SEARCH_RESULTS: 50, // 搜索最多返回 50 条
  MAX_LIST_DEPTH: 5, // 列目录最大深度
  DEFAULT_LIST_DEPTH: 1, // 默认列目录深度
};

/** 二进制文件扩展名 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.svg',
  '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.class',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.avi', '.mov', '.wav',
  '.pyc', '.pyo',
  '.node',
]);

/** 目录条目 */
export interface DirEntry {
  name: string;
  path: string; // 相对路径
  isDirectory: boolean;
  children?: DirEntry[];
}

/** 搜索结果 */
export interface SearchResult {
  filePath: string; // 相对路径
  line: number;
  content: string;
}

export class FsService {
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  /** 列出目录，支持递归深度 */
  async listDir(dirPath: string, maxDepth: number): Promise<DirEntry[]> {
    const depth = Math.min(maxDepth, FILE_CONFIG.MAX_LIST_DEPTH);
    return this.listDirRecursive(dirPath, dirPath, depth, 0);
  }

  private async listDirRecursive(
    basePath: string,
    currentPath: string,
    maxDepth: number,
    currentDepth: number,
  ): Promise<DirEntry[]> {
    const entries: DirEntry[] = [];
    let dirents: Dirent[];

    try {
      dirents = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return entries;
    }

    // 排序：目录在前，文件在后，字母序
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    for (const dirent of dirents) {
      const fullPath = path.join(currentPath, dirent.name);
      const relativePath = path.relative(basePath, fullPath) || '.';

      const entry: DirEntry = {
        name: dirent.name,
        path: relativePath,
        isDirectory: dirent.isDirectory(),
      };

      if (dirent.isDirectory() && currentDepth + 1 < maxDepth) {
        entry.children = await this.listDirRecursive(
          basePath,
          fullPath,
          maxDepth,
          currentDepth + 1,
        );
      }

      entries.push(entry);
    }

    return entries;
  }

  /** 读取文件内容，支持 offset/limit 分段 */
  async readFile(filePath: string, offset?: number, limit?: number): Promise<string> {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    const start = offset ? offset - 1 : 0; // offset 从 1 开始
    const end = limit ? start + limit : lines.length;

    return lines.slice(start, end).join('\n');
  }

  /** 写入文件，自动创建父目录 */
  async writeFile(filePath: string, content: string): Promise<void> {
    const parentDir = path.dirname(filePath);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /** 搜索文件内容（基于 ripgrep） */
  async searchByRegex(
    searchPath: string,
    pattern: RegExp,
    maxResults: number,
  ): Promise<SearchResult[]> {
    // ripgrep 用 RE2 语法，需要把 JS 正则转换为字符串
    // 去掉 flags 中的 g，ripgrep 默认搜索所有行
    const patternStr = pattern.source;

    const args = [
      '--json',
      '--no-heading',
      '--line-number',
      '--max-count', String(maxResults),
      patternStr,
      searchPath,
    ];

    let stdout: string;
    try {
      const result = await execFileAsync(rgPath, args, { maxBuffer: 10 * 1024 * 1024 });
      stdout = result.stdout;
    } catch (err) {
      // ripgrep 返回非 0 可能是没找到匹配（exit code 1），不是错误
      const exitCode = (err as { code?: number }).code;
      if (exitCode === 1) {
        return []; // 没找到匹配
      }
      // 其他错误，抛出
      throw new Error(`ripgrep 执行失败: ${(err as Error).message}`);
    }

    const results: SearchResult[] = [];
    const lines = stdout.trim().split('\n');

    for (const line of lines) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'match') {
          const match = obj.data;
          const absPath = match.path.text;
          const relativePath = path.relative(this.projectRoot, absPath);
          results.push({
            filePath: relativePath,
            line: match.line_number,
            content: match.lines.text.trimEnd(),
          });
        }
      } catch {
        // 跳过解析失败的行
      }
    }

    return results;
  }

  /** 文件是否存在 */
  async fileExists(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /** 路径是否是目录 */
  async isDirectory(p: string): Promise<boolean> {
    try {
      const stat = await fs.stat(p);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  /** 获取文件大小（字节） */
  async getFileSize(filePath: string): Promise<number> {
    const stat = await fs.stat(filePath);
    return stat.size;
  }

  /** 判断是否是二进制文件 */
  isBinaryFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
  }

  /** 获取相对路径 */
  getRelativePath(absPath: string): string {
    return path.relative(this.projectRoot, absPath);
  }
}
