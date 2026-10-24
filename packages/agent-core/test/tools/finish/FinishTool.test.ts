import { describe, it, expect } from 'vitest';
import { FinishTool } from '@/tools/finish';

describe('FinishTool', () => {
  const tool = new FinishTool();
  const mockContext = { projectPath: '/tmp/test' };

  it('正常 summary 返回 success', async () => {
    const result = await tool.execute({ summary: '任务完成，共修改 3 个文件' }, mockContext);
    expect(result.success).toBe(true);
    expect(result.content).toBe('任务完成，共修改 3 个文件');
  });

  it('空 summary 返回 error', async () => {
    const result = await tool.execute({ summary: '' }, mockContext);
    expect(result.success).toBe(false);
    // 形状校验由基类 schema 层承担，错误为结构化英文
    expect(result.error).toContain('参数校验失败');
    expect(result.error).toContain('/summary');
  });

  it('缺失 summary 返回 error', async () => {
    const result = await tool.execute({}, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('参数校验失败');
    expect(result.error).toContain('summary');
  });

  it('空白字符 summary 返回 error', async () => {
    // trim 后空白属语义校验，由 run 内承担
    const result = await tool.execute({ summary: '   \n\t  ' }, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('非空');
  });

  it('工具元数据正确', () => {
    expect(tool.name).toBe('finish');
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.parameters.required).toContain('summary');
  });
});
