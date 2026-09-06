import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucketIndexForTime, envelopeGroupBounds, envelopeRange, envelopeToDb, envelopeUnit, groupForPixelRows } from './envelopeMap.js'
import type { Extract } from './reduce.js'

test('envelopeToDb / envelopeUnit', () => {
  assert.equal(envelopeToDb(1), 0)
  assert.ok(Math.abs(envelopeToDb(0.001) + 60) < 1e-9)
  assert.equal(envelopeToDb(0), -300)
  assert.equal(envelopeUnit('sqrt_mW'), 'dBm')
  assert.equal(envelopeUnit('linear_FS'), 'dBFS')
  assert.equal(envelopeUnit(undefined), 'dBFS')
})

test('groupForPixelRows：桶细于像素（多桶一像素）与桶粗于像素（一桶多像素）都按时间最近邻，窗外 −1', () => {
  const dt = 0.01
  // 100 桶（1 s）归约成 10 组，窗口 [0, 1]，H = 5 像素：每像素 0.2 s = 2 组，取像素中心
  const fine: Extract = { data: new Float32Array(30), rows: 10, cols: 3, t0: 0, t1: 1, f0: null, f1: null }
  assert.deepEqual(envelopeGroupBounds(fine, dt), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
  const m = groupForPixelRows(fine, dt, { t0: 0, t1: 1 }, 5)
  assert.deepEqual(Array.from(m), [9, 7, 5, 3, 1])
  // 3 桶（0.03 s）不归约，窗口 [0, 0.03]，H = 9 像素：每桶 3 像素
  const coarse: Extract = { data: new Float32Array(9), rows: 3, cols: 3, t0: 0, t1: 0.03, f0: null, f1: null }
  assert.deepEqual(Array.from(groupForPixelRows(coarse, dt, { t0: 0, t1: 0.03 }, 9)), [2, 2, 2, 1, 1, 1, 0, 0, 0])
  // 窗口比数据宽：上下各有窗外像素
  const w = groupForPixelRows(coarse, dt, { t0: -0.03, t1: 0.06 }, 9)
  assert.deepEqual(Array.from(w), [-1, -1, -1, 2, 1, 0, -1, -1, -1])
  assert.equal(bucketIndexForTime(0.0251, 0.01), 2)
})

test('envelopeRange：上限取 max 的 dB 向上取整，下限取 rms 的 dB 向下取整减 10，跨度 ≥ 20', () => {
  const rows = new Float32Array([0, 0.5, 0.1, 0, 0.2, 0.05])      // max 0.5 → −6.0 dB；rms 最小 0.05 → −26 dB
  assert.deepEqual(envelopeRange(rows, 2), { lo: -40, hi: 0 })
  assert.equal(envelopeRange(new Float32Array([0, 0, 0]), 1), null)
  assert.deepEqual(envelopeRange(new Float32Array([0, 1, 1]), 1), { lo: -20, hi: 0 })
})
