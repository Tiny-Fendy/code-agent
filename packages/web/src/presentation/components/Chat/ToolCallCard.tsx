/**
 * 工具调用卡片
 *
 * 展示工具名、参数摘要、执行状态（执行中 / 等待确认 / 成功 / 失败 / 已拒绝）、结果摘要。
 * 等待确认时渲染「允许 / 拒绝」按钮，点击后调用 confirmTool。
 */

import { Button, Card, Space, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { UIToolCall } from '@/domain/conversation';
import { useChatStream } from '@/presentation/hooks/useChatStream';

const { Text } = Typography;

const statusMap: Record<
  UIToolCall['status'],
  { label: string; color: string; icon: React.ReactNode }
> = {
  running: { label: '执行中', color: 'processing', icon: <LoadingOutlined /> },
  awaiting_confirm: { label: '等待确认', color: 'warning', icon: <ExclamationCircleOutlined /> },
  success: { label: '成功', color: 'success', icon: <CheckCircleOutlined /> },
  failed: { label: '失败', color: 'error', icon: <CloseCircleOutlined /> },
  denied: { label: '已拒绝', color: 'default', icon: <StopOutlined /> },
};

interface ToolCallCardProps {
  toolCall: UIToolCall;
}

export default function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const { confirmTool } = useChatStream();
  const meta = statusMap[toolCall.status];

  return (
    <Card size="small" className="tool-call-card">
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space>
          <Text strong>{toolCall.name}</Text>
          <Tag color={meta.color} icon={meta.icon}>
            {meta.label}
          </Tag>
        </Space>

        {toolCall.argumentsText && (
          <pre className="tool-call-args">
            <code>{toolCall.argumentsText}</code>
          </pre>
        )}

        {toolCall.status === 'awaiting_confirm' && (
          <Space>
            <Button size="small" type="primary" onClick={() => confirmTool(true)}>
              允许
            </Button>
            <Button size="small" danger onClick={() => confirmTool(false)}>
              拒绝
            </Button>
          </Space>
        )}

        {toolCall.result && (
          <div className="tool-call-result">
            <Text type="secondary">结果：</Text>
            <pre className="tool-call-result-content">
              <code>
                {toolCall.result.success
                  ? toolCall.result.content
                  : toolCall.result.error ?? '未知错误'}
              </code>
            </pre>
          </div>
        )}
      </Space>
    </Card>
  );
}
