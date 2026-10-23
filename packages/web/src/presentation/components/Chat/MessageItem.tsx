/**
 * 单条消息渲染
 *
 * 按 role 区分左右气泡；assistant 消息内按 parts 顺序渲染文本与工具卡片；
 * 消息级错误（llmFailed / maxSteps / rpc_failed / aborted）在气泡下方展示。
 */

import { Alert, Button, Typography } from 'antd';
import { RedoOutlined } from '@ant-design/icons';
import type { UIMessage } from '@/domain/conversation';
import Markdown from './Markdown';
import ToolCallCard from './ToolCallCard';
import { useChatStream } from '@/presentation/hooks/useChatStream';

const { Text } = Typography;

interface MessageItemProps {
  message: UIMessage;
}

export default function MessageItem({ message: msg }: MessageItemProps) {
  const { retry, isStreaming } = useChatStream();
  const isUser = msg.role === 'user';

  return (
    <div className={`message-item ${isUser ? 'message-user' : 'message-assistant'}`}>
      <div className="message-bubble">
        {msg.parts.map((part, idx) => {
          if (part.kind === 'text') {
            return isUser ? (
              <Text key={idx} className="message-text">
                {part.text}
              </Text>
            ) : (
              <Markdown key={idx}>{part.text}</Markdown>
            );
          }
          return <ToolCallCard key={part.toolCall.id} toolCall={part.toolCall} />;
        })}

        {/* 流式中且没有内容：显示「思考中」占位 */}
        {msg.streaming && msg.parts.length === 0 && (
          <Text type="secondary" italic>
            思考中…
          </Text>
        )}
      </div>

      {/* 消息级错误与重试入口 */}
      {msg.error && (
        <Alert
          className="message-error"
          type={msg.error.kind === 'aborted' ? 'info' : 'error'}
          message={
            msg.error.kind === 'aborted'
              ? '已停止'
              : msg.error.kind === 'max_steps'
                ? '已达最大思考步数，任务可能未完成'
                : msg.error.message ?? '对话失败'
          }
          action={
            !isStreaming && msg.error.kind !== 'aborted' ? (
              <Button size="small" icon={<RedoOutlined />} onClick={retry}>
                重试
              </Button>
            ) : undefined
          }
          showIcon
        />
      )}
    </div>
  );
}
