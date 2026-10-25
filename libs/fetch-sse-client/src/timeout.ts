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
 * 复合超时控制器
 *
 * @param connectTimeout  连接超时（毫秒，0 表示不限）
 * @param readTimeout     读取超时（毫秒，0 表示不限）
 * @param totalTimeout    总超时（毫秒，0 表示不限）
 * @param signal          外部取消信号（可选，用于合并）
 */
export class TimeoutController {
  readonly controller = new AbortController();

  private _connectTimedOut = false;
  private _readTimedOut = false;
  private _totalTimedOut = false;

  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly connectTimeout: number,
    private readonly readTimeout: number,
    private readonly totalTimeout: number,
    signal?: AbortSignal,
  ) {
    // 外部 signal 合并
    if (signal) {
      if (signal.aborted) {
        this.controller.abort('External signal aborted');
      } else {
        signal.addEventListener(
          'abort',
          () => {
            this.controller.abort('External signal aborted');
          },
          { once: true },
        );
      }
    }

    // 总超时
    if (this.totalTimeout > 0) {
      this.totalTimer = setTimeout(() => {
        this._totalTimedOut = true;
        this.controller.abort('Total timeout');
      }, this.totalTimeout);
    }
  }

  /** 连接超时是否已触发 */
  get connectTimedOut(): boolean {
    return this._connectTimedOut;
  }

  /** 读取超时是否已触发 */
  get readTimedOut(): boolean {
    return this._readTimedOut;
  }

  /** 总超时是否已触发 */
  get totalTimedOut(): boolean {
    return this._totalTimedOut;
  }

  /** 启动连接超时计时（应在发起 fetch 前调用） */
  startConnectTimer(): void {
    if (this.connectTimeout > 0 && !this.connectTimer) {
      this.connectTimer = setTimeout(() => {
        this._connectTimedOut = true;
        this.controller.abort('Connect timeout');
      }, this.connectTimeout);
    }
  }

  /** 取消连接超时计时（应在收到响应头后调用） */
  cancelConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  /** 刷新读取超时计时（应在每次收到数据后调用） */
  refreshReadTimer(): void {
    if (this.readTimeout <= 0) return;
    if (this.readTimer) {
      clearTimeout(this.readTimer);
    }
    this.readTimer = setTimeout(() => {
      this._readTimedOut = true;
      this.controller.abort('Read timeout');
    }, this.readTimeout);
  }

  /** 清理所有计时器 */
  dispose(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.readTimer) {
      clearTimeout(this.readTimer);
      this.readTimer = null;
    }
    if (this.totalTimer) {
      clearTimeout(this.totalTimer);
      this.totalTimer = null;
    }
  }
}
