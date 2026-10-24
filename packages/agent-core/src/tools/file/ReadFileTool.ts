/**
 * read_file 工具 - 读取文件内容
 *
 * 设计要点：
 * - 拒绝二进制文件（避免 LLM 接收乱码内容导致理解偏差）
 * - 大文件强制分段：超过 100KB 且无 offset 时拒绝，提示用 offset/limit 分段
 * - 返回结果带行号，方便后续 edit_file 定位
 */

import Type from 'typebox';
import { BaseTool } from '../base.js';
import type { ToolResult, ToolContext } from '@code-agent/contracts';
import { PathGuard, PathGuardError } from '../support/PathGuard.js';
import { FsService, FILE_CONFIG } from '../support/FsService.js';

/** 参数 schema：唯一事实来源（发 LLM 的 JSON Schema、run 参数类型、运行时校验共用） */
const readFileParams = Type.Object({
  file_path: Type.String({ minLength: 1, description: '相对项目根目录的文件路径' }),
  offset: Type.Optional(
    Type.Integer({ minimum: 1, description: '起始行号（从 1 开始），默认从第 1 行开始' }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: '读取行数，默认读取全部' })),
});

export class ReadFileTool extends BaseTool<typeof readFileParams> {
  name = 'read_file';
  description = '读取文件内容并显示行号。大文件需要分段读取。';
  readonly parameters = readFileParams;
  requiresConfirmation = false;

  /** 路径安全校验（防逃逸、防符号链接穿越） */
  private pathGuard: PathGuard;
  /** 底层文件操作封装 */
  private fsService: FsService;

  constructor(projectPath: string) {
    super();
    this.pathGuard = new PathGuard(projectPath);
    this.fsService = new FsService(projectPath);
  }

  protected async run(
    params: Type.Static<typeof readFileParams>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    const { file_path: filePath, offset, limit } = params;

    // 校验路径（语义校验：依赖运行时项目根，保留在 run 内）
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

    // 检查是否是二进制文件
    if (this.fsService.isBinaryFile(absPath)) {
      return this.error(`不支持读取二进制文件: ${filePath}`);
    }

    // 检查文件大小
    const fileSize = await this.fsService.getFileSize(absPath);
    if (fileSize > FILE_CONFIG.MAX_FILE_SIZE_READ && !offset) {
      return this.error(
        `文件过大 (${(fileSize / 1024).toFixed(1)}KB)，请使用 offset 和 limit 参数分段读取`,
      );
    }

    // 读取文件
    const content = await this.fsService.readFile(absPath, offset, limit);
    const lines = content.split('\n');

    // 添加行号
    const startLine = offset ?? 1;
    const numberedLines = lines.map((line, i) => `${String(startLine + i).padStart(6)} | ${line}`);

    return this.success(numberedLines.join('\n'));
  }
}
