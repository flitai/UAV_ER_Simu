import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoRange, ceil10, floor10, niceTicks, MAX_RANGE_DB } from './scale.js'

test('autoRange：忽略 −300 精确零，ref 向上取整到 10，range ≥ 20', () => {
  const v = new Float32Array(1000)
  for (let i = 0; i < 1000; i++) v[i] = -132 + (i % 5)     // 噪声底 −132…−128
  v[500] = -69.9997                                           // 单音峰
  v[7] = -300
  const r = autoRange(v)!
  assert.equal(r.refLevel_dB, -60)
  assert.equal(r.range_dB, -60 - floor10(-132))
  assert.equal(autoRange(new Float32Array([-300, -300])), null)
  assert.equal(autoRange(new Float32Array(0)), null)
  assert.deepEqual(autoRange(new Float32Array([-45])), { refLevel_dB: -40, range_dB: 20 })
  assert.equal(ceil10(-69.9), -60)
  assert.equal(floor10(-0.1), -10)
  assert.equal(Object.is(ceil10(-0.0), 0), true)
})

test('niceTicks：1/2/5 步进、含端点格点、不含 −0', () => {
  assert.deepEqual(niceTicks(-140, -60, 8), [-140, -130, -120, -110, -100, -90, -80, -70, -60])
  assert.deepEqual(niceTicks(0, 1, 5), [0, 0.2, 0.4, 0.6, 0.8, 1])
  assert.deepEqual(niceTicks(-2.5e5, 2.5e5, 5), [-200000, -100000, 0, 100000, 200000])
  assert.ok(niceTicks(-1, 1, 4).every((t) => !Object.is(t, -0)))
  assert.deepEqual(niceTicks(1, 1, 5), [])
})

test('自动量程封顶 150 dB：没有物理噪声源的观测点不会被数值残余拉垮', () => {
  // 取自 golden-01 的 S0（2026-09-21 实测）：峰 27 dBm，73.4% 的 bin 是精确零，
  // 剩下的「非零」值 10% 分位在 −293.8——忽略精确零这一条挡不住它们。
  const vals = [27, 21, 21, ...Array(200).fill(-293.8), ...Array(50).fill(-140)]
  const r = autoRange(vals)!
  assert.equal(r.refLevel_dB, 30)
  assert.equal(r.range_dB, MAX_RANGE_DB, '不封顶的话这里会是 330 dB')
})

test('有真实热噪声底时封顶不起作用（S2 那一档只要 102 dB）', () => {
  // 峰 −18.6、热噪声底 −120.7：ceil10 → −10，floor10 → −130，range 120 dB < 150
  const vals = [-18.6, -30, ...Array(200).fill(-120.7)]
  const r = autoRange(vals)!
  assert.equal(r.refLevel_dB, -10)
  assert.ok(r.range_dB < MAX_RANGE_DB, `实到 ${r.range_dB}`)
  assert.equal(r.range_dB, 120)
})
