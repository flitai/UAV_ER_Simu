// 评价指标的外部小 store（与 recognitionStore 同一范式，C-5）：metrics.json 一次运行一份、运行结束才有，
// 所以只在终态取；运行中拿到 409 就等下一轮（结果页可见时每 2 s 一次，与检测行同节拍）。
// 界面只摆数（Pd / Pfa / F1 / 识别准确率 / 状态），不写解释句（D-039）；完整的评价页签（混淆矩阵、ROC）随 C-9。

import { useEffect } from 'react'
import { getMetrics, type MetricsDoc } from '../api/client.js'
import type { RunState } from '../state/types.js'

export type MetricsStatus = 'idle' | 'polling' | 'final' | 'none'

export interface MetricsState {
  taskId: string | null
  doc: MetricsDoc | null
  status: MetricsStatus
  error: string | null
  fetches: number
}

const initial = (): MetricsState => ({ taskId: null, doc: null, status: 'idle', error: null, fetches: 0 })

let state: MetricsState = initial()
const subs = new Set<() => void>()

export const metricsStore = {
  get: (): MetricsState => state,
  patch(p: Partial<MetricsState>): void {
    let changed = false
    for (const k of Object.keys(p) as Array<keyof MetricsState>) if (!Object.is(state[k], p[k])) { changed = true; break }
    if (!changed) return
    state = { ...state, ...p }
    for (const f of subs) f()
  },
  reset(taskId: string | null): void {
    state = { ...initial(), taskId }
    for (const f of subs) f()
  },
  subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f) } },
}

/** 探针用的摘要：每节四个数与状态 */
export function probeMetrics(st: MetricsState) {
  return {
    taskId: st.taskId,
    status: st.status,
    error: st.error,
    sites: (st.doc?.sites ?? []).map((s) => ({
      node_id: s.node_id, site_id: s.site_id, truth_source: s.truth_source,
      pd: s.frames.pd, pfa: s.frames.pfa, f1: s.frames.f1, accuracy: s.recognition.accuracy,
      pd_segment: s.segments.pd_segment, truth: s.segments.truth, matched: s.segments.matched,
      state: s.state,
    })),
  }
}

const POLL_MS = 2000
const TERMINAL = new Set<RunState>(['finished', 'failed', 'cancelled'])

async function fetchOnce(taskId: string, final: boolean): Promise<void> {
  const r = await getMetrics(taskId)
  if (metricsStore.get().taskId !== taskId) return
  const fetches = metricsStore.get().fetches + 1
  if (r.status === 'none') { metricsStore.patch({ status: 'none', doc: null, fetches }); return }
  if (r.status === 'not_ready') { metricsStore.patch({ status: 'polling', fetches }); return }
  if (r.status === 'error') { metricsStore.patch({ error: r.message, fetches }); return }
  metricsStore.patch({ doc: r.doc, status: final ? 'final' : 'polling', error: null, fetches })
}

/** 驱动 store：任务变了就清；结果页可见时运行中每 2 s 探一次（409 等下一轮），终态取最后一次。挂在 ResultsView 上。 */
export function useMetrics(taskId: string | null, runState: RunState | null, active: boolean): void {
  useEffect(() => { metricsStore.reset(taskId) }, [taskId])
  useEffect(() => {
    if (!taskId || !active) return
    const terminal = runState !== null && TERMINAL.has(runState)
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try { await fetchOnce(taskId, terminal) } catch (e) {
        if (alive) metricsStore.patch({ error: String(e) })
      }
      if (!alive || terminal) return
      timer = setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => { alive = false; if (timer !== null) clearTimeout(timer) }
  }, [taskId, runState, active])
}
