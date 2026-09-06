// 产品索引轮询：谱与包络各一路，填 signal.index / signal.envelopeIndex（以及 display.unit / calibration）。
// 409 按 Retry-After 重试（不是错误），404 停（终态且确实没有该产品），索引收尾且任务终态停。

import { useEffect } from 'react'
import { getProductIndex } from '../api/client.js'
import { TERMINAL } from '../state/reducer.js'
import { useAppState, useStore } from '../state/store.js'
import type { Action, AppState } from '../state/types.js'

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((res) => {
  const t = setTimeout(res, ms)
  signal.addEventListener('abort', () => { clearTimeout(t); res() }, { once: true })
})

type Kind = 'spectrum' | 'envelope'

async function pollIndex(taskId: string, opId: string, kind: Kind, store: { getState(): AppState; dispatch(a: Action): void }, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    let r
    try { r = await getProductIndex(taskId, opId, kind) } catch { await sleep(2000, signal); continue }
    if (signal.aborted) return
    if ('index' in r) {
      store.dispatch(kind === 'spectrum' ? { type: 'signal/index', opId, index: r.index } : { type: 'signal/envelopeIndex', opId, index: r.index })
      const st = store.getState()
      if (r.index.index_final && TERMINAL.has(r.index.run_state) && TERMINAL.has(st.task.runState ?? 'queued')) return
      await sleep(1000, signal)
    } else if (r.status === 409) {
      await sleep((r as { retryAfterMs: number }).retryAfterMs, signal)
    } else if (r.status === 404) {
      return
    } else {
      await sleep(2000, signal)
    }
  }
}

export function useProductIndex(): void {
  const store = useStore()
  const s = useAppState()
  const taskId = s.task.id
  const opId = s.signal.opId
  const runState = s.task.runState
  const op = s.task.observationPoints.find((o) => o.op_id === opId)
  const kinds = (op?.products ?? []).filter((k): k is Kind => k === 'spectrum' || k === 'envelope').join(',')
  useEffect(() => {
    if (!taskId || !opId || !kinds) return
    const ac = new AbortController()
    for (const kind of kinds.split(',') as Kind[]) void pollIndex(taskId, opId, kind, store, ac.signal)
    return () => ac.abort()
    // runState 变化时重新进入循环，让终态后再取一次收尾的索引
  }, [taskId, opId, kinds, runState, store])
}
