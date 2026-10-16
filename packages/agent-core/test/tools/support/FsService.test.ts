import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsService } from '../../../src/tools/support/FsService';

describe('FsService', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'fsservice-test-'));
  const svc = new FsService(sandbox);

  beforeAll(() => {
    writeFileSync(join(sandbox, 'a.txt'), 'hello\nworld\n');
    mkdirSync(join(sandbox, 'sub'));
    writeFileSync(join(sandbox, 'sub', 'b.txt'), 'target word here\n');
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('depth=1 列出全部条目', async () => {
    const depth1 = await svc.listDir(sandbox, 1);
    expect(depth1).toHaveLength(2);
    expect(depth1[0].name).toBe('sub');
    expect(depth1[0].isDirectory).toBe(true);
  });

  it('depth=1 不展开子目录', async () => {
    const depth1 = await svc.listDir(sandbox, 1);
    expect(depth1.find((e) => e.name === 'sub')?.children).toBeUndefined();
  });

  it('depth=2 展开子目录', async () => {
    const depth2 = await svc.listDir(sandbox, 2);
    expect(depth2.find((e) => e.name === 'sub')?.children?.[0]?.name).toBe('b.txt');
  });

  it('readFile 全文读取', async () => {
    expect(await svc.readFile(join(sandbox, 'a.txt'))).toBe('hello\nworld\n');
  });

  it('readFile offset/limit 分段', async () => {
    expect(await svc.readFile(join(sandbox, 'a.txt'), 2, 1)).toBe('world');
  });

  it('writeFile 自动创建父目录', async () => {
    await svc.writeFile(join(sandbox, 'gen', 'new.txt'), 'made by fs');
    expect(existsSync(join(sandbox, 'gen', 'new.txt'))).toBe(true);
  });

  it('searchByRegex 命中相对路径与行号', async () => {
    const hits = await svc.searchByRegex(sandbox, /target\s+word/, 50);
    expect(hits).toHaveLength(1);
    expect(hits[0].filePath).toBe('sub/b.txt');
    expect(hits[0].line).toBe(1);
  });

  it('无匹配返回空数组而非抛错', async () => {
    const none = await svc.searchByRegex(sandbox, /absolutely-no-match-xyz/, 50);
    expect(none).toHaveLength(0);
  });

  it('fileExists 文件存在', async () => {
    expect(await svc.fileExists(join(sandbox, 'a.txt'))).toBe(true);
  });

  it('fileExists 目录返回 false', async () => {
    expect(await svc.fileExists(join(sandbox, 'sub'))).toBe(false);
  });

  it('fileExists 缺失返回 false', async () => {
    expect(await svc.fileExists(join(sandbox, 'nope.txt'))).toBe(false);
  });

  it('isDirectory 目录为 true', async () => {
    expect(await svc.isDirectory(join(sandbox, 'sub'))).toBe(true);
  });

  it('getFileSize 字节数', async () => {
    expect(await svc.getFileSize(join(sandbox, 'a.txt'))).toBe(12);
  });

  it('isBinaryFile 识别图片', () => {
    expect(svc.isBinaryFile(join(sandbox, 'x.png'))).toBe(true);
  });

  it('isBinaryFile 放过文本', () => {
    expect(svc.isBinaryFile(join(sandbox, 'x.txt'))).toBe(false);
  });

  it('getRelativePath 相对根', () => {
    expect(svc.getRelativePath(join(sandbox, 'sub', 'b.txt'))).toBe('sub/b.txt');
  });
});
