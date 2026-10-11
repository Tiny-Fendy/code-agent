/**
 * .gitignore 过滤器
 *
 * 使用 `ignore` 包解析项目根目录的 .gitignore 文件，
 * 提供统一的忽略判断能力。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import ignore from 'ignore';

export class GitIgnoreFilter {
  private ig: ReturnType<typeof ignore>;
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.ig = ignore();
    this.ig.add(['.git']);
  }

  /** 异步加载 .gitignore 文件 */
  async load(): Promise<void> {
    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    try {
      const content = await fs.readFile(gitignorePath, 'utf-8');
      this.ig.add(content);
    } catch {
      // 没有 .gitignore 文件，不做额外过滤
    }
  }

  /**
   * 判断相对路径是否被忽略
   * @param relativePath 相对项目根目录的路径
   */
  isIgnored(relativePath: string): boolean {
    // 规范化路径分隔符为 /
    const normalized = relativePath.split(path.sep).join('/');
    return this.ig.ignores(normalized);
  }
}
