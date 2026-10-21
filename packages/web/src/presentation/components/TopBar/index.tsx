/**
 * 顶栏：应用标识、运行环境标签、当前模型名、设置入口
 *
 * 自取数据：挂载时经 settingsStore 拉取配置（组件自治取数，不经 props 传递）。
 * 配置读取失败属轻量降级场景：仅模型名展示异常，不打断使用，故静默记录。
 */

import { useEffect } from 'react';
import { Button, Space, Tag, Typography } from 'antd';
import { CodeOutlined, SettingOutlined } from '@ant-design/icons';
import { IS_MOCK } from '@/infrastructure/bridge';
import { useSettingsStore } from '@/presentation/store/settingsStore';

const { Text, Title } = Typography;

export default function TopBar() {
  const config = useSettingsStore((s) => s.config);
  const loading = useSettingsStore((s) => s.loading);
  const loadConfig = useSettingsStore((s) => s.loadConfig);

  useEffect(() => {
    loadConfig().catch((err: unknown) => {
      console.error('读取配置失败', err);
    });
  }, [loadConfig]);

  const model = config?.api.model;
  const modelText = model ? `模型：${model}` : loading ? '模型加载中…' : '未配置模型';

  return (
    <header className="top-bar">
      <Space size={8}>
        <CodeOutlined style={{ fontSize: 20, color: '#12B886' }} />
        <Title level={5} style={{ margin: 0 }}>
          Code Agent
        </Title>
        <Tag color={IS_MOCK ? 'orange' : 'green'} style={{ marginInlineEnd: 0 }}>
          {IS_MOCK ? 'Mock' : 'Electron'}
        </Tag>
      </Space>

      <Space size={8}>
        <Text type="secondary">{modelText}</Text>
        {/* TODO(阶段④)：接入设置面板 Modal */}
        <Button type="text" icon={<SettingOutlined />} aria-label="设置" />
      </Space>
    </header>
  );
}
