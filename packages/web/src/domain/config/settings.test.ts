/**
 * 设置领域逻辑单测
 *
 * 覆盖：配置 → 表单回填、表单 → 配置提交（含首尾空白裁剪）、往返一致性。
 */

import { describe, it, expect } from 'vitest';
import type { AppConfig } from '@code-agent/contracts';
import { toFormValues, toAppConfig, type AppConfigFormValues } from './settings';

const config: AppConfig = {
  api: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 4096,
  },
};

const formValues: AppConfigFormValues = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 4096,
};

describe('toFormValues', () => {
  it('把嵌套配置拍平成表单字段', () => {
    expect(toFormValues(config)).toEqual(formValues);
  });
});

describe('toAppConfig', () => {
  it('把表单字段还原为两层配置结构', () => {
    expect(toAppConfig(formValues)).toEqual(config);
  });

  it('提交前裁剪字符串首尾空白', () => {
    const result = toAppConfig({
      ...formValues,
      baseUrl: '  https://example.com/v1  ',
      apiKey: '  sk-abc  ',
      model: '  gpt-4o  ',
    });
    expect(result.api.baseUrl).toBe('https://example.com/v1');
    expect(result.api.apiKey).toBe('sk-abc');
    expect(result.api.model).toBe('gpt-4o');
  });

  it('数值字段原样保留（含 0 温度）', () => {
    const result = toAppConfig({ ...formValues, temperature: 0, maxTokens: 1 });
    expect(result.api.temperature).toBe(0);
    expect(result.api.maxTokens).toBe(1);
  });
});

describe('往返一致性', () => {
  it('config → form → config 不丢信息', () => {
    expect(toAppConfig(toFormValues(config))).toEqual(config);
  });
});
