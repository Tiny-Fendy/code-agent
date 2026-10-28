import { describe, it, expect, vi } from 'vitest';
import { ABORTED, raceAbort } from '@/tools/support/abort';

describe('raceAbort', () => {
  it('未传 signal：原样透传回调结果', async () => {
    await expect(raceAbort(Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('signal 未触发：返回回调结果并移除监听器', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(raceAbort(Promise.resolve('ok'), controller.signal)).resolves.toBe('ok');
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('signal 先触发：立即返回哨兵，不等回调返回', async () => {
    const controller = new AbortController();
    let resolveCallback!: (value: string) => void;
    const callback = new Promise<string>((r) => {
      resolveCallback = r;
    });

    const raced = raceAbort(callback, controller.signal);
    controller.abort();

    await expect(raced).resolves.toBe(ABORTED);
    resolveCallback('迟到结果'); // 迟到的结果不改变已确定的哨兵
  });

  it('signal 已触发：直接返回哨兵，不等待回调', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      raceAbort(new Promise<string>(() => {}), controller.signal),
    ).resolves.toBe(ABORTED);
  });

  it('回调异常：原样抛出，由调用方决定降级', async () => {
    const controller = new AbortController();
    await expect(raceAbort(Promise.reject(new Error('宿主异常')), controller.signal)).rejects.toThrow(
      '宿主异常',
    );
  });
});
