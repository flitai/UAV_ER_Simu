// 检测结果的外部小 store（viewStore 范式，09 附录 A.1）：行是高频量（每站每秒几百帧），不进主 store。
// 结果页的突发列表、信号页的叠加、探针都从这里读。
//
// 数据只从**文件**取（B-7 的 detections 端点）：运行中每 2 s 取一次命中帧，终态后取最后一次加索引。
// WS 上的 detection 事件（按段首帧一条）本期不消费——结束后文件才完整，与 useSituation 对测向报告的处置同理。

import { useEffect } from 'react'
import { getDetections, getDetectionsIndex, type DetectionRow, type DetectionsIndex } from '../api/client.js'
import type { RunState } from '../state/types.js'
import { frameDurationOf, segmentsOf, type DetectionSegment } from './segments.js'

export type DetectionStatus = 'idle' | 'polling' | 'final' | 'none'

export interface DetectionState {
  taskId: string | null
  /** 命中帧（`hit=true` 取回的行）；非命中帧不进浏览器 */
  rows: DetectionRow[]
  segments: DetectionSegment[]
  index: DetectionsIndex | null
  /** 实际用的抽稀步长；> 1 表示服务端 413 后按建议重取过，段的起止是近似的 */
  stride: number
  /** 一帧时长（索引给的，或从行估的） */
  dt_s: number
  siteFilter: string | null
  status: DetectionStatus
  error: string | null
  fetches: number
}

const initial = (): DetectionState => ({
  taskId: null, rows: [], segments: [], index: null, stride: 1, dt_s: 0, siteFilter: null, status: 'idle', error: null, fetches: 0,
})

let state: DetectionState = initial()
const subs = new Set<() => void>()

export const detectionStore = {
  get: (): DetectionState => state,
  patch(p: Partial<DetectionState>): void {
    let changed = false
    for (const k of Object.keys(p) as Array<keyof DetectionState>) if (!Object.is(state[k], p[k])) { changed = true; break }
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

/** 站过滤后的段：右栏下拉选了站就只看那一站的 */
export function visibleSegments(st: DetectionState): DetectionSegment[] {
  return st.siteFilter ? st.segments.filter((g) => g.site_id === st.siteFilter) : st.segments
}

/** 探针用的摘要（逐项列，不整包展开——漏字段就看不见，切片 ⑥b 踩过） */
export function probeDetections(st: DetectionState) {
  return {
    taskId: st.taskId, status: st.status, rows: st.rows.length, segments: st.segments.length,
    visibleSegments: visibleSegments(st).length, siteFilter: st.siteFilter, stride: st.stride,
    indexFinal: st.index?.final ?? false, nodes: st.index ? Object.keys(st.index.nodes).sort() : [],
    hits: st.index ? Object.values(st.index.nodes).reduce((a, n) => a + n.hits, 0) : st.rows.length,
    frames: st.index ? Object.values(st.index.nodes).reduce((a, n) => a + n.frames, 0) : null,
    first: st.segments[0] ? { t_start: st.segments[0].t_start, t_end: st.segments[0].t_end, node_id: st.segments[0].node_id } : null,
    longest: (() => {
      let best: DetectionSegment | null = null
      for (const g of st.segments) if (!best || g.frames > best.frames) best = g
      return best ? { t_start: best.t_start, t_end: best.t_end, frames: best.frames, node_id: best.node_id } : null
    })(),
    error: st.error,
  }
}

const POLL_MS = 2000
const TERMINAL = new Set<RunState>(['finished', 'failed', 'cancelled'])

async function fetchOnce(taskId: string, final: boolean): Promise<void> {
  const r = await getDetections(taskId, { hit: true })
  if (detectionStore.get().taskId !== taskId) return          // 换任务了，丢掉这次结果
  if (r.status === 'none') { detectionStore.patch({ status: 'none', rows: [], segments: [], fetches: detectionStore.get().fetches + 1 }); return }
  if (r.status === 'not_ready') { detectionStore.patch({ status: 'polling', fetches: detectionStore.get().fetches + 1 }); return }
  if (r.status === 'error') { detectionStore.patch({ error: r.message, fetches: detectionStore.get().fetches + 1 }); return }
  let index = detectionStore.get().index
  if (final) {
    const ir = await getDetectionsIndex(taskId)
    if (detectionStore.get().taskId !== taskId) return
    if ('index' in ir) index = ir.index
  }
  const dtFromIndex = index ? (Object.values(index.nodes)[0]?.dt_s ?? null) : null
  const dt = frameDurationOf(r.rows, dtFromIndex)
  detectionStore.patch({
    rows: r.rows, stride: r.stride, dt_s: dt, index,
    segments: segmentsOf(r.rows, dt, r.stride),
    status: final ? 'final' : 'polling', error: null, fetches: detectionStore.get().fetches + 1,
  })
}

/**
 * 驱动 store：任务变了就清；结果页可见时运行中每 2 s 取一次，终态取最后一次加索引。
 * 挂在 ResultsView 上——信号页的叠加与检测页签共用同一份数据。
 */
export function useDetections(taskId: string | null, runState: RunState | null, active: boolean): void {
  useEffect(() => {
    detectionStore.reset(taskId)
  }, [taskId])

  useEffect(() => {
    if (!taskId || !active) return
    const terminal = runState !== null && TERMINAL.has(runState)
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try { await fetchOnce(taskId, terminal) } catch (e) {
        if (alive) detectionStore.patch({ error: String(e) })
      }
      if (!alive || terminal) return
      timer = setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => { alive = false; if (timer !== null) clearTimeout(timer) }
  }, [taskId, runState, active])
}
