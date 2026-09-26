// 覆盖场的调用侧：网格、M、Pd 代入、多站合并、等值线、着色（D-079）。
// 单格物理由 cell.test.ts 对 C++ 黄金基准守着，这里只验调用侧没有把它用错。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pdRandom, thresholdForPfa } from '../../results/analytic.js'
import { coverageCell } from './cell.js'
import { bandBins, cellCenter, computeField, gridOf, type FieldInput } from './field.js'
import { contourSegments } from './contour.js'
import { alphaOf, paintField } from './paint.js'

test('检测频段频点数：缺省链（fs 500 kS/s、nfft 1024、±0.45·fs）= 921，与 detections.index.json 的 m_bins 同', () => {
  assert.equal(bandBins(1024, 500000, -225000, 225000), 921)
  // 区间左闭右开：恰落在上限上的频点不算
  assert.equal(bandBins(8, 8, -2, 2), 4)
})

/** 缺省链的检测器：nfft 1024、pfa 1e-3（组件目录缺省）、频段 ±0.45·fs */
const DET = { nfft: 1024, pfa: 1e-3, band_lo_Hz: -225000, band_hi_Hz: 225000 }

const input = (): FieldInput => ({
  bbox: [116.40, 39.985, 116.41, 39.995],
  res_m: 200,
  terrain_height_m: 0,
  sites: [
    { id: 's1', position: { lon: 116.4025, lat: 39.99, alt_m: 30 }, gain_dBi: 3, nf_dB: 6, fs_Hz: 500000, center_Hz: 2.44e9, detector: DET },
    { id: 's2', position: { lon: 116.4075, lat: 39.99, alt_m: 30 }, gain_dBi: 3, nf_dB: 6, fs_Hz: 500000, center_Hz: 2.44e9, detector: DET },
  ],
  target: { tx_power_dBm: -40, tx_gain_dBi: 2, center_Hz: 2.44e9, height_agl_m: 100 },
})

test('每格 Pd = pdRandom(M, η, 10^(snr/10))，snr 取单格链路预算；多站合并 = 1 − Π(1 − Pd_i)', () => {
  const inp = input()
  const r = computeField(inp, null)!
  const g = r.grid
  assert.equal(g.nx * g.ny, r.combined.length)
  assert.equal(r.detector.s1!.m_bins, 921)
  const eta = thresholdForPfa(921, 1e-3)
  for (const [i, j] of [[0, 0], [g.nx - 1, g.ny - 1], [Math.floor(g.nx / 2), 1]] as const) {
    const c = cellCenter(g, i, j)
    const k = j * g.nx + i
    const pds = inp.sites.map((s) => {
      const cell = coverageCell(s.position, { lon: c.lon, lat: c.lat, alt_m: 100 }, 0, null, {
        tx_power_dBm: -40, tx_gain_dBi: 2, rx_gain_dBi: 3, nf_dB: 6, noise_bw_Hz: (921 * 500000) / 1024, frequency_Hz: 2.44e9,
      })
      return pdRandom(921, eta, 10 ** (cell.snr_dB / 10))
    })
    assert.ok(Math.abs(r.perSite.s1![k]! - pds[0]!) < 1e-6)
    assert.ok(Math.abs(r.perSite.s2![k]! - pds[1]!) < 1e-6)
    assert.ok(Math.abs(r.combined[k]! - (1 - (1 - pds[0]!) * (1 - pds[1]!))) < 1e-6)
  }
  // 合并不小于任何一站
  for (let k = 0; k < r.combined.length; k++) {
    assert.ok(r.combined[k]! >= Math.max(r.perSite.s1![k]!, r.perSite.s2![k]!) - 1e-7)
  }
})

test('离站越远 Pd 不增（同高、无建筑、单站）', () => {
  const inp = input()
  inp.sites = [inp.sites[0]!]
  inp.target.tx_power_dBm = -60
  const r = computeField(inp, null)!
  const g = r.grid
  const jMid = Math.floor(g.ny / 2)
  const iSite = Math.floor(((116.4025 - g.bbox[0]) / (g.bbox[2] - g.bbox[0])) * g.nx)
  for (let i = iSite + 1; i + 1 < g.nx; i++) {
    assert.ok(r.perSite.s1![jMid * g.nx + i + 1]! <= r.perSite.s1![jMid * g.nx + i]! + 1e-7)
  }
})

test('中止：aborted 返回真即返回 null，不给半成品', () => {
  assert.equal(computeField(input(), null, { aborted: () => true }), null)
})

test('网格：格心等分包围盒，第 0 行在北', () => {
  const g = gridOf([116.0, 39.0, 116.1, 39.1], 1000)
  assert.ok(g.nx > 0 && g.ny > 0)
  const nw = cellCenter(g, 0, 0)
  const se = cellCenter(g, g.nx - 1, g.ny - 1)
  assert.ok(nw.lat > se.lat && nw.lon < se.lon)
})

test('等值线：单峰得一个闭合环（段数 = 4），鞍点两种连法都按中心均值决定', () => {
  const g = gridOf([0, 0, 0.003, 0.003], 111)   // 3 × 3
  assert.equal(g.nx * g.ny, 9)
  const peak = [0, 0, 0, 0, 1, 0, 0, 0, 0]
  assert.equal(contourSegments(g, peak, 0.5).length, 4)
  // 2 × 2 鞍点：tl、br 高（码 10）
  const g2 = gridOf([0, 0, 0.002, 0.002], 111)
  assert.equal(g2.nx * g2.ny, 4)
  const hiMid = contourSegments(g2, [1, 0.2, 0.2, 1], 0.5)   // 均值 0.6 ≥ 0.5：高角相连
  const loMid = contourSegments(g2, [0.6, 0, 0, 0.6], 0.5)   // 均值 0.3 < 0.5：高角各自包起来
  assert.equal(hiMid.length, 2)
  assert.equal(loMid.length, 2)
  assert.notDeepEqual(hiMid, loMid)
  assert.equal(contourSegments(g2, [0, 0, 0, 0], 0.5).length, 0)
})

test('着色：低于 0.02 全透明，不透明度随 Pd 单调增到 0.46（em-demo 同值）', () => {
  assert.equal(alphaOf(0), 0)
  assert.equal(alphaOf(0.019), 0)
  assert.ok(Math.abs(alphaOf(0.05) - 0.18) < 1e-12)
  assert.ok(Math.abs(alphaOf(0.5) - 0.34) < 1e-12)
  assert.ok(Math.abs(alphaOf(1) - 0.46) < 1e-12)
  const px = paintField(2, 1, [0, 1])
  assert.equal(px[3], 0)
  assert.equal(px[7], Math.round(0.46 * 255))
  assert.deepEqual([px[4], px[5], px[6]], [0xfd, 0xe7, 0x25])   // viridis 顶端
})

test('目标发射中心落在站的检测频段之外：该站逐格 Pd = 虚警率，并照实标 outOfBand', () => {
  const inp = input()
  inp.sites = [{ ...inp.sites[0]!, center_Hz: 2.40e9 }]   // 站调在 2.40 GHz，目标 2.44 GHz，差 40 MHz ≫ ±225 kHz
  inp.target.tx_power_dBm = 30
  const r = computeField(inp, null)!
  assert.equal(r.outOfBand.s1, true)
  for (const v of r.perSite.s1!) assert.ok(Math.abs(v - 1e-3) < 1e-6)
})
