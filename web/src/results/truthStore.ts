// 真值段的外部小 store（与 recognitionStore 同一范式，C-9）：每段真值一行，检测识别页签的时间线第一行读它。
// 数据只从文件取（truth 端点）：运行中每 2 s 取一次，终态后取最后一次。
// 没有评价器、或评价器的真值来源是 none 时端点 404 → status 'none'，时间线那一行就是空的（不编，铁律 15）。

import { useEffect } from 'react'
import { getTruth, type TruthRow } from '../api/client.js'
import type { RunState } from '../state/types.js'

export type TruthStatus = 'idle' | 'polling' | 'final' | 'none'

export interface TruthState {
  taskId: string | null
  rows: TruthRow[]
  stride: number
  status: TruthStatus
  error: string | null
  fetches: number
}

const initial = (): TruthState => ({ taskId: null, rows: [], stride: 1, status: 'idle', error: null, fetches: 0 })

let state: TruthState = initial()
const subs = new Set<() => void>()

export const truthStore = {
  get: (): TruthState => state,
  patch(p: Partial<TruthState>): void {
    let changed = false
    for (const k of Object.keys(p) as Array<keyof TruthState>) if (!Object.is(state[k], p[k])) { changed = true; break }
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

/** 站过滤后的真值段：与检测段共用 detectionStore 的焦点站（一件事一个入口，D-057） */
export function visibleTruth(st: TruthState, siteFilter: string | null): TruthRow[] {
  return siteFilter ? st.rows.filter((r) => (r.site_id ?? null) === siteFilter) : st.rows
}

/** 探针用的摘要（逐项列） */
export function probeTruth(st: TruthState) {
  const labels: Record<string, number> = {}
  let inBand = 0
  for (const r of st.rows) {
    labels[r.label] = (labels[r.label] ?? 0) + 1
    if (r.in_band) inBand++
  }
  return {
    taskId: st.taskId, status: st.status, rows: st.rows.length, inBand, labels, stride: st.stride,
    first: st.rows[0] ? { t_s: st.rows[0].t_s, t_end_s: st.rows[0].t_end_s, label: st.rows[0].label } : null,
    error: st.error,
  }
}

const POLL_MS = 2000
const TERMINAL = new Set<RunState>(['finished', 'failed', 'cancelled'])

async function fetchOnce(taskId: string, final: boolean): Promise<void> {
  const r = await getTruth(taskId)
  if (truthStore.get().taskId !== taskId) return
  const fetches = truthStore.get().fetches + 1
  if (r.status === 'none') { truthStore.patch({ status: 'none', rows: [], fetches }); return }
  if (r.status === 'not_ready') { truthStore.patch({ status: 'polling', fetches }); return }
  if (r.status === 'error') { truthStore.patch({ error: r.message, fetches }); return }
  truthStore.patch({ rows: r.rows, stride: r.stride, status: final ? 'final' : 'polling', error: null, fetches })
}

/** 驱动 store：任务变了就清；结果页可见时运行中每 2 s 取一次，终态取最后一次。挂在 ResultsView 上。 */
export function useTruth(taskId: string | null, runState: RunState | null, active: boolean): void {
  useEffect(() => { truthStore.reset(taskId) }, [taskId])
  useEffect(() => {
    if (!taskId || !active) return
    const terminal = runState !== null && TERMINAL.has(runState)
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try { await fetchOnce(taskId, terminal) } catch (e) {
        if (alive) truthStore.patch({ error: String(e) })
      }
      if (!alive || terminal) return
      timer = setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => { alive = false; if (timer !== null) clearTimeout(timer) }
  }, [taskId, runState, active])
}
