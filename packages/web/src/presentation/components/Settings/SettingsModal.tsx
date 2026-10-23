/**
 * 设置面板
 *
 * 表单字段对齐 AppConfig 的 5 项；打开时回填、保存写回；
 * 「测试连接」先保存再探测，保证主进程探测的是当前表单值而不是旧配置。
 *
 * 薄组件：取值/映射规则来自 domain/config，读写与状态来自 settingsStore。
 */

import { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Modal, message } from 'antd';
import type { TestConnResult } from '@code-agent/contracts';
import { useSettingsStore } from '@/presentation/store/settingsStore';
import {
  toAppConfig,
  toFormValues,
  type AppConfigFormValues,
} from '@/domain/config/settings';

const { TextArea } = Input;

export default function SettingsModal() {
  const [form] = Form.useForm<AppConfigFormValues>();
  const open = useSettingsStore((s) => s.open);
  const config = useSettingsStore((s) => s.config);
  const saving = useSettingsStore((s) => s.saving);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const loadConfig = useSettingsStore((s) => s.loadConfig);
  const saveConfig = useSettingsStore((s) => s.saveConfig);
  const testConnection = useSettingsStore((s) => s.testConnection);

  /** 连接测试结果：内联展示，比 toast 更便于对照表单排查 */
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnResult | null>(null);

  // 每次打开都重新拉取配置，避免使用过期值（可能在别处被修改）
  useEffect(() => {
    if (!open) return;
    setTestResult(null);
    loadConfig().catch((err: unknown) => {
      message.error(`读取配置失败：${err instanceof Error ? err.message : String(err)}`);
    });
  }, [open, loadConfig]);

  // 配置到达后回填表单
  useEffect(() => {
    if (open && config) form.setFieldsValue(toFormValues(config));
  }, [open, config, form]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      await saveConfig(toAppConfig(values));
      message.success('设置已保存');
      closeSettings();
    } catch (err) {
      // validateFields 的校验失败不是异常提示场景（字段下方已有错误）
      if (err instanceof Error) message.error(`保存失败：${err.message}`);
    }
  };

  const handleTest = async () => {
    try {
      const values = await form.validateFields();
      setTesting(true);
      setTestResult(null);
      // 先落盘再探测：主进程的 testConnection 读取的是已保存配置
      await saveConfig(toAppConfig(values));
      setTestResult(await testConnection());
    } catch (err) {
      if (err instanceof Error) {
        setTestResult({ ok: false, error: err.message });
      }
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="设置"
      onCancel={closeSettings}
      width={560}
      maskClosable={false}
      footer={[
        <Button key="test" onClick={handleTest} loading={testing}>
          测试连接
        </Button>,
        <Button key="cancel" onClick={closeSettings}>
          取消
        </Button>,
        <Button key="save" type="primary" onClick={handleSave} loading={saving}>
          保存
        </Button>,
      ]}
    >
      <Form form={form} layout="vertical" className="settings-form" requiredMark={false}>
        <Form.Item
          label="接口地址"
          name="baseUrl"
          rules={[
            { required: true, message: '请输入接口地址' },
            { type: 'url', message: '请输入合法的 URL' },
          ]}
        >
          <Input placeholder="https://api.openai.com/v1" />
        </Form.Item>

        <Form.Item
          label="API Key"
          name="apiKey"
          rules={[{ required: true, message: '请输入 API Key' }]}
        >
          <Input.Password placeholder="sk-..." autoComplete="off" />
        </Form.Item>

        <Form.Item label="模型" name="model" rules={[{ required: true, message: '请输入模型名' }]}>
          <Input placeholder="gpt-4o-mini" />
        </Form.Item>

        <Form.Item label="温度" name="temperature" rules={[{ required: true, message: '请输入温度' }]}>
          <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item label="最大 Token" name="maxTokens" rules={[{ required: true, message: '请输入最大 Token' }]}>
          <InputNumber min={1} step={1} style={{ width: '100%' }} />
        </Form.Item>

        {testResult && (
          <Alert
            className="settings-test-result"
            type={testResult.ok ? 'success' : 'error'}
            showIcon
            message={testResult.ok ? '连接正常' : `连接失败：${testResult.error ?? '未知错误'}`}
          />
        )}
      </Form>
    </Modal>
  );
}
