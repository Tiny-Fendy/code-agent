/**
 * 对话输入区
 *
 * 流式中时发送按钮变为停止按钮；支持 Enter 发送、Shift+Enter 换行。
 * 输入禁用与发送/停止状态由 useChatStream 提供。
 */

import { useState } from 'react';
import { Button, Input } from 'antd';
import { SendOutlined, StopOutlined } from '@ant-design/icons';
import { useChatStream } from '@/presentation/hooks/useChatStream';

const { TextArea } = Input;

export default function ChatInput() {
  const [value, setValue] = useState('');
  const { send, stop, isStreaming } = useChatStream();

  const handleSend = () => {
    const text = value.trim();
    if (!text) return;
    send(text);
    setValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-input">
      <TextArea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={isStreaming ? '正在生成回复…' : '输入消息，Enter 发送，Shift+Enter 换行'}
        disabled={isStreaming}
        autoSize={{ minRows: 1, maxRows: 6 }}
      />
      {isStreaming ? (
        <Button danger icon={<StopOutlined />} onClick={stop} className="chat-input-btn">
          停止
        </Button>
      ) : (
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={handleSend}
          disabled={!value.trim()}
          className="chat-input-btn"
        >
          发送
        </Button>
      )}
    </div>
  );
}
