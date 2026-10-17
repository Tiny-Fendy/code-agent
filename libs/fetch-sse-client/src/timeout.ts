/**
 * 三层超时控制器
 *
 * - 连接超时：fetch 发起至收到响应头的最大等待时间
 * - 读取超时：两次数据到达之间的最大间隔（用于检测僵死连接）
 * - 总超时：整个流生命周期的上限
 *
 * 三层超时共享一个 AbortController，超时触发 controller.abort()，
 * 通知 fetch 和上层消费者统一停止。
 */

/**
 * 创建复合超时控制器
 *
 * @param connectTimeout  连接超时（毫秒，0 表示不限）
 * @param readTimeout     读取超时（毫秒，0 表示不限）
 * @param totalTimeout    总超时（毫秒，0 表示不限）
 * @param signal          外部取消信号（可选，用于合并）
 * @returns 控制器句柄，包含 controller 和操作方法
 */
export function createTimeoutController(
  connectTimeout: number,
  readTimeout: number,
  totalTimeout: number,
  signal?: AbortSignal,
): {
  controller: AbortController;
  /** 连接超时原因 */
  connectTimedOut: boolean;
  /** 读取超时原因 */
  readTimedOut: boolean;
  /** 总超时原因 */
  totalTimedOut: boolean;
  /** 启动连接超时计时（应在发起 fetch 前调用） */
  startConnectTimer: () => void;
  /** 取消连接超时计时（应在收到响应头后调用） */
  cancelConnectTimer: () => void;
  /** 刷新读取超时计时（应在每次收到数据后调用） */
  refreshReadTimer: () => void;
  /** 清理所有计时器 */
  dispose: () => void;
} {
  const controller = new AbortController();
  const state = {
    connectTimedOut: false,
    readTimedOut: false,
    totalTimedOut: false,
  };

  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let readTimer: ReturnType<typeof setTimeout> | null = null;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;

  function abort(reason: string) {
    controller.abort(reason);
  }

  // 外部 signal 合并
  if (signal) {
    if (signal.aborted) {
      abort('External signal aborted');
    } else {
      signal.addEventListener('abort', () => {
        abort('External signal aborted');
      }, { once: true });
    }
  }

  // 总超时
  if (totalTimeout > 0) {
    totalTimer = setTimeout(() => {
      state.totalTimedOut = true;
      abort('Total timeout');
    }, totalTimeout);
  }

  function startConnectTimer() {
    if (connectTimeout > 0 && !connectTimer) {
      connectTimer = setTimeout(() => {
        state.connectTimedOut = true;
        abort('Connect timeout');
      }, connectTimeout);
    }
  }

  function cancelConnectTimer() {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function refreshReadTimer() {
    if (readTimeout <= 0) return;
    if (readTimer) {
      clearTimeout(readTimer);
    }
    readTimer = setTimeout(() => {
      state.readTimedOut = true;
      abort('Read timeout');
    }, readTimeout);
  }

  function dispose() {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    if (readTimer) {
      clearTimeout(readTimer);
      readTimer = null;
    }
    if (totalTimer) {
      clearTimeout(totalTimer);
      totalTimer = null;
    }
  }

  return {
    controller,
    get connectTimedOut() { return state.connectTimedOut; },
    get readTimedOut() { return state.readTimedOut; },
    get totalTimedOut() { return state.totalTimedOut; },
    startConnectTimer,
    cancelConnectTimer,
    refreshReadTimer,
    dispose,
  };
}
