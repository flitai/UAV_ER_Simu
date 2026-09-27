// 覆盖场的显示侧（D-080 起计算在引擎）：等值线与着色。物理不在这里测——单格链路预算与 Pd 在
// engine/tests/test_{coverage,field}.cpp，与链路帧的跨侧对拍在 tests/regression/coverage_field.py。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cellCenter, contourSegments, gridGeom } from './contour.js'
import { alphaOf, paintField } from './paint.js'

test('网格：格心等分包围盒，第 0 行在北', () => {
  const g = gridGeom(10, 8, [116.0, 39.0, 116.1, 39.1])
  const nw = cellCenter(g, 0, 0)
  const se = cellCenter(g, g.nx - 1, g.ny - 1)
  assert.ok(nw.lat > se.lat && nw.lon < se.lon)
  assert.ok(Math.abs(nw.lon - (116.0 + 0.005)) < 1e-12)
  assert.ok(Math.abs(nw.lat - (39.1 - 0.00625)) < 1e-12)
})

test('等值线：单峰得一个闭合环（段数 = 4），鞍点两种连法都按中心均值决定', () => {
  const g = gridGeom(3, 3, [0, 0, 0.003, 0.003])
  assert.equal(contourSegments(g, [0, 0, 0, 0, 1, 0, 0, 0, 0], 0.5).length, 4)
  const g2 = gridGeom(2, 2, [0, 0, 0.002, 0.002])
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
