/**
 * edit_file 工具 - 搜索替换式编辑文件
 *
 * 通过 old_string 和 new_string 进行精确匹配替换。
 * 参考 Claude Code 的 Edit 工具设计。
 *
 * 设计要点：
 * - 多处匹配时强制报错（要求用户提供更长的上下文使匹配唯一，或设 replace_all）：
 *   避免 LLM 未意识到同一段文本有多处出现，导致误替换。
 * - requiresConfirmation=true：文件编辑是高危操作，必须用户确认。
 */

import { BaseTool } from '../base';
import type { ToolResult, ToolContext } from '@code-agent/contracts';
import { PathGuard, PathGuardError } from '../support/PathGuard';
import { FsService } from '../support/FsService';

export class EditFileTool extends BaseTool {
  name = 'edit_file';
  description =
    '通过搜索替换的方式编辑文件。提供要替换的原始字符串 (old_string) 和新字符串 (new_string)。' +
    '如果 old_string 有多处匹配，需要设置 replace_all=true。';
  parameters = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '相对项目根目录的文件路径',
      },
      old_string: {
        type: 'string',
        description: '要搜索替换的原始字符串',
      },
      new_string: {
        type: 'string',
        description: '替换后的新字符串',
      },
      replace_all: {
        type: 'boolean',
        description: '是否替换所有匹配项，默认 false（只替换第一个）',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  };
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
    const oldString = params.old_string as string;
    const newString = params.new_string as string;
    const replaceAll = (params.replace_all as boolean) ?? false;

    if (!filePath) return this.error('file_path 参数不能为空');
    if (!oldString) return this.error('old_string 参数不能为空');
    if (newString === undefined) return this.error('new_string 参数不能为空');

    // 校验路径
    let absPath: string;
    try {
      absPath = await this.pathGuard.resolveAndValidate(filePath);
    } catch (err) {
      return this.error((err as PathGuardError).message);
    }

    // 检查文件是否存在
    if (!(await this.fsService.fileExists(absPath))) {
      return this.error(`文件不存在: ${filePath}`);
    }

    // 读取文件内容
    let content: string;
    try {
      content = await this.fsService.readFile(absPath);
    } catch (err) {
      return this.error(`读取文件失败: ${(err as Error).message}`);
    }

    // 检查匹配情况
    const matchCount = this.countOccurrences(content, oldString);

    if (matchCount === 0) {
      return this.error(`未在文件中找到 old_string，请检查字符串是否完全匹配（包括空格和缩进）`);
    }

    if (matchCount > 1 && !replaceAll) {
      return this.error(
        `old_string 在文件中有 ${matchCount} 处匹配，不明确要替换哪一处。` +
          `请提供更长的上下文使匹配唯一，或设置 replace_all=true 替换所有匹配。`,
      );
    }

    // 执行替换
    const newContent = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    // 写回文件
    try {
      await this.fsService.writeFile(absPath, newContent);
    } catch (err) {
      return this.error(`写入文件失败: ${(err as Error).message}`);
    }

    return this.success(
      `已编辑文件: ${filePath}\n替换了 ${matchCount} 处匹配`,
    );
  }

  /** 统计字符串出现次数 */
  private countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
      count++;
      pos += needle.length;
    }
    return count;
  }
}
