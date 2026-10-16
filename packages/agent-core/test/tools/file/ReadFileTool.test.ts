import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadFileTool } from '@/tools/file/ReadFileTool';

describe('ReadFileTool', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'readfile-test-'));
  const tool = new ReadFileTool(sandbox);
  const ctx = { projectPath: sandbox } as any;
  const exec = (params: any) => tool.execute(params, ctx);

  beforeAll(() => {
    writeFileSync(join(sandbox, 'a.txt'), 'hello\nworld\n');
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('读取文件内容', async () => {
    const read = await exec({ file_path: 'a.txt' });
    expect(read.success).toBe(true);
    expect(read.content).toContain('hello');
    expect(read.content).toContain('world');
  });

  it('文件缺失报错', async () => {
    const missing = await exec({ file_path: 'nope.txt' });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('文件不存在');
  });

  it('缺 file_path 参数报错', async () => {
    const noParam = await exec({});
    expect(noParam.success).toBe(false);
  });

  it('路径越界被拦截', async () => {
    const escape = await exec({ file_path: '../outside.txt' });
    expect(escape.success).toBe(false);
  });
});
