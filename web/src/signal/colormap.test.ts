import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VIRIDIS_ANCHORS, buildLut, dbToIndex, hexToRgb, paintHatch, paintRow } from './colormap.js'

test('buildLut：1024 字节、锚点位置精确等于锚点色、亮度大体单调、alpha 恒 255', () => {
  const lut = buildLut()
  assert.equal(lut.length, 1024)
  const n = VIRIDIS_ANCHORS.length
  for (let j = 0; j < n; j++) {
    const i = Math.round((j * 255) / (n - 1))
    const [r, g, b] = hexToRgb(VIRIDIS_ANCHORS[j]!)
    assert.deepEqual([lut[i * 4], lut[i * 4 + 1], lut[i * 4 + 2]], [r, g, b], `锚点 ${j}`)
  }
  for (let i = 0; i < 256; i++) assert.equal(lut[i * 4 + 3], 255)
  // 绿色分量在 viridis 上单调不减
  for (let i = 1; i < 256; i++) assert.ok(lut[i * 4 + 1]! >= lut[(i - 1) * 4 + 1]!, `G 在 ${i} 处回落`)
})

test('dbToIndex：夹取、精确零与 NaN 归 0、量程无效归 0', () => {
  assert.equal(dbToIndex(-80, -100, -20), Math.round((20 / 80) * 255))
  assert.equal(dbToIndex(-100, -100, -20), 0)
  assert.equal(dbToIndex(-20, -100, -20), 255)
  assert.equal(dbToIndex(0, -100, -20), 255)
  assert.equal(dbToIndex(-300, -400, -20), 0)
  assert.equal(dbToIndex(Number.NaN, -100, -20), 0)
  assert.equal(dbToIndex(-50, -20, -100), 0)
})

test('paintRow：cols == W 逐像素等于列；cols < W 按最近邻复制；cols > W 取每组首项', () => {
  const lut = buildLut()
  const vals = new Float32Array([-100, -60, -20, -300])
  const out = new Uint8ClampedArray(4 * 4)
  paintRow(vals, 0, 4, 4, -100, -20, lut, out, 0)
  for (let x = 0; x < 4; x++) {
    const idx = dbToIndex(vals[x]!, -100, -20) * 4
    assert.deepEqual(Array.from(out.subarray(x * 4, x * 4 + 3)), Array.from(lut.subarray(idx, idx + 3)))
  }
  const wide = new Uint8ClampedArray(8 * 4)
  paintRow(vals, 0, 4, 8, -100, -20, lut, wide, 0)
  assert.deepEqual(Array.from(wide.subarray(0, 4)), Array.from(wide.subarray(4, 8)))   // 像素 0、1 都取列 0
  const narrow = new Uint8ClampedArray(2 * 4)
  paintRow(vals, 0, 4, 2, -100, -20, lut, narrow, 0)
  assert.deepEqual(Array.from(narrow.subarray(0, 3)), Array.from(lut.subarray(0, 3)))   // 列 0 = -100 → 0
})

test('paintHatch：周期 8、两色交替、无透明像素；相邻行错位', () => {
  const ink: [number, number, number] = [1, 2, 3]
  const paper: [number, number, number] = [9, 9, 9]
  const a = new Uint8ClampedArray(16 * 4)
  const b = new Uint8ClampedArray(16 * 4)
  paintHatch(a, 0, 16, 0, ink, paper)
  paintHatch(b, 0, 16, 4, ink, paper)
  for (let x = 0; x < 16; x++) {
    assert.equal(a[x * 4 + 3], 255)
    assert.equal(a[x * 4], a[((x + 8) % 16) * 4])
    assert.notEqual(a[x * 4], b[x * 4])
  }
  assert.ok(Array.from({ length: 16 }, (_, x) => a[x * 4]).includes(1))
  assert.ok(Array.from({ length: 16 }, (_, x) => a[x * 4]).includes(9))
})
