import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteFileTool } from '@/tools/file/WriteFileTool';

describe('WriteFileTool', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'writefile-test-'));
  const tool = new WriteFileTool(sandbox);
  const ctx = { projectPath: sandbox } as any;
  const exec = (params: any) => tool.execute(params, ctx);

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('写入成功且自动创建父目录', async () => {
    const write = await exec({ file_path: 'deep/new.txt', content: 'written' });
    expect(write.success).toBe(true);
    expect(readFileSync(join(sandbox, 'deep', 'new.txt'), 'utf8')).toBe('written');
  });

  it('缺 file_path 参数报错', async () => {
    const noPath = await exec({ content: 'x' });
    expect(noPath.success).toBe(false);
  });

  it('缺 content 参数报错', async () => {
    const noContent = await exec({ file_path: 'b.txt' });
    expect(noContent.success).toBe(false);
  });
});
