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
        autoSize={{ minRows: 3, maxRows: 10 }}
        // maxLength 走原生属性（粘贴/输入都会被浏览器截断）；
        // count 仅负责展示计数，其 max 不参与截断逻辑
        maxLength={MAX_INPUT_CHARS}
        count={{
          max: MAX_INPUT_CHARS,
          // show 函数是「内容格式化器」而非可见性开关：返回 null 时计数为空，
          // 只有接近上限才输出 "已用 / 上限"，避免常态下多一行无信息量的数字
          show: ({ count, maxLength }) =>
            count > COUNT_VISIBLE_THRESHOLD ? `${count} / ${maxLength}` : null,
        }}
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
