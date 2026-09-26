// 覆盖场单格链路预算（D-079）：C++ `geo::coverage_cell()`（geo/src/coverage.cpp）的逐行复算。
//
// **C++ 是真理源**（D-074 ① 的三条纪律同样适用）：改动顺序固定为改 C++ → 重生成
// tests/golden/coverage-cells.json → 这里对拍；本文件不得有 C++ 没有的分支。
// 几何与遮挡走的是视距探测已经在用、已经被两份遮挡基准守着的那几件（lookAngles、SceneFrame、
// segmentOcclusion），这里只补一件浏览器里原来没有的：自由空间路损。
//
//   S = P_tx + G_t + G_r − FSPL − L_diff
//   N = −174 + nf + 10·log10(noise_bw_Hz)，noise_bw_Hz = M · fs / nfft
// 接收机前端增益在 S 与 N 里各出现一次、两边抵消（与 tests/regression/crosslayer_pd_chain.py 同式）。

import { lookAngles, type Lla } from '../editor/preview.js'
import type { LocalSceneAdapter } from '../occlusion/adapter.js'
import type { SceneFrame } from '../occlusion/frame.js'
import { segmentOcclusion } from '../occlusion/occlusion.js'

/** 光速：新写代码统一用 299792458（D-009），与 geo/src/link_budget.cpp 的 speed_of_light_mps() 同值。 */
const C_MPS = 299792458.0

export interface CoverageLink {
  tx_power_dBm: number
  tx_gain_dBi: number
  rx_gain_dBi: number
  nf_dB: number
  noise_bw_Hz: number
  frequency_Hz: number
}

export interface CoverageCell {
  distance_m: number
  fspl_dB: number
  diffraction_dB: number
  blocked: boolean
  signal_dBm: number
  noise_dBm: number
  snr_dB: number
  valid: boolean
}

/** EM-P-01 自由空间路损；d ≤ 0 或 f ≤ 0 返回 0，由调用方按 valid 判断（同 C++ fspl_dB）。 */
export function fsplDb(distance_m: number, frequency_Hz: number): number {
  if (!(distance_m > 0) || !(frequency_Hz > 0)) return 0
  const lambda = C_MPS / frequency_Hz
  return 20 * Math.log10((4 * Math.PI * distance_m) / lambda)
}

export interface OcclusionScene { map: LocalSceneAdapter; frame: SceneFrame }

/**
 * 一格一站。`site` / `target` 的 `alt_m` 与场景同一口径，`terrainHeightM` 是显式平地假设的参考平面（铁律 2）；
 * `occ` 为 null 即不算建筑遮挡。刀口衍射一律按 `link.frequency_Hz` 算（与自由空间同一个频率）。
 */
export function coverageCell(site: Lla, target: Lla, terrainHeightM: number,
                             occ: OcclusionScene | null, link: CoverageLink): CoverageCell {
  const c: CoverageCell = {
    distance_m: 0, fspl_dB: 0, diffraction_dB: 0, blocked: false,
    signal_dBm: 0, noise_dBm: 0, snr_dB: 0, valid: false,
  }
  // link_geometry()：距离取两点的地固系弦长；遮挡把两端投到平面帧，z 取离地高差（不是 ENU 的 up）
  c.distance_m = lookAngles(site, target).distance_m
  if (occ && link.frequency_Hz > 0) {
    const tx = occ.frame.point(target.lon, target.lat, target.alt_m - terrainHeightM)
    const rx = occ.frame.point(site.lon, site.lat, site.alt_m - terrainHeightM)
    const r = segmentOcclusion(occ.map, tx, rx, link.frequency_Hz)
    c.blocked = r.blocked
    c.diffraction_dB = r.obstructionLossDb
  }
  if (!(c.distance_m > 0) || !(link.frequency_Hz > 0) || !(link.noise_bw_Hz > 0)) return c
  c.fspl_dB = fsplDb(c.distance_m, link.frequency_Hz)
  c.signal_dBm = link.tx_power_dBm + link.tx_gain_dBi + link.rx_gain_dBi - c.fspl_dB - c.diffraction_dB
  c.noise_dBm = -174.0 + link.nf_dB + 10 * Math.log10(link.noise_bw_Hz)
  c.snr_dB = c.signal_dBm - c.noise_dBm
  c.valid = true
  return c
}
