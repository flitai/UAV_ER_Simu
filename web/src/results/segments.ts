// 检测行 → 突发（C-3，D-063）。纯函数，不碰 DOM 与 store，单测直接调。
//
// 段的身份由引擎给（`segment_id`，按 merge_gap_frames 合并），这里只按 (node_id, segment_id) 分组、
// 取起止与峰值——不自己再做一遍合并，免得两处规则漂开（单一真理源）。
// 抽稀（stride > 1）时看到的只是每段的部分帧：起止是近似的（末帧可能漏掉 stride − 1 帧），
// `frames` 按行数 × stride 估，界面要写明「已抽稀」。

import type { DetectionRow } from '../api/client.js'

export interface DetectionSegment {
  /** `${node_id}|${segment_id}` */
  key: string
  node_id: string
  site_id: string | null
  segment_id: number
  t_start: number
  /** 末帧首样点时刻 + 一帧时长 */
  t_end: number
  frames: number
  peak_statistic: number
  peak_band_power_dBm: number | null
  peak_snr_dB: number
  overload: boolean
  f_lo_Hz: number
  f_hi_Hz: number
}

/**
 * 一帧时长可以是一个数，也可以逐节点给（M-2，D-070）。
 * 多站下各站的 DDC 抽取比原则上可以不同，帧长随之不同；给一个数会让所有站按第一个站的帧长算。
 * 联合类型是为了让既有调用点与既有单测一字不改。
 */
export type FrameDt = number | Readonly<Record<string, number>>

function dtOf(dt: FrameDt, nodeId: string): number {
  if (typeof dt === 'number') return dt
  const v = dt[nodeId]
  return typeof v === 'number' && v > 0 ? v : 0
}

export function segmentsOf(rows: readonly DetectionRow[], dt_s: FrameDt, stride = 1): DetectionSegment[] {
  const by = new Map<string, DetectionSegment>()
  for (const r of rows) {
    if (!r.hit || r.segment_id === null || r.segment_id === undefined) continue
    const key = `${r.node_id}|${r.segment_id}`
    const prev = by.get(key)
    const p = typeof r.band_power_dBm === 'number' ? r.band_power_dBm : null
    if (!prev) {
      by.set(key, {
        key, node_id: r.node_id, site_id: r.site_id ?? null, segment_id: r.segment_id,
        t_start: r.t_s, t_end: r.t_s + dtOf(dt_s, r.node_id), frames: stride,
        peak_statistic: r.statistic, peak_band_power_dBm: p, peak_snr_dB: r.snr_dB,
        overload: r.overload, f_lo_Hz: r.f_lo_Hz, f_hi_Hz: r.f_hi_Hz,
      })
      continue
    }
    if (r.t_s < prev.t_start) prev.t_start = r.t_s
    const d = dtOf(dt_s, r.node_id)
    if (r.t_s + d > prev.t_end) prev.t_end = r.t_s + d
    prev.frames += stride
    if (r.statistic > prev.peak_statistic) prev.peak_statistic = r.statistic
    if (p !== null && (prev.peak_band_power_dBm === null || p > prev.peak_band_power_dBm)) prev.peak_band_power_dBm = p
    if (r.snr_dB > prev.peak_snr_dB) prev.peak_snr_dB = r.snr_dB
    if (r.overload) prev.overload = true
  }
  return [...by.values()].sort((a, b) => a.t_start - b.t_start || a.node_id.localeCompare(b.node_id) || a.segment_id - b.segment_id)
}

/** 一帧时长：索引给的优先；没有索引时从同一节点相邻两行的最小正时差估（运行中索引还没写出来）。 */
export function frameDurationOf(rows: readonly DetectionRow[], fromIndex: number | null): number {
  if (fromIndex !== null && fromIndex > 0) return fromIndex
  let best = Infinity
  const last = new Map<string, number>()
  for (const r of rows) {
    const prev = last.get(r.node_id)
    if (prev !== undefined) {
      const d = r.t_s - prev
      if (d > 0 && d < best) best = d
    }
    last.set(r.node_id, r.t_s)
  }
  return Number.isFinite(best) ? best : 0
}

/**
 * 逐节点的一帧时长（M-2，D-070）：索引给的优先，缺项的从**该节点自己**相邻两行的最小正时差估。
 * 退回全局最小是错的——那会把抽取比小的站的帧长安到抽取比大的站上。
 */
export function frameDurationByNode(rows: readonly DetectionRow[],
                                    fromIndex: Readonly<Record<string, number>> | null):
    Record<string, number> {
  const out: Record<string, number> = {}
  const best = new Map<string, number>()
  const last = new Map<string, number>()
  for (const r of rows) {
    const prev = last.get(r.node_id)
    if (prev !== undefined) {
      const d = r.t_s - prev
      if (d > 0 && d < (best.get(r.node_id) ?? Infinity)) best.set(r.node_id, d)
    }
    last.set(r.node_id, r.t_s)
  }
  for (const id of last.keys()) {
    const fromIdx = fromIndex ? fromIndex[id] : undefined
    if (typeof fromIdx === 'number' && fromIdx > 0) { out[id] = fromIdx; continue }
    const est = best.get(id)
    out[id] = est !== undefined && Number.isFinite(est) ? est : 0
  }
  return out
}
