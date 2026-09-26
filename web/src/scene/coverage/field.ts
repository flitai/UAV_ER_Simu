// 覆盖场（D-079）：网格上每格、每站的检测概率 Pd，与多站合并。
//
// 每一格的物理全在 cell.ts（对 C++ 黄金基准逐格对拍）；Pd 用 results/analytic.ts 的解析式
// （对 Python 参考的黄金基准 analytic-pd.json 对拍）。本文件只做两件调用侧的事：
//   ① 摆网格——格心的经纬度是**显示采样**，不是物理量，按观测区域包围盒等分即可；
//   ② 按检测器参数算出 M、门限与噪声带宽，逐格代进去，再按站合并。
// 两件都不改变任何一格的物理，故不违反「TS 不得有 C++ 没有的分支」（D-074 ①）。
//
// 口径（与典型链路的能量检测器一致，D-026、D-063）：
//   频段按站取该站检测器的 band_lo / band_hi（框图里没有这个站的检测器时由调用方按 compile.ts 的
//   ±0.45·fs 派生），M = fftshift 后 f ∈ [lo, hi) 的频点数
//   （engine/src/processing.cpp 的 build_mask() 同式；缺省链 fs 500 kS/s、nfft 1024 时 M = 921）；
//   η = thresholdForPfa(M, pfa)；噪声带宽 = M·fs/nfft；Pd = pdRandom(M, η, 10^(snr/10))（随机型，
//   D-068 ⑤：确定型级数在 M≈921 下太慢）。**单帧** Pd：一帧 nfft 个样点判一次。
//   多站合并：Pd = 1 − Π(1 − Pd_i)，线性域（铁律 5）。

import { pdRandom, thresholdForPfa } from '../../results/analytic.js'
import type { Lla } from '../editor/preview.js'
import { coverageCell, type OcclusionScene } from './cell.js'

export interface CoverageSite {
  id: string
  /** 场景站位，alt_m 与场景同口径 */
  position: Lla
  gain_dBi: number
  nf_dB: number
  fs_Hz: number
  /** 站的接收中心频率（检测频段相对它） */
  center_Hz: number
  /** 这个站的能量检测器：频段相对站的中心频率 */
  detector: DetectorParams
}

export interface CoverageTarget {
  tx_power_dBm: number
  tx_gain_dBi: number
  center_Hz: number
  /** 假设目标的离地高度（m） */
  height_agl_m: number
}

export interface DetectorParams { nfft: number; pfa: number; band_lo_Hz: number; band_hi_Hz: number }

export interface FieldInput {
  /** [west, south, east, north]，度 */
  bbox: [number, number, number, number]
  /** 目标格边长（m）。实际格数按包围盒尺寸取整，格心等分 */
  res_m: number
  terrain_height_m: number
  sites: CoverageSite[]
  target: CoverageTarget
}

export interface GridGeom {
  nx: number
  ny: number
  bbox: [number, number, number, number]
  dLon: number
  dLat: number
}

export interface FieldResult {
  grid: GridGeom
  /** 逐站 Pd，行主序、**第 0 行在北**（与图像同向），长度 nx·ny */
  perSite: Record<string, Float32Array>
  /** 多站合并 */
  combined: Float32Array
  /** 每站的 M、门限与噪声带宽，照实给出（探针与图例用） */
  detector: Record<string, { m_bins: number; eta: number; noise_bw_Hz: number }>
  /**
   * 目标发射中心落在这个站的检测频段之外：该站**测不到**，逐格 Pd 恒等于虚警率。照实给出，
   * 不把它悄悄当成「频段内」算（铁律 15）——框图里改了站的中心频率或频段时它就会出现。
   */
  outOfBand: Record<string, boolean>
  /** 被楼切断的格数（逐站），计算量的事实，不作判断 */
  blocked: Record<string, number>
  ms: number
}

/** 检测频段内的频点数：fftshift 后 f ∈ [lo, hi)，与 EnergyDetector::build_mask() 同式。 */
export function bandBins(nfft: number, fs_Hz: number, lo_Hz: number, hi_Hz: number): number {
  let m = 0
  const half = Math.trunc(nfft / 2)
  for (let k = 0; k < nfft; k++) {
    const f = ((k - half) * fs_Hz) / nfft
    if (f >= lo_Hz && f < hi_Hz) m++
  }
  return m
}

/** 包围盒 → 网格。纬向 111132 m/度、经向按包围盒中纬度的余弦——只决定格心摆在哪，不进物理。 */
export function gridOf(bbox: [number, number, number, number], res_m: number): GridGeom {
  const [w, s, e, n] = bbox
  const latMid = ((s + n) / 2) * (Math.PI / 180)
  const widthM = (e - w) * 111320 * Math.cos(latMid)
  const heightM = (n - s) * 111132
  const nx = Math.max(1, Math.round(widthM / res_m))
  const ny = Math.max(1, Math.round(heightM / res_m))
  return { nx, ny, bbox, dLon: (e - w) / nx, dLat: (n - s) / ny }
}

/** 第 (i, j) 格的格心；j = 0 在北。 */
export function cellCenter(g: GridGeom, i: number, j: number): { lon: number; lat: number } {
  return { lon: g.bbox[0] + (i + 0.5) * g.dLon, lat: g.bbox[3] - (j + 0.5) * g.dLat }
}

export interface FieldHooks {
  /** 每算完一行回报一次（0..1） */
  onProgress?: (done: number) => void
  /** 返回真即中止（新请求到了），函数返回 null */
  aborted?: () => boolean
}

export function computeField(input: FieldInput, occ: OcclusionScene | null, hooks: FieldHooks = {}): FieldResult | null {
  const t0 = Date.now()
  const g = gridOf(input.bbox, input.res_m)
  const n = g.nx * g.ny
  const perSite: Record<string, Float32Array> = {}
  const detector: FieldResult['detector'] = {}
  const blocked: Record<string, number> = {}
  const outOfBand: Record<string, boolean> = {}
  const combinedMiss = new Float64Array(n).fill(1)   // Π(1 − Pd_i)，最后取 1 − 它
  const total = input.sites.length * g.ny
  let rowsDone = 0

  for (const site of input.sites) {
    const d = site.detector
    const m = bandBins(d.nfft, site.fs_Hz, d.band_lo_Hz, d.band_hi_Hz)
    const eta = m > 0 ? thresholdForPfa(m, d.pfa) : Number.NaN
    const noiseBw = (m * site.fs_Hz) / d.nfft
    detector[site.id] = { m_bins: m, eta, noise_bw_Hz: noiseBw }
    const df = input.target.center_Hz - site.center_Hz
    const inBand = df >= d.band_lo_Hz && df < d.band_hi_Hz   // 与频点掩码同一个左闭右开
    outOfBand[site.id] = !inBand
    const out = new Float32Array(n)
    let nb = 0
    const link = {
      tx_power_dBm: input.target.tx_power_dBm, tx_gain_dBi: input.target.tx_gain_dBi,
      rx_gain_dBi: site.gain_dBi, nf_dB: site.nf_dB, noise_bw_Hz: noiseBw, frequency_Hz: input.target.center_Hz,
    }
    for (let j = 0; j < g.ny; j++) {
      if (hooks.aborted?.()) return null
      for (let i = 0; i < g.nx; i++) {
        const c = cellCenter(g, i, j)
        const target: Lla = { lon: c.lon, lat: c.lat, alt_m: input.terrain_height_m + input.target.height_agl_m }
        const cell = coverageCell(site.position, target, input.terrain_height_m, occ, link)
        // 格心恰与站重合（距离为零）：不编一个数，记 0 并算作不可测（铁律 15）
        const pd = cell.valid && m > 0 ? pdRandom(m, eta, inBand ? 10 ** (cell.snr_dB / 10) : 0) : 0
        const k = j * g.nx + i
        out[k] = pd
        combinedMiss[k]! *= 1 - pd
        if (cell.blocked) nb++
      }
      rowsDone++
      hooks.onProgress?.(rowsDone / total)
    }
    perSite[site.id] = out
    blocked[site.id] = nb
  }
  const combined = new Float32Array(n)
  for (let k = 0; k < n; k++) combined[k] = 1 - combinedMiss[k]!
  return { grid: g, perSite, combined, detector, outOfBand, blocked, ms: Date.now() - t0 }
}
