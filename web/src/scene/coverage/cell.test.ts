// 覆盖场单格链路预算：浏览器侧对 C++ 黄金基准逐格对拍（D-079；C++ 是真理源）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { LocalSceneAdapter, type Building } from '../occlusion/adapter.js'
import { SceneFrame } from '../occlusion/frame.js'
import { coverageCell, fsplDb, type CoverageLink } from './cell.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const golden = JSON.parse(readFileSync(join(ROOT, 'tests/golden/coverage-cells.json'), 'utf8'))

const rel = (a: number, b: number) => {
  const s = Math.max(Math.abs(a), Math.abs(b))
  return s > 0 ? Math.abs(a - b) / s : Math.abs(a - b)
}

test('覆盖场：自由空间路损的解析锚点 2.4 GHz / 1 km = 100.052008 dB', () => {
  assert.ok(Math.abs(fsplDb(1000, 2.4e9) - 100.052008) < 1e-5)
  assert.equal(fsplDb(0, 2.4e9), 0)
})

test('覆盖场：浏览器逐格复算 C++ 黄金基准（距离 rel ≤ 1e-9、dB 量 abs ≤ 1e-8），视距判定逐例相同', () => {
  const map = new LocalSceneAdapter()
  map.setBuildings(golden.buildings.map((b: Record<string, unknown>): Building => ({
    id: String(b.id), ringX: b.ring_x as number[], ringY: b.ring_y as number[],
    baseM: Number(b.base_m), heightM: Number(b.height_m),
  })))
  const frame = new SceneFrame(golden.origin.lon, golden.origin.lat)
  const base = golden.link as Omit<CoverageLink, 'frequency_Hz'>
  let worst = 0
  let blocked = 0
  for (const c of golden.cases) {
    const [slon, slat, salt] = c.site as number[]
    const [tlon, tlat, talt] = c.target as number[]
    const got = coverageCell({ lon: slon!, lat: slat!, alt_m: salt! }, { lon: tlon!, lat: tlat!, alt_m: talt! },
      golden.terrain_height_m, { map, frame }, { ...base, frequency_Hz: c.frequency_Hz })
    assert.equal(got.valid, c.out.valid)
    assert.equal(got.blocked, c.out.blocked, `视距判定不同：${JSON.stringify(c.target)}`)
    // 判据两种形状（基准 _meta.tolerance）：距离与自由空间路损用相对差；信噪比、刀口损耗这类
    // dB 量会落在 0 附近，相对差在那里被放大成没有意义的大数（实测 snr 0.30 dB 那格
    // abs 1.6e-10 dB 就是 rel 5.2e-10），用绝对差。两侧的差来自椭球换算两家实现差 1.7e-9 m。
    for (const k of ['distance_m', 'fspl_dB'] as const) {
      const e = rel(got[k], c.out[k])
      assert.ok(e <= 1e-9, `${k} 相对差 ${e}（${JSON.stringify(c.target)} @ ${c.frequency_Hz}）`)
    }
    for (const k of ['diffraction_dB', 'signal_dBm', 'noise_dBm', 'snr_dB'] as const) {
      const e = Math.abs(got[k] - c.out[k])
      worst = Math.max(worst, e)
      assert.ok(e <= 1e-8, `${k} 绝对差 ${e} dB（${JSON.stringify(c.target)} @ ${c.frequency_Hz}）`)
    }
    if (got.blocked) blocked++
  }
  assert.equal(golden.cases.length, 85)
  assert.equal(blocked, 20)
  console.log(`coverage-cells：85 例，dB 量最差绝对差 ${worst.toExponential(3)} dB`)
})
