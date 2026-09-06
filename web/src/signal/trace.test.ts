import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TraceState, avgLinear, markerReadout, peakOf } from './trace.js'

const row = (...v: number[]) => new Float32Array(v)

test('single / maxhold / minhold / avg 与 reset、configure', () => {
  const t = new TraceState('single', 16)
  assert.equal(t.value(), null)
  t.push(row(-100, -50)); t.push(row(-90, -60))
  assert.deepEqual(Array.from(t.value()!), [-90, -60])
  t.configure('maxhold', 16)
  t.push(row(-100, -50)); t.push(row(-90, -60))
  assert.deepEqual(Array.from(t.value()!), [-90, -50])
  t.configure('minhold', 16)
  t.push(row(-100, -50)); t.push(row(-90, -60))
  assert.deepEqual(Array.from(t.value()!), [-100, -60])
  t.configure('avg', 2)
  t.push(row(-100, -100)); t.push(row(-100, -100)); t.push(row(-90, -100))
  const v = t.value()!
  const expect = new Float32Array(2)
  avgLinear([row(-100, -100), row(-90, -100)], expect)
  assert.deepEqual(Array.from(v), Array.from(expect))
  assert.equal(t.frames, 2)
  t.reset()
  assert.equal(t.value(), null)
})

test('avgLinear 与线性域均值同式：两帧 −100 与 −90 的平均是 −93.9', () => {
  const out = new Float32Array(1)
  avgLinear([row(-100), row(-90)], out)
  assert.ok(Math.abs(out[0]! - 10 * Math.log10((1e-10 + 1e-9) / 2)) < 1e-5)
})

test('peakOf 忽略精确零；markerReadout 差值', () => {
  assert.deepEqual(peakOf(row(-300, -80, -70.5, -90)), { k: 2, v: -70.5 })
  assert.equal(peakOf(row(-300, -300)), null)
  assert.equal(peakOf(null), null)
  const r = markerReadout({ f: 2.44e9, v: -70 }, { f: 2.4401e9, v: -82.4 })
  assert.equal(r.df, 100000)
  assert.ok(Math.abs(r.dv! + 12.4) < 1e-9)
  assert.deepEqual(markerReadout(null, { f: 1, v: 1 }), { df: null, dv: null })
})
