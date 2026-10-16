import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolManager } from '../../src/tools/ToolManager';
import { BaseTool } from '../../src/tools/base';

class BombTool extends BaseTool {
  name = 'bomb';
  description = 'test';
  parameters = { type: 'object', properties: {} } as any;
  requiresConfirmation = false;
  async execute(): Promise<any> {
    throw new Error('boom');
  }
}

describe('ToolManager', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'toolmanager-test-'));
  const tm = new ToolManager(sandbox);
  const ctx = { projectPath: sandbox } as any;

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('构造时自动注册 6 个内置工具', () => {
    const defs = tm.getDefinitions();
    expect(defs).toHaveLength(6);
    const names = defs.map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining(['list_dir', 'read_file', 'search_by_regex', 'write_file', 'edit_file', 'run_command']),
    );
  });

  it('definition 均含 name/description 且带 JSON Schema 参数', () => {
    const defs = tm.getDefinitions();
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.parameters?.type).toBe('object');
    }
  });

  it('run_command 需要确认', () => {
    expect(tm.requiresConfirmation('run_command')).toBe(true);
  });

  it('read_file 不需要确认', () => {
    expect(tm.requiresConfirmation('read_file')).toBe(false);
  });

  it('未知工具确认查询返回 false', () => {
    expect(tm.requiresConfirmation('not_exist')).toBe(false);
  });

  it('执行未知工具返回错误结果', async () => {
    const missing = await tm.execute('not_exist', {}, ctx);
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('not_exist');
  });

  it('工具抛异常被捕获为 ToolResult', async () => {
    tm.register(new BombTool());
    const bombResult = await tm.execute('bomb', {}, ctx);
    expect(bombResult.success).toBe(false);
    expect(bombResult.error).toContain('boom');
    expect(tm.getDefinitions()).toHaveLength(7);
  });
});
