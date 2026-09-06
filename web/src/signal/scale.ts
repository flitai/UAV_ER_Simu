// dB 量程与刻度（U-3，09 §7.2 参考电平与动态范围行；D-048）。

import { FLOOR_DB } from './viewport.js'

export const ceil10 = (v: number) => Math.ceil(v / 10) * 10 + 0
export const floor10 = (v: number) => Math.floor(v / 10) * 10 + 0

/**
 * 自动量程：ref = ceil10(最大值)，floor = floor10(10% 分位)，range = max(20, ref − floor)。
 * 忽略 ≤ floorDb 的精确零与非有限值；为了在 200 万个值上也是毫秒级，分位数按等距抽样 ≤ 65536 个求。
 */
export function autoRange(values: ArrayLike<number>, floorDb = FLOOR_DB): { refLevel_dB: number; range_dB: number } | null {
  const n = values.length
  if (n === 0) return null
  const stride = Math.max(1, Math.floor(n / 65536))
  const sample: number[] = []
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < n; i++) {
    const v = values[i]!
    if (!(v > floorDb) || !Number.isFinite(v)) continue
    if (v > max) max = v
    if (i % stride === 0) sample.push(v)
  }
  if (max === Number.NEGATIVE_INFINITY) return null
  if (sample.length === 0) sample.push(max)
  sample.sort((a, b) => a - b)
  const p10 = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.1))]!
  const ref = ceil10(max)
  const floor = floor10(p10)
  return { refLevel_dB: ref, range_dB: Math.max(20, ref - floor) }
}

/** 1 / 2 / 5 步进的刻度值，含端点内的所有格点，最多约 maxTicks 个。 */
export function niceTicks(lo: number, hi: number, maxTicks: number): number[] {
  if (!(hi > lo) || !(maxTicks >= 1)) return []
  const raw = (hi - lo) / maxTicks
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  const out: number[] = []
  const first = Math.ceil(lo / step - 1e-9)
  const last = Math.floor(hi / step + 1e-9)
  for (let i = first; i <= last; i++) out.push(Number((i * step).toPrecision(12)) + 0)
  return out
}
