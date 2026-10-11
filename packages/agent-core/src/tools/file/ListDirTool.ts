/**
 * list_dir 工具 - 列出目录结构
 */

import { BaseTool } from '../base';
import type { ToolResult, ToolContext } from '@code-agent/shared';
import { PathGuard, PathGuardError } from './PathGuard';
import { FsService, FILE_CONFIG, type DirEntry } from './FsService';
import { GitIgnoreFilter } from './gitignore';

export class ListDirTool extends BaseTool {
  name = 'list_dir';
  description = '列出指定目录下的文件和子目录。不传参数时列出项目根目录。';
  parameters = {
    type: 'object',
    properties: {
      dir_path: {
        type: 'string',
        description: '相对项目根目录的目录路径，不传则列出项目根目录',
      },
      max_depth: {
        type: 'number',
        description: `递归深度，默认 ${FILE_CONFIG.DEFAULT_LIST_DEPTH}，最大 ${FILE_CONFIG.MAX_LIST_DEPTH}`,
      },
    },
  };
  requiresConfirmation = false;

  private pathGuard: PathGuard;
  private fsService: FsService;
  private gitIgnore: GitIgnoreFilter;

  constructor(projectPath: string) {
    super();
    this.pathGuard = new PathGuard(projectPath);
    this.fsService = new FsService(projectPath);
    this.gitIgnore = new GitIgnoreFilter(projectPath);
    this.gitIgnore.load();
  }

  async execute(params: Record<string, any>, _context: ToolContext): Promise<ToolResult> {
    const dirPath = (params.dir_path as string) || '.';
    const maxDepth = (params.max_depth as number) ?? FILE_CONFIG.DEFAULT_LIST_DEPTH;

    // 校验路径
    let absPath: string;
    try {
      absPath = await this.pathGuard.resolveAndValidate(dirPath);
    } catch (err) {
      return this.error((err as PathGuardError).message);
    }

    // 检查是否是目录
    if (!(await this.fsService.isDirectory(absPath))) {
      return this.error(`"${dirPath}" 不是一个目录`);
    }

    // 列出目录
    const entries = await this.fsService.listDir(absPath, maxDepth);

    // 过滤 .gitignore
    const filtered = this.filterEntries(entries, dirPath === '.' ? '' : dirPath);

    // 格式化为树形文本
    const output = this.formatTree(filtered);

    if (output.trim() === '') {
      return this.success(`(空目录)`);
    }

    return this.success(output);
  }

  private filterEntries(entries: DirEntry[], baseRelPath: string): DirEntry[] {
    return entries
      .filter(entry => {
        const relPath = baseRelPath
          ? `${baseRelPath}/${entry.path}`
          : entry.path;
        return !this.gitIgnore.isIgnored(relPath);
      })
      .map(entry => ({
        ...entry,
        children: entry.children
          ? this.filterEntries(
              entry.children,
              baseRelPath ? `${baseRelPath}/${entry.path}` : entry.path,
            )
          : undefined,
      }));
  }

  private formatTree(entries: DirEntry[], prefix = ''): string {
    let output = '';
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const name = entry.isDirectory ? `${entry.name}/` : entry.name;

      output += `${prefix}${connector}${name}\n`;

      if (entry.children && entry.children.length > 0) {
        const childPrefix = prefix + (isLast ? '    ' : '│   ');
        output += this.formatTree(entry.children, childPrefix);
      }
    }
    return output;
  }
}
