import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunCommandTool } from '../../../src/tools/shell/RunCommandTool';

describe('RunCommandTool', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'runcommand-test-'));
  const tool = new RunCommandTool(sandbox);
  const ctx = { projectPath: sandbox } as any;
  const exec = (params: any) => tool.execute(params, ctx);

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('正常命令返回输出与退出码', async () => {
    const ok = await exec({ command: 'echo hi' });
    expect(ok.success).toBe(true);
    expect(ok.content).toContain('hi');
    expect(ok.content).toContain('退出码: 0');
  });

  it('非零退出码作为观察结果返回（非 error）', async () => {
    const nonzero = await exec({ command: 'exit 3' });
    expect(nonzero.success).toBe(true);
    expect(nonzero.content).toContain('退出码: 3');
  });

  it('空命令拒绝执行', async () => {
    const empty = await exec({ command: '' });
    expect(empty.success).toBe(false);
  });

  it('cwd 越界被拦截', async () => {
    const escape = await exec({ command: 'echo hi', cwd: '../../' });
    expect(escape.success).toBe(false);
  });

  it('超时命令被终止并标注', async () => {
    const t0 = Date.now();
    const timeout = await exec({ command: 'sleep 3', timeout_ms: 300 });
    expect(timeout.success).toBe(true);
    expect(timeout.content).toContain('命令超时');
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
