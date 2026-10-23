/**
 * 对话区：消息列表 + 输入区
 *
 * 薄组件：只做布局编排，消息流与输入逻辑分别由 MessageList / ChatInput 承载。
 */

import { Empty } from 'antd';
import { useChatStore } from '@/presentation/store/chatStore';
import MessageList from './MessageList';
import ChatInput from './ChatInput';

export default function ChatArea() {
  const hasMessages = useChatStore((s) => s.messages.length > 0);

  return (
    <div className="chat-area">
      {hasMessages ? (
        <MessageList />
      ) : (
        <div className="chat-empty">
          <Empty
            description="开始你的第一次对话"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </div>
      )}
      <ChatInput />
    </div>
  );
}
