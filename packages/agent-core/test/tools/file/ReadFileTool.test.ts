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
    // 形状校验由基类统一承担：错误含参数名（required 类错误路径为空，message 自带参数名）
    expect(noParam.error).toContain('参数校验失败');
    expect(noParam.error).toContain('file_path');
  });

  it('file_path 空字符串报错', async () => {
    const empty = await exec({ file_path: '' });
    expect(empty.success).toBe(false);
    expect(empty.error).toContain('参数校验失败');
    expect(empty.error).toContain('/file_path');
  });

  it('offset 非正整数报错', async () => {
    const bad = await exec({ file_path: 'a.txt', offset: 0 });
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('参数校验失败');
    expect(bad.error).toContain('/offset');
  });

  it('路径越界被拦截', async () => {
    const escape = await exec({ file_path: '../outside.txt' });
    expect(escape.success).toBe(false);
  });

  it('offset 分段读取行号正确', async () => {
    const read = await exec({ file_path: 'a.txt', offset: 2 });
    expect(read.success).toBe(true);
    // 从第 2 行开始，行号前缀为 2
    expect(read.content).toContain('2 | world');
  });
});
