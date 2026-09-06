import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoRange, ceil10, floor10, niceTicks } from './scale.js'

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
