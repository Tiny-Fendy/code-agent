/**
 * 取消等待的通用支撑
 *
 * 引擎里的「门控等待」（工具确认、ask_user）都挂在宿主回调上，
 * 取消信号触发时必须立即收口，不能依赖宿主把回调 settle 掉。
 */

/** 中断哨兵：区分「等待已被中断」与回调的真实返回值 */
export const ABORTED = Symbol('aborted');

/**
 * 让一个宿主回调的等待与取消信号 race
 *
 * - 信号先触发 → 立即返回 ABORTED 哨兵，不等回调返回（迟到的决议不再影响引擎）
 * - 未中断 → 原样返回回调结果；回调异常照常抛出，由调用方决定降级策略
 * - 两条分支都移除监听器，避免监听器随 run 累积泄漏
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T | typeof ABORTED> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    // 已中断：丢弃回调结果，同时挂一个空处理避免迟到的 rejection 变成未处理拒绝
    void promise.catch(() => {});
    return Promise.resolve(ABORTED);
  }
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    function onAbort() {
      cleanup();
      resolve(ABORTED);
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
