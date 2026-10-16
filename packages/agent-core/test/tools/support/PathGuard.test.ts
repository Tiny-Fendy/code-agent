import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathGuard, PathGuardError } from '../../../src/tools/support/PathGuard';

const expectError = async (p: Promise<unknown>, keyword: string) => {
  await expect(p).rejects.toThrowError(
    expect.objectContaining({
      constructor: PathGuardError,
      message: expect.stringContaining(keyword),
    }),
  );
};

describe('PathGuard', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'pathguard-test-'));
  const outside = join(tmpdir(), 'pathguard-test-outside.txt');
  const guard = new PathGuard(sandbox);

  beforeAll(() => {
    writeFileSync(join(sandbox, 'a.txt'), 'hello\n');
    mkdirSync(join(sandbox, 'symlinks'));
    symlinkSync(outside, join(sandbox, 'symlinks', 'out'));
    symlinkSync(join(sandbox, 'a.txt'), join(sandbox, 'symlinks', 'in'));
    writeFileSync(outside, 'outside');
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(outside, { force: true });
  });

  it('项目根已归一化（macOS 符号链接段）', () => {
    const realRoot = guard.getProjectRoot();
    expect(realRoot === sandbox || realRoot.startsWith('/private/')).toBe(true);
  });

  it('相对路径解析为真实绝对路径', async () => {
    const ok = await guard.resolveAndValidate('a.txt');
    expect(ok).toBe(join(guard.getProjectRoot(), 'a.txt'));
  });

  it('内部相对跳转允许', async () => {
    const ok = await guard.resolveAndValidate('sub/../a.txt');
    expect(ok).toBe(join(guard.getProjectRoot(), 'a.txt'));
  });

  it('相对路径越界被拒', () => expectError(guard.resolveAndValidate('../x'), '超出项目目录范围'));
  it('绝对路径越界被拒', () => expectError(guard.resolveAndValidate('/etc/hosts'), '超出项目目录范围'));
  it('.git 访问被拒', () => expectError(guard.resolveAndValidate('.git/config'), '禁止访问 .git'));
  it('空路径被拒', () => expectError(guard.resolveAndValidate(''), '路径不能为空'));

  it('不存在的路径走父目录校验后放行（写场景）', async () => {
    const notExist = await guard.resolveAndValidate('deep/new.txt');
    expect(notExist).toBe(join(guard.getProjectRoot(), 'deep', 'new.txt'));
  });

  it('指向项目外的符号链接被拒', () =>
    expectError(guard.resolveAndValidate('symlinks/out'), '符号链接指向项目外'));

  it('指向项目内的符号链接放行并解析到真实目标', async () => {
    const inside = await guard.resolveAndValidate('symlinks/in');
    expect(inside).toBe(join(guard.getProjectRoot(), 'a.txt'));
  });
});
