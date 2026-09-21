// 空闲调度：requestIdleCallback 不可用时降级 setTimeout。
// 主线程重计算通过“异步检查点”在每个空闲切片之间让出事件循环（见 renderer.js）。

const ric = typeof window !== 'undefined' && window.requestIdleCallback;
const cic = typeof window !== 'undefined' && window.cancelIdleCallback;

export const hasIdleCallback = !!ric;

export function scheduleIdle(task, timeout = 100) {
  if (ric) return window.requestIdleCallback(task, { timeout });
  const start = performance.now();
  return setTimeout(() => {
    task({
      didTimeout: false,
      timeRemaining: () => Math.max(0, 16 - (performance.now() - start)),
    });
  }, 1);
}

export function cancelIdle(handle) {
  if (cic && typeof handle === 'number') window.cancelIdleCallback(handle);
  else clearTimeout(handle);
}
