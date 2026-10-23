/**
 * 设置领域逻辑：表单值 ↔ AppConfig 映射（纯函数，可独立单测）
 *
 * 表单采用扁平字段（baseUrl/apiKey/...），与配置对象的两层结构解耦：
 * 组件不必关心 AppConfig 的嵌套形状，映射规则集中在此。
 */

import type { AppConfig } from '@code-agent/contracts';

/** 设置表单的扁平字段（与 AppConfig.api 一一对应） */
export interface AppConfigFormValues {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/** 配置对象 → 表单值（打开弹窗时回填） */
export function toFormValues(config: AppConfig): AppConfigFormValues {
  return {
    baseUrl: config.api.baseUrl,
    apiKey: config.api.apiKey,
    model: config.api.model,
    temperature: config.api.temperature,
    maxTokens: config.api.maxTokens,
  };
}

/** 表单值 → 配置对象（保存/测试连接时提交） */
export function toAppConfig(values: AppConfigFormValues): AppConfig {
  return {
    api: {
      baseUrl: values.baseUrl.trim(),
      apiKey: values.apiKey.trim(),
      model: values.model.trim(),
      temperature: values.temperature,
      maxTokens: values.maxTokens,
    },
  };
}
