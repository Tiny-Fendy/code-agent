import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchByRegexTool } from '../../../src/tools/file/SearchByRegexTool';

describe('SearchByRegexTool', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'search-test-'));
  const tool = new SearchByRegexTool(sandbox);
  const ctx = { projectPath: sandbox } as any;
  const exec = (params: any) => tool.execute(params, ctx);

  beforeAll(() => {
    mkdirSync(join(sandbox, 'sub'));
    writeFileSync(join(sandbox, 'sub', 'b.txt'), 'target word here\n');
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('正则命中文件与内容', async () => {
    const search = await exec({ pattern: 'target\\s+word' });
    expect(search.success).toBe(true);
    expect(search.content).toContain('b.txt');
  });

  it('无匹配返回空结果', async () => {
    const none = await exec({ pattern: 'absolutely-no-match-xyz' });
    expect(none.success).toBe(true);
    expect(none.content).not.toContain('b.txt');
  });

  it('非法正则报错', async () => {
    const bad = await exec({ pattern: '([unclosed' });
    expect(bad.success).toBe(false);
  });
});
