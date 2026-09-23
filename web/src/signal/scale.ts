// dB 量程与刻度（U-3，09 §7.2 参考电平与动态范围行；D-048）。

import { FLOOR_DB } from './viewport.js'

export const ceil10 = (v: number) => Math.ceil(v / 10) * 10 + 0
export const floor10 = (v: number) => Math.floor(v / 10) * 10 + 0

/**
 * 自动量程能张开的最大动态范围，dB。
 *
 * 为什么要封顶（2026-09-21 实测逼出来的）：S0 与 S1 这两个观测点**没有物理噪声源**
 * ——噪声要到接收机前端才注入——所以它们谱上的「底」全是 float32 的舍入残余。
 * golden-01 的 S0 实测：73.4% 的 bin 是精确零（记作 −300 dBm），
 * 而剩下的「非零」值里 10% 分位是 **−293.8 dBm**，于是「忽略精确零」这一条根本不够，
 * 自动量程照样被拉到 −300，整幅图变成满屏数值噪声的梳齿，真正有意义的那根谱线挤在顶上。
 *
 * 150 dB 的依据：① S2 / S3 / S4 的真实热噪声底实测只需要 **102 dB**（峰 −18.6、底 −120.7）；
 * ② float32 的 IQ 加 1024 点 FFT 的处理增益，理论动态范围约 174 dB，
 * 超出这个数的一定是数值伪影；③ 真实频谱仪的显示动态范围也就 100–120 dB。
 * 取 150 dB 给真实信号留了 1.5 倍余量，又把 S0 那片 160 dB 以下的数值噪声挡在外面。
 */
export const MAX_RANGE_DB = 150

/**
 * 自动量程：ref = ceil10(最大值)，floor = floor10(10% 分位)，range = max(20, ref − floor)，
 * 且 range 不超过 MAX_RANGE_DB。
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
  return { refLevel_dB: ref, range_dB: Math.min(MAX_RANGE_DB, Math.max(20, ref - floor)) }
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
