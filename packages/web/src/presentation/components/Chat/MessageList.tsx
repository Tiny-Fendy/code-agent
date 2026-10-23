/**
 * 消息列表
 *
 * 负责渲染全部消息、自动滚动到底部、以及「回到底部」按钮。
 * 消息数据来自 chatStore；滚动行为由 useAutoScroll 管理。
 */

import { useLayoutEffect } from 'react';
import { Button } from 'antd';
import { ArrowDownOutlined } from '@ant-design/icons';
import { useChatStore } from '@/presentation/store/chatStore';
import { useAutoScroll } from '@/presentation/hooks/useAutoScroll';
import MessageItem from './MessageItem';

export default function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const {
    containerRef,
    showBackToBottom,
    scrollToBottom,
    handleScroll,
    notifyContentChange,
  } = useAutoScroll();

  // 每次消息变化（流式增量也会产生新引用）同步滚动到最新内容。
  // 用 useLayoutEffect：在浏览器绘制前完成滚动，避免可见的跳动；
  // 再用一帧兜底，覆盖 Markdown / 代码高亮渲染后高度二次增长的情况。
  useLayoutEffect(() => {
    notifyContentChange();
    const raf = requestAnimationFrame(() => notifyContentChange());
    return () => cancelAnimationFrame(raf);
  }, [messages, notifyContentChange]);

  return (
    <div className="message-list-wrapper">
      <div ref={containerRef} className="message-list" onScroll={handleScroll}>
        {messages.map((msg) => (
          <MessageItem key={msg.id} message={msg} />
        ))}
      </div>

      {showBackToBottom && (
        <Button
          className="back-to-bottom"
          type="primary"
          shape="circle"
          icon={<ArrowDownOutlined />}
          onClick={scrollToBottom}
          aria-label="回到底部"
        />
      )}
    </div>
  );
}
