// 产品索引轮询：填 signal.index / display.unit / display.calibration。409 按 Retry-After 重试（不是错误），
// 404 停（终态且确实没有该产品），索引收尾且任务终态停。

import { useEffect } from 'react'
import { getProductIndex } from '../api/client.js'
import { TERMINAL } from '../state/reducer.js'
import { useAppState, useStore } from '../state/store.js'

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((res) => {
  const t = setTimeout(res, ms)
  signal.addEventListener('abort', () => { clearTimeout(t); res() }, { once: true })
})

export function useProductIndex(): void {
  const store = useStore()
  const s = useAppState()
  const taskId = s.task.id
  const opId = s.signal.opId
  const runState = s.task.runState
  const hasSpectrum = s.task.observationPoints.some((o) => o.op_id === opId && o.products.includes('spectrum'))
  useEffect(() => {
    if (!taskId || !opId || !hasSpectrum) return
    const ac = new AbortController()
    void (async () => {
      while (!ac.signal.aborted) {
        let r
        try { r = await getProductIndex(taskId, opId, 'spectrum') } catch { await sleep(2000, ac.signal); continue }
        if (ac.signal.aborted) return
        if ('index' in r) {
          store.dispatch({ type: 'signal/index', opId, index: r.index })
          const st = store.getState()
          if (r.index.index_final && TERMINAL.has(r.index.run_state) && TERMINAL.has(st.task.runState ?? 'queued')) return
          await sleep(1000, ac.signal)
        } else if (r.status === 409) {
          await sleep((r as { retryAfterMs: number }).retryAfterMs, ac.signal)
        } else if (r.status === 404) {
          return
        } else {
          await sleep(2000, ac.signal)
        }
      }
    })()
    return () => ac.abort()
    // runState 变化时重新进入循环，让终态后再取一次收尾的索引
  }, [taskId, opId, hasSpectrum, runState, store])
}
