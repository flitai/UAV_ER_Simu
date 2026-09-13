// 识别结果的外部小 store（与 detectionStore 同一范式，C-4）：每个突发一行，结果页突发表的
// 标签 / 后验 / 结论三列与探针从这里读。数据只从文件取（recognitions 端点）：运行中每 2 s 取一次，
// 终态后取最后一次。WS 上的 recognition 事件本期不消费——结束后文件才完整。

import { useEffect } from 'react'
import { getRecognitions, type RecognitionRow } from '../api/client.js'
import type { RunState } from '../state/types.js'

export type RecognitionStatus = 'idle' | 'polling' | 'final' | 'none'

export interface RecognitionState {
  taskId: string | null
  rows: RecognitionRow[]
  /** `${site_id ?? ''}|${segment_id}` → 行：突发表按检测段的站与段号找它 */
  byKey: Record<string, RecognitionRow>
  stride: number
  status: RecognitionStatus
  error: string | null
  fetches: number
}

/** 识别行与检测段的关联键：识别器与检测器是不同节点（rec__x / det__x），只能按站与段号对 */
export function recKey(siteId: string | null | undefined, segmentId: number): string {
  return `${siteId ?? ''}|${segmentId}`
}

const initial = (): RecognitionState => ({ taskId: null, rows: [], byKey: {}, stride: 1, status: 'idle', error: null, fetches: 0 })

let state: RecognitionState = initial()
const subs = new Set<() => void>()

export const recognitionStore = {
  get: (): RecognitionState => state,
  patch(p: Partial<RecognitionState>): void {
    let changed = false
    for (const k of Object.keys(p) as Array<keyof RecognitionState>) if (!Object.is(state[k], p[k])) { changed = true; break }
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

/** 探针用的摘要（逐项列） */
export function probeRecognitions(st: RecognitionState) {
  const labels: Record<string, number> = {}
  let known = 0, ambiguous = 0, unknown = 0
  for (const r of st.rows) {
    labels[r.label] = (labels[r.label] ?? 0) + 1
    if (r.result === 'known') known++
    else if (r.result === 'ambiguous') ambiguous++
    else unknown++
  }
  return { taskId: st.taskId, status: st.status, rows: st.rows.length, known, ambiguous, unknown, labels, stride: st.stride, error: st.error }
}

const POLL_MS = 2000
const TERMINAL = new Set<RunState>(['finished', 'failed', 'cancelled'])

async function fetchOnce(taskId: string, final: boolean): Promise<void> {
  const r = await getRecognitions(taskId)
  if (recognitionStore.get().taskId !== taskId) return
  const fetches = recognitionStore.get().fetches + 1
  if (r.status === 'none') { recognitionStore.patch({ status: 'none', rows: [], byKey: {}, fetches }); return }
  if (r.status === 'not_ready') { recognitionStore.patch({ status: 'polling', fetches }); return }
  if (r.status === 'error') { recognitionStore.patch({ error: r.message, fetches }); return }
  const byKey: Record<string, RecognitionRow> = {}
  for (const row of r.rows) byKey[recKey(row.site_id, row.segment_id)] = row
  recognitionStore.patch({ rows: r.rows, byKey, stride: r.stride, status: final ? 'final' : 'polling', error: null, fetches })
}

/** 驱动 store：任务变了就清；结果页可见时运行中每 2 s 取一次，终态取最后一次。挂在 ResultsView 上。 */
export function useRecognitions(taskId: string | null, runState: RunState | null, active: boolean): void {
  useEffect(() => { recognitionStore.reset(taskId) }, [taskId])
  useEffect(() => {
    if (!taskId || !active) return
    const terminal = runState !== null && TERMINAL.has(runState)
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try { await fetchOnce(taskId, terminal) } catch (e) {
        if (alive) recognitionStore.patch({ error: String(e) })
      }
      if (!alive || terminal) return
      timer = setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => { alive = false; if (timer !== null) clearTimeout(timer) }
  }, [taskId, runState, active])
}
