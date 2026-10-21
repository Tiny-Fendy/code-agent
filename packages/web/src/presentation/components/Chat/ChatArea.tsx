/**
 * 对话区：消息列表 + 输入区
 *
 * 阶段①骨架：空会话显示引导空态；
 * 消息流渲染、工具卡片、输入框在阶段②接入（届时拆 MessageList / MessageItem / ChatInput）。
 */

import { Empty } from 'antd';
import { useChatStore } from '@/presentation/store/chatStore';

export default function ChatArea() {
  const hasMessages = useChatStore((s) => s.messages.length > 0);

  return (
    <div className="chat-area">
      {hasMessages ? (
        // TODO(阶段②)：MessageList（含工具卡片）+ ChatInput
        null
      ) : (
        <div className="chat-empty">
          <Empty
            description="开始你的第一次对话"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </div>
      )}
    </div>
  );
}
