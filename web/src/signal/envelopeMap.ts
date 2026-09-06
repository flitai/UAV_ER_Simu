// 包络竖条的映射（U-3，D-048）：包络行是 |x| 的 min / max / rms，画成 dB（20·log10）；
// 与瀑布共时间轴，像素行 → 组序号按时间最近邻、无覆盖 −1。

import type { Extract } from './reduce.js'
import { FLOOR_DB, groupBounds, yToTime } from './viewport.js'

export function envelopeToDb(v: number): number {
  return v > 0 && Number.isFinite(v) ? 20 * Math.log10(v) : FLOOR_DB
}

/** 索引 scale → 单位：sqrt_mW 已标定为 dBm，其余（linear_FS）为 dBFS。 */
export function envelopeUnit(scale: string | undefined): 'dBm' | 'dBFS' {
  return scale === 'sqrt_mW' ? 'dBm' : 'dBFS'
}

/** 服务端返回的包络组边界（相对首行）：由覆盖的时间范围反推行数，再按 groupBounds 分组。 */
export function envelopeGroupBounds(ext: Extract, dt: number): number[] {
  const nRows = Math.max(0, Math.round((ext.t1 - ext.t0) / dt))
  return groupBounds(nRows, ext.rows)
}

/**
 * 像素行 y（0 = 顶 = win.t1）→ ext 里的组序号；像素中心时刻不在 [ext.t0, ext.t1) 内给 −1。
 * 组 j 覆盖 [ext.t0 + rb[j]·dt, ext.t0 + rb[j+1]·dt)。
 */
export function groupForPixelRows(ext: Extract, dt: number, win: { t0: number; t1: number }, H: number): Int32Array {
  const out = new Int32Array(H).fill(-1)
  if (ext.rows === 0 || !(dt > 0)) return out
  const rb = envelopeGroupBounds(ext, dt)
  for (let y = 0; y < H; y++) {
    const t = yToTime(y + 0.5, H, win.t0, win.t1)
    if (t < ext.t0 || t >= ext.t1) continue
    const r = Math.floor((t - ext.t0) / dt + 1e-9)   // 像素中心恰在桶边界时的浮点误差
    // rb 单调，二分找 j 使 rb[j] ≤ r < rb[j+1]
    let lo = 0
    let hi = ext.rows - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (rb[mid]! <= r) lo = mid
      else hi = mid - 1
    }
    out[y] = lo
  }
  return out
}

/** 桶序号 ← 时刻（跟随模式从环取行）。 */
export function bucketIndexForTime(t: number, dt: number): number {
  return Math.floor(t / dt)
}

/** 自有自动量程：上限取 max_abs 的最大 dB 向上取整到 10，下限取 rms 的最小 dB 向下取整再减 10，跨度 ≥ 20。 */
export function envelopeRange(rows: ArrayLike<number>, count: number): { lo: number; hi: number } | null {
  let hi = Number.NEGATIVE_INFINITY
  let lo = Number.POSITIVE_INFINITY
  for (let j = 0; j < count; j++) {
    const mx = envelopeToDb(rows[j * 3 + 1]!)
    const rms = envelopeToDb(rows[j * 3 + 2]!)
    if (mx > FLOOR_DB && mx > hi) hi = mx
    if (rms > FLOOR_DB && rms < lo) lo = rms
  }
  if (hi === Number.NEGATIVE_INFINITY) return null
  if (lo === Number.POSITIVE_INFINITY) lo = hi
  const top = Math.ceil(hi / 10) * 10 + 0
  let bottom = Math.floor(lo / 10) * 10 - 10
  if (top - bottom < 20) bottom = top - 20
  return { lo: bottom, hi: top }
}
