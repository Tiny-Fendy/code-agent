/**
 * write_file 工具 - 创建新文件或完全覆盖已有文件
 *
 * 与 edit_file 的分工：
 * - write_file：全新写入或整文件覆盖（requiresConfirmation=true，覆盖会丢数据，必须用户确认）
 * - edit_file：局部搜索替换，保留文件其余内容不变
 *
 * 安全设计：自动创建父目录（mkdir -p），但仍需 PathGuard 校验不逃逸出项目。
 */

import { BaseTool } from '../base';
import type { ToolResult, ToolContext } from '@code-agent/shared';
import { PathGuard, PathGuardError } from '../support/PathGuard';
import { FsService } from '../support/FsService';

export class WriteFileTool extends BaseTool {
  name = 'write_file';
  description = '创建新文件或完全覆盖已有文件。会自动创建不存在的父目录。';
  parameters = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '相对项目根目录的文件路径',
      },
      content: {
        type: 'string',
        description: '要写入的文件内容',
      },
    },
    required: ['file_path', 'content'],
  };
  /** 整文件覆盖是高危操作，必须用户确认 */
  requiresConfirmation = true;

  /** 路径安全校验（防逃逸、防符号链接穿越） */
  private pathGuard: PathGuard;
  /** 底层文件操作封装 */
  private fsService: FsService;

  constructor(projectPath: string) {
    super();
    this.pathGuard = new PathGuard(projectPath);
    this.fsService = new FsService(projectPath);
  }

  async execute(params: Record<string, any>, _context: ToolContext): Promise<ToolResult> {
    const filePath = params.file_path as string;
    const content = params.content as string;

    if (!filePath) {
      return this.error('file_path 参数不能为空');
    }
    if (content === undefined) {
      return this.error('content 参数不能为空');
    }

    // 校验路径
    let absPath: string;
    try {
      absPath = await this.pathGuard.resolveAndValidate(filePath);
    } catch (err) {
      return this.error((err as PathGuardError).message);
    }

    // 写入文件
    try {
      await this.fsService.writeFile(absPath, content);
    } catch (err) {
      return this.error(`写入文件失败: ${(err as Error).message}`);
    }

    return this.success(`文件已写入: ${filePath}`);
  }
}
