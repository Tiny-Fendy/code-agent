import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitIgnoreFilter } from '../../../src/tools/support/GitIgnoreFilter';

describe('GitIgnoreFilter', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'gitignore-test-'));

  beforeAll(() => {
    writeFileSync(join(sandbox, '.gitignore'), 'ignored.log\nnode_modules/\n!keep.log\n');
    mkdirSync(join(sandbox, 'sub'));
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('命中 .gitignore 规则', async () => {
    const filter = new GitIgnoreFilter(sandbox);
    await filter.load();
    expect(filter.isIgnored('ignored.log')).toBe(true);
  });

  it('目录规则匹配其下文件', async () => {
    const filter = new GitIgnoreFilter(sandbox);
    await filter.load();
    expect(filter.isIgnored('node_modules/x.js')).toBe(true);
  });

  it('取反规则生效', async () => {
    const filter = new GitIgnoreFilter(sandbox);
    await filter.load();
    expect(filter.isIgnored('keep.log')).toBe(false);
  });

  it('未命中规则不忽略', async () => {
    const filter = new GitIgnoreFilter(sandbox);
    await filter.load();
    expect(filter.isIgnored('src/app.ts')).toBe(false);
  });

  it('.git 始终忽略', async () => {
    const filter = new GitIgnoreFilter(sandbox);
    await filter.load();
    expect(filter.isIgnored('.git/config')).toBe(true);
  });

  it('无 .gitignore 时正常加载不忽略', async () => {
    const empty = new GitIgnoreFilter(join(sandbox, 'sub'));
    await empty.load();
    expect(empty.isIgnored('anything.txt')).toBe(false);
  });
});
