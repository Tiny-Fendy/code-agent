import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListDirTool } from '../../../src/tools/file/ListDirTool';

describe('ListDirTool', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'listdir-test-'));
  const tool = new ListDirTool(sandbox);
  const ctx = { projectPath: sandbox } as any;

  beforeAll(() => {
    writeFileSync(join(sandbox, 'a.txt'), 'hello\n');
    mkdirSync(join(sandbox, 'sub'));
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('默认列出项目根', async () => {
    const list = await tool.execute({}, ctx);
    expect(list.success).toBe(true);
    expect(list.content).toContain('a.txt');
    expect(list.content).toContain('sub');
  });

  it('路径越界被拦截', async () => {
    const escape = await tool.execute({ dir_path: '../../etc' }, ctx);
    expect(escape.success).toBe(false);
  });
});
