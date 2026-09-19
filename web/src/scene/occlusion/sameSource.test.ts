import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareSameSource, type PhysicalBuilding, type RenderedBuilding } from './sameSource.js'

const r = (id: string, h: number | null, b: number | null = 0, n: number | null = 4): RenderedBuilding =>
  ({ id, height_m: h, base_m: b, ringPoints: n })
const p = (id: string, h: number, b = 0, n = 4): PhysicalBuilding =>
  ({ id, heightM: h, baseM: b, ringPoints: n })

test('同源：两侧逐项相等时 ok', () => {
  const out = compareSameSource([r('a', 30), r('b', 12, 3)], [p('a', 30), p('b', 12, 3)])
  assert.equal(out.ok, true)
  assert.equal(out.matched, 2)
  assert.deepEqual(out.diffs, [])
})

test('同源：高度对不上就报出来，说得清两边各是多少', () => {
  const out = compareSameSource([r('a', 30)], [p('a', 8)])
  assert.equal(out.ok, false)
  assert.deepEqual(out.diffs, [{ id: 'a', field: 'height_m', rendered: '30', physical: '8' }])
})

test('缺高度的要素：物理侧没有、渲染侧画成 0 —— 这是两侧同义，不算不一致', () => {
  const out = compareSameSource([r('a', 30), r('gone', null)], [p('a', 30)])
  assert.equal(out.ok, true, '两侧同义不该判成对不上')
  assert.deepEqual(out.agreedAbsent, ['gone'])
  assert.deepEqual(out.missingInPhysics, [])

  // 但渲染侧有正高度而物理侧没有，那就是真的对不上（若兜底改回 8 就会走到这一支）
  const bad = compareSameSource([r('ghost', 8)], [])
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.missingInPhysics, ['ghost'])
})

test('MultiPolygon：物理侧按子多边形拆成 #k，按要素 id 归并回去，顶点数不比', () => {
  const out = compareSameSource([r('m', 20, 0, 9)], [p('m#0', 20, 0, 4), p('m#1', 20, 0, 5)])
  assert.equal(out.ok, true, '拆出来的每件顶点数当然与整个要素不同，不该判成不一致')
  assert.equal(out.matched, 1)
})

test('顶点数只报不判：MapLibre 瓦片化会简化并切开几何，那是渲染的产物不是数据的属性', () => {
  const out = compareSameSource([r('a', 30, 0, 13)], [p('a', 30, 0, 18)])
  assert.equal(out.ringPointsDiff, 1, '要报出来')
  assert.equal(out.ok, true, '但不当作不一致——实测两侧常差几个点（13 对 18、5 对 6）')
  assert.deepEqual(out.diffs, [])
})

test('比了零个不算通过（2026-09-19 实测：同一页面两次调用，一次 2738 个要素一次 0 个）', () => {
  const out = compareSameSource([], [p('a', 30)])
  assert.equal(out.ok, false, '画面上一栋楼都没有时，「没有不一致」是空话')
  assert.equal(out.rendered, 0)
})
