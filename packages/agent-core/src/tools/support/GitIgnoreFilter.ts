/**
 * .gitignore 过滤器
 *
 * 使用 `ignore` 包解析项目根目录的 .gitignore 文件，
 * 提供统一的忽略判断能力。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import ignoreModule from 'ignore';

// NodeNext 建模差异：ignore 是 CJS 包且 d.ts 使用 export default，
// 默认导入被建模为模块命名空间；运行时 module.exports.default 即工厂函数本身
const ignore = ignoreModule.default;

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
