/**
 * list_dir 工具 - 列出目录结构
 *
 * 输出树形文本（├── └── 风格），并按 .gitignore 过滤，
 * 避免 node_modules 等噪音目录撑爆上下文。
 */

import { BaseTool } from '../base';
import type { ToolResult, ToolContext } from '@code-agent/shared';
import { PathGuard, PathGuardError } from '../support/PathGuard';
import { FsService, FILE_CONFIG, type DirEntry } from '../support/FsService';
import { GitIgnoreFilter } from '../support/GitIgnoreFilter';

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

  /** 路径安全校验（防逃逸、防符号链接穿越） */
  private pathGuard: PathGuard;
  /** 底层文件操作封装 */
  private fsService: FsService;
  /** .gitignore 过滤 */
  private gitIgnore: GitIgnoreFilter;

  constructor(projectPath: string) {
    super();
    this.pathGuard = new PathGuard(projectPath);
    this.fsService = new FsService(projectPath);
    this.gitIgnore = new GitIgnoreFilter(projectPath);
    // 异步加载 .gitignore，故意不 await：默认忽略项（.git）已同步注册，
    // .gitignore 规则短暂延迟生效可接受（首次工具调用前通常已完成）
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

  /**
   * 递归过滤被 .gitignore 忽略的条目
   *
   * 过滤基于相对项目根的完整路径（baseRelPath 拼接），
   * 否则子目录里的同名文件会错误命中/漏掉根级规则。
   */
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

  /**
   * 格式化为树形文本（├── / └── 风格）
   *
   * @param prefix 父级传递下来的缩进前缀；最后一个子级的子树用空格缩进，
   *               其余用 │ 保持竖线连续
   */
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
