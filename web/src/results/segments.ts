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

export function segmentsOf(rows: readonly DetectionRow[], dt_s: number, stride = 1): DetectionSegment[] {
  const by = new Map<string, DetectionSegment>()
  for (const r of rows) {
    if (!r.hit || r.segment_id === null || r.segment_id === undefined) continue
    const key = `${r.node_id}|${r.segment_id}`
    const prev = by.get(key)
    const p = typeof r.band_power_dBm === 'number' ? r.band_power_dBm : null
    if (!prev) {
      by.set(key, {
        key, node_id: r.node_id, site_id: r.site_id ?? null, segment_id: r.segment_id,
        t_start: r.t_s, t_end: r.t_s + dt_s, frames: stride,
        peak_statistic: r.statistic, peak_band_power_dBm: p, peak_snr_dB: r.snr_dB,
        overload: r.overload, f_lo_Hz: r.f_lo_Hz, f_hi_Hz: r.f_hi_Hz,
      })
      continue
    }
    if (r.t_s < prev.t_start) prev.t_start = r.t_s
    if (r.t_s + dt_s > prev.t_end) prev.t_end = r.t_s + dt_s
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
