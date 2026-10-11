/**
 * write_file 工具 - 创建新文件或完全覆盖已有文件
 */

import { BaseTool } from '../base';
import type { ToolResult, ToolContext } from '@code-agent/shared';
import { PathGuard, PathGuardError } from './PathGuard';
import { FsService } from './FsService';

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
  requiresConfirmation = true;

  private pathGuard: PathGuard;
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
