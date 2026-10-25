/**
 * 对话输入区
 *
 * 结构：外层 box 负责边框与聚焦态，内部纵向排列为
 *   TextArea（无边框） + 底部工具栏（左侧保留区 + 右侧操作按钮）。
 * 发送/停止均为圆形 icon 按钮，置于右下角。
 * 流式中时发送按钮变为停止按钮；支持 Enter 发送、Shift+Enter 换行。
 */

import { useState } from 'react';
import { Input } from 'antd';
import { SendOutlined, StopOutlined } from '@ant-design/icons';
import { useChatStream } from '@/presentation/hooks/useChatStream';

const { TextArea } = Input;

/**
 * 单条消息字符上限。
 *
 * 依据：Agent 默认上下文预算 8000 token（ContextManager.DEFAULT_MAX_TOKENS），
 * 按 CJK 约 1.5 字符/token 估算，1 万字符 ≈ 6.7k token，已占满大半窗口；
 * 再大就会把工具结果和历史挤出去，且单条用户消息无法被压缩策略回收。
 * 纯代码/英文约 4 字符/token，1 万字符仅约 2.5k token，仍够粘贴中等规模片段。
 */
const MAX_INPUT_CHARS = 10_000;

/** 接近上限时才显示计数，平时不占视觉空间 */
const COUNT_VISIBLE_THRESHOLD = 8_000;

export default function ChatInput() {
  const [value, setValue] = useState('');
  const { send, stop, isStreaming } = useChatStream();
  const charCount = value.length;
  const showCount = charCount > COUNT_VISIBLE_THRESHOLD;

  const handleSend = () => {
    if (isStreaming) return;
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
      <div className="chat-input-box">
        <TextArea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? '正在生成回复…' : '输入消息，Enter 发送，Shift+Enter 换行'}
          disabled={isStreaming}
          autoSize={{ minRows: 3, maxRows: 10 }}
          maxLength={MAX_INPUT_CHARS}
          bordered={false}
        />
        <div className="chat-input-toolbar">
          {/* 左侧保留区：后续可放附件、截图、字数等；当前仅在接近上限时展示计数 */}
          <div className="chat-input-toolbar-left">
            {showCount && (
              <span
                className={`chat-input-count ${charCount >= MAX_INPUT_CHARS ? 'chat-input-count-exceed' : ''}`}
              >
                {charCount} / {MAX_INPUT_CHARS}
              </span>
            )}
          </div>
          <div className="chat-input-toolbar-right">
            {isStreaming ? (
              <button
                type="button"
                className="chat-input-btn chat-input-btn-stop"
                onClick={stop}
                aria-label="停止"
              >
                <StopOutlined />
              </button>
            ) : (
              <button
                type="button"
                className="chat-input-btn chat-input-btn-send"
                onClick={handleSend}
                disabled={!value.trim()}
                aria-label="发送"
              >
                <SendOutlined />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
