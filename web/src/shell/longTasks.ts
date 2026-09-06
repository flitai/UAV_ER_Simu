// 开发者模式的长任务计数（U-3 验收「20 Hz 下主线程无 > 50 ms 长任务」）：PerformanceObserver longtask。
// 只在 ?dev=1 安装，探针 app.perf.longTasks 读它；e2e 在跑任务前 reset()。

export interface LongTaskCounter {
  snapshot(): { count: number; maxMs: number }
  reset(): void
  dispose(): void
}

export function installLongTaskCounter(thresholdMs = 50): LongTaskCounter | null {
  if (typeof PerformanceObserver === 'undefined') return null
  const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes ?? []
  if (!supported.includes('longtask')) return null
  let count = 0
  let maxMs = 0
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration > thresholdMs) count += 1
      if (e.duration > maxMs) maxMs = e.duration
    }
  })
  try { po.observe({ type: 'longtask', buffered: false }) } catch { return null }
  return {
    snapshot: () => ({ count, maxMs: Math.round(maxMs * 10) / 10 }),
    reset: () => { count = 0; maxMs = 0 },
    dispose: () => po.disconnect(),
  }
}
