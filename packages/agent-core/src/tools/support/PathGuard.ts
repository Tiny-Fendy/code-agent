/**
 * 路径安全守卫
 *
 * 所有文件操作都必须经过 PathGuard 校验，确保：
 * 1. 路径不能逃出项目根目录（防路径穿越）
 * 2. 符号链接不能指向项目外
 * 3. 禁止访问 .git 目录
 */

import path from 'node:path';
import { promises as fs, realpathSync } from 'node:fs';

export class PathGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathGuardError';
  }
}

export class PathGuard {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    const absRoot = path.resolve(projectRoot);
    // 项目根也必须归一化：否则目标路径 realpath 后（如 /var/folders → /private/var/folders）
    // 与未解析的根前缀比对会误判为符号链接逃逸
    try {
      this.projectRoot = realpathSync(absRoot);
    } catch {
      this.projectRoot = absRoot; // 根目录尚不存在时退回 resolve 结果
    }
  }

  /**
   * 解析并校验路径
   * @param relativePath 相对项目根目录的路径
   * @returns 安全的绝对路径
   * @throws PathGuardError 路径不安全时抛出
   */
  async resolveAndValidate(relativePath: string): Promise<string> {
    if (!relativePath || typeof relativePath !== 'string') {
      throw new PathGuardError('路径不能为空');
    }

    // 解析为绝对路径
    const absPath = path.resolve(this.projectRoot, relativePath);

    // 检查是否在项目根目录内
    if (!this.isWithinProject(absPath)) {
      throw new PathGuardError(`路径 "${relativePath}" 超出项目目录范围`);
    }

    // 禁止访问 .git 目录
    if (this.isGitPath(absPath)) {
      throw new PathGuardError('禁止访问 .git 目录');
    }

    // 如果路径存在，解析符号链接后再次校验
    try {
      const realPath = await fs.realpath(absPath);
      if (!this.isWithinProject(realPath)) {
        throw new PathGuardError(`路径 "${relativePath}" 的符号链接指向项目外`);
      }
      return realPath;
    } catch (err) {
      // 路径不存在时（写文件场景），用父目录校验
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const parentDir = path.dirname(absPath);
        // 如果父目录存在，解析它的真实路径
        try {
          const realParent = await fs.realpath(parentDir);
          if (!this.isWithinProject(realParent)) {
            throw new PathGuardError(`路径 "${relativePath}" 的父目录指向项目外`);
          }
        } catch {
          // 父目录也不存在，用解析后的路径校验
          if (!this.isWithinProject(absPath)) {
            throw new PathGuardError(`路径 "${relativePath}" 超出项目目录范围`);
          }
        }
        return absPath;
      }
      // 其他错误重新抛出
      throw err;
    }
  }

  /** 检查路径是否在项目根目录内 */
  private isWithinProject(absPath: string): boolean {
    const normalizedRoot = this.projectRoot + path.sep;
    return absPath === this.projectRoot || absPath.startsWith(normalizedRoot);
  }

  /** 检查是否是 .git 目录下的路径 */
  private isGitPath(absPath: string): boolean {
    const gitDir = path.join(this.projectRoot, '.git');
    const normalizedGitDir = gitDir + path.sep;
    return absPath === gitDir || absPath.startsWith(normalizedGitDir);
  }

  /** 获取项目根目录 */
  getProjectRoot(): string {
    return this.projectRoot;
  }
}
