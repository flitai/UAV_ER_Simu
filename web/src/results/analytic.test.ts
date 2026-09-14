// 解析检出率的 TS 复刻对 Python 参考的逐值对拍（C-9，铁律 10）。
// 基准 tests/golden/analytic-pd.json 由 algos/reference/gen_analytic_golden.py 从
// algos/reference/energy_detector.py 生成；判据 rel ≤ 1e-9。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  analyticRocFamily, familySnrsDb, pdDeterministic, pdRandom, pfaOf,
  regularizedGammaQ, snrDbToLinear, thresholdForPfa,
} from './analytic.js'

const GOLDEN = fileURLToPath(new URL('../../../tests/golden/analytic-pd.json', import.meta.url))

interface Golden {
  tolerance: { relative: number }
  gamma_q: Array<{ a: number; x: number; q: number }>
  thresholds: Array<{ m_bins: number; pfa: number; eta: number }>
  pd_random: Array<{ m_bins: number; eta: number; snr_dB: number; pd: number }>
  pd_deterministic: Array<{ m_bins: number; eta: number; snr_dB: number; pd: number }>
  degenerate: Array<{ m_bins: number; eta: number; pfa: number }>
}

const g = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden
const TOL = g.tolerance.relative

/** 相对误差；期望为 0 时退回绝对误差（Q(a,x) 在 x ≫ a 时会到下溢量级） */
function rel(got: number, want: number): number {
  const d = Math.abs(got - want)
  return Math.abs(want) > 1e-300 ? d / Math.abs(want) : d
}

test(`正则化上不完全伽马 Q(a,x) 与 Python 参考逐值一致（${g.gamma_q.length} 点，rel ≤ ${TOL}）`, () => {
  let worst = 0
  let worstAt = ''
  for (const c of g.gamma_q) {
    const got = regularizedGammaQ(c.a, c.x)
    const r = rel(got, c.q)
    if (r > worst) { worst = r; worstAt = `a=${c.a} x=${c.x}` }
  }
  assert.ok(worst <= TOL, `最大相对误差 ${worst.toExponential(3)} 在 ${worstAt}，超过 ${TOL}`)
})

test(`门限反解 Q(M, M·η) = pfa 与 Python 参考逐值一致（${g.thresholds.length} 点）`, () => {
  for (const c of g.thresholds) {
    assert.ok(rel(thresholdForPfa(c.m_bins, c.pfa), c.eta) <= TOL,
      `M=${c.m_bins} pfa=${c.pfa}`)
  }
})

test(`随机型检出率与 Python 参考逐值一致（${g.pd_random.length} 点）`, () => {
  for (const c of g.pd_random) {
    assert.ok(rel(pdRandom(c.m_bins, c.eta, snrDbToLinear(c.snr_dB)), c.pd) <= TOL,
      `M=${c.m_bins} snr=${c.snr_dB} dB`)
  }
})

test(`确定型（泊松混合）检出率与 Python 参考逐值一致（${g.pd_deterministic.length} 点）`, () => {
  for (const c of g.pd_deterministic) {
    assert.ok(rel(pdDeterministic(c.m_bins, c.eta, snrDbToLinear(c.snr_dB)), c.pd) <= TOL,
      `M=${c.m_bins} snr=${c.snr_dB} dB`)
  }
})

test('s → 0 时两式都退化为 Pfa = Q(M, M·η)（energy_detector.py 钉住的不变量）', () => {
  for (const c of g.degenerate) {
    assert.ok(rel(pfaOf(c.m_bins, c.eta), c.pfa) <= TOL)
    assert.ok(rel(pdRandom(c.m_bins, c.eta, 0), c.pfa) <= TOL)
    assert.ok(rel(pdDeterministic(c.m_bins, c.eta, 0), c.pfa) <= TOL)
  }
})

test('曲线族：每档一条、pfa 降序、pd 单调不增，且信噪比越高同一 pfa 下 pd 越大', () => {
  const snrs = familySnrsDb(921)
  const fam = analyticRocFamily(921, snrs, 24)
  assert.equal(fam.length, snrs.length)
  for (const c of fam) {
    assert.equal(c.points.length, 24)
    for (let i = 1; i < c.points.length; i++) {
      assert.ok(c.points[i].pfa <= c.points[i - 1].pfa + 1e-12, 'pfa 应降序')
      assert.ok(c.points[i].pd <= c.points[i - 1].pd + 1e-12, 'pd 应单调不增')
    }
  }
  for (let k = 1; k < fam.length; k++) {
    for (let i = 0; i < 24; i++) {
      assert.ok(fam[k].points[i].pd >= fam[k - 1].points[i].pd - 1e-12,
        `snr ${fam[k].snr_dB} dB 的 pd 应不低于 ${fam[k - 1].snr_dB} dB`)
    }
  }
  assert.deepEqual(analyticRocFamily(0, snrs), [], 'M 无效时不画，不猜')
})

test('信噪比档随 M 走：中心取 −5·log10(M) 加 −2…+8 dB，四档 M 上都铺满 pfa = 1e-3 的转换区', () => {
  assert.deepEqual(familySnrsDb(921), [-17, -15, -13, -11, -9, -7])
  assert.deepEqual(familySnrsDb(1), [-2, 0, 2, 4, 6, 8])
  // 最低一档接近 0、最高一档到 0.65 以上，不会整族贴在 1 上（固定档的老毛病），也不会整族贴在 0 上
  for (const M of [5, 32, 921, 2000]) {
    const eta = thresholdForPfa(M, 1e-3)
    const fam = familySnrsDb(M)
    const lo = pdRandom(M, eta, snrDbToLinear(fam[0]))
    const hi = pdRandom(M, eta, snrDbToLinear(fam[fam.length - 1]))
    assert.ok(lo < 0.05 && hi > 0.65, `M ${M}: lo ${lo} hi ${hi}`)
  }
})
