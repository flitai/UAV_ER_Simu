import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLut, dbToIndex } from './colormap.js'
import type { Extract } from './reduce.js'
import { buildLiveRows, buildWindowImage, planShift, type LivePaint } from './waterfall.js'
import { groupBounds } from './viewport.js'

test('planShift 三态', () => {
  assert.deepEqual(planShift(-1, 10, 100), { kind: 'full' })
  assert.deepEqual(planShift(10, 10, 100), { kind: 'none' })
  assert.deepEqual(planShift(10, 13, 100), { kind: 'shift', k: 3 })
  assert.deepEqual(planShift(10, 110, 100), { kind: 'full' })
  assert.deepEqual(planShift(10, 5, 100), { kind: 'full' })
  assert.deepEqual(planShift(-1, -1, 100), { kind: 'none' })
})

const lut = buildLut()
const ink: [number, number, number] = [1, 1, 1]
const paper: [number, number, number] = [9, 9, 9]

test('buildLiveRows：顶行最新，缺号斜纹且行数 = 索引差，负行号纸色', () => {
  const rows = new Map<number, Float32Array>()
  for (const i of [0, 1, 4, 5]) rows.set(i, new Float32Array([-100 + i, -50, -70, -80]))
  const src = { rowByIndex: (i: number) => rows.get(i) ?? null }
  const o: LivePaint = { W: 4, lo: -100, hi: -40, lut, stat: 'max', colLo: 0, cb: groupBounds(4, 4), ink, paper }
  const r = buildLiveRows(src, -2, 5, o)
  assert.equal(r.rows, 8)
  assert.equal(r.hatched, 2)
  assert.equal(r.blank, 2)
  // y = 0 是第 5 行：像素 0 的颜色 = dbToIndex(-95)
  const idx = dbToIndex(-95, -100, -40) * 4
  assert.deepEqual(Array.from(r.img.subarray(0, 3)), Array.from(lut.subarray(idx, idx + 3)))
  // y = 2、3 是第 3、2 行（丢）：只含墨色与纸色
  for (const y of [2, 3]) for (let x = 0; x < 4; x++) assert.ok([1, 9].includes(r.img[(y * 4 + x) * 4]!))
  // y = 6、7 是第 −1、−2 行：纸色
  for (const y of [6, 7]) for (let x = 0; x < 4; x++) assert.equal(r.img[(y * 4 + x) * 4], 9)
})

test('buildWindowImage：rows < H 最近邻复制、顶行 = 最新一行；rows = 0 全纸色', () => {
  const ext: Extract = { data: new Float32Array([-100, -100, -40, -40]), rows: 2, cols: 2, t0: 0, t1: 2, f0: -1, f1: 1 }
  const img = buildWindowImage(ext, 2, 4, -100, -40, lut, paper)
  const hiIdx = 255 * 4
  assert.deepEqual(Array.from(img.subarray(0, 3)), Array.from(lut.subarray(hiIdx, hiIdx + 3)))      // y = 0 ← 行 1（−40）
  assert.deepEqual(Array.from(img.subarray(4 * 2 * 1, 4 * 2 * 1 + 3)), Array.from(lut.subarray(hiIdx, hiIdx + 3)))   // y = 1 也是行 1
  assert.deepEqual(Array.from(img.subarray(4 * 2 * 3, 4 * 2 * 3 + 3)), Array.from(lut.subarray(0, 3)))   // y = 3 ← 行 0（−100）
  const empty = buildWindowImage({ ...ext, rows: 0, data: new Float32Array(0) }, 2, 2, -100, -40, lut, paper)
  assert.ok(Array.from(empty).every((v, i) => (i % 4 === 3 ? v === 255 : v === 9)))
})
