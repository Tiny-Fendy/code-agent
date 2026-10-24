/**
 * search_by_regex 工具 - 按正则表达式搜索文件内容
 *
 * 基于 ripgrep 实现，跳过 .gitignore 内容。
 *
 * 设计要点：
 * - JS 正则直接转 ripgrep 语法（去掉 g flag），不强制用户学习 ripgrep 语法
 * - 结果按 `文件:行号:内容` 格式输出，方便 LLM 下一步用 read_file 或 edit_file 操作
 * - 超过 max_results 时尾部提示截断，防止回灌内容撑爆上下文
 */

import Type from 'typebox';
import { BaseTool } from '../base.js';
import type { ToolResult, ToolContext } from '@code-agent/contracts';
import { PathGuard, PathGuardError } from '../support/PathGuard.js';
import { FsService, FILE_CONFIG } from '../support/FsService.js';

/** 参数 schema：唯一事实来源 */
const searchByRegexParams = Type.Object({
  pattern: Type.String({ minLength: 1, description: '正则表达式模式' }),
  search_path: Type.Optional(
    Type.String({ description: '搜索的子目录（相对项目根目录），默认搜索整个项目' }),
  ),
  max_results: Type.Optional(
    Type.Integer({ minimum: 1, description: `最大返回结果数，默认 ${FILE_CONFIG.MAX_SEARCH_RESULTS}` }),
  ),
});

export class SearchByRegexTool extends BaseTool<typeof searchByRegexParams> {
  name = 'search_by_regex';
  description = '在项目中搜索匹配正则表达式的内容。返回文件路径、行号和匹配行。';
  readonly parameters = searchByRegexParams;
  requiresConfirmation = false;

  /** 路径安全校验（防逃逸、防符号链接穿越） */
  private pathGuard: PathGuard;
  /** 底层文件操作封装（含 ripgrep 搜索） */
  private fsService: FsService;

  constructor(projectPath: string) {
    super();
    this.pathGuard = new PathGuard(projectPath);
    this.fsService = new FsService(projectPath);
  }

  protected async run(
    params: Type.Static<typeof searchByRegexParams>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    const { pattern } = params;
    const searchPath = params.search_path || '.';
    const maxResults = params.max_results ?? FILE_CONFIG.MAX_SEARCH_RESULTS;

    // 编译正则（语义校验：正则合法性无法由 schema 表达）
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      return this.error(`无效的正则表达式: ${(err as Error).message}`);
    }

    // 校验搜索路径
    let absPath: string;
    try {
      absPath = await this.pathGuard.resolveAndValidate(searchPath);
    } catch (err) {
      return this.error((err as PathGuardError).message);
    }

    // 执行搜索
    let results;
    try {
      results = await this.fsService.searchByRegex(absPath, regex, maxResults);
    } catch (err) {
      return this.error(`搜索失败: ${(err as Error).message}`);
    }

    if (results.length === 0) {
      return this.success('没有找到匹配的内容');
    }

    // 格式化输出
    const output = results
      .map(r => `${r.filePath}:${r.line}: ${r.content}`)
      .join('\n');

    const truncated = results.length >= maxResults
      ? `\n\n... (结果已截断，最多显示 ${maxResults} 条，请缩小搜索范围)`
      : '';

    return this.success(output + truncated);
  }
}
