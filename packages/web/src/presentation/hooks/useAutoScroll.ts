/**
 * useAutoScroll：消息列表自动滚动到底部
 *
 * 规则：
 * - 默认跟随流式输出自动滚动到底部
 * - 用户上滑查看历史时暂停自动滚动，出现「回到底部」按钮
 * - 点击按钮或用户滑回底部附近时恢复自动滚动
 *
 * 返回：容器 ref、是否显示回到底部按钮、回到底部函数
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** 距离底部多少像素内视为「已到底部」，恢复自动滚动 */
const BOTTOM_THRESHOLD = 40;

export function useAutoScroll() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showBackToBottom, setShowBackToBottom] = useState(false);
  /** 是否允许自动滚动（用户上滑后暂停） */
  const autoScrollRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    autoScrollRef.current = true;
    setShowBackToBottom(false);
  }, []);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
    autoScrollRef.current = atBottom;
    setShowBackToBottom(!atBottom);
  }, []);

  /** 内容变化时若允许自动滚动则滚到底部 */
  const notifyContentChange = useCallback(() => {
    if (!autoScrollRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  return {
    containerRef,
    showBackToBottom,
    scrollToBottom,
    handleScroll,
    notifyContentChange,
  };
}
