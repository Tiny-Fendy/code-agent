import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditFileTool } from '../../../src/tools/file/EditFileTool';

describe('EditFileTool', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'editfile-test-'));
  const tool = new EditFileTool(sandbox);
  const ctx = { projectPath: sandbox } as any;
  const exec = (params: any) => tool.execute(params, ctx);

  beforeAll(() => {
    writeFileSync(join(sandbox, 'a.txt'), 'hello\nworld\n');
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('精确替换成功', async () => {
    const edit = await exec({ file_path: 'a.txt', old_string: 'world', new_string: 'there' });
    expect(edit.success).toBe(true);
    expect(readFileSync(join(sandbox, 'a.txt'), 'utf8')).toContain('there');
  });

  it('找不到目标串报错', async () => {
    const miss = await exec({ file_path: 'a.txt', old_string: '不存在的串', new_string: 'x' });
    expect(miss.success).toBe(false);
  });

  it('缺 old_string 参数报错', async () => {
    const noOld = await exec({ file_path: 'a.txt', new_string: 'x' });
    expect(noOld.success).toBe(false);
  });
});
