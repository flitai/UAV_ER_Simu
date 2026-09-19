// 渲染与物理对同一份 buildings.geojson 的解释必须一致（铁律 11；D4，D-076）。
//
// 这里钉的不是「常数是多少」，而是**两侧同义**：物理侧把缺高度或高度非正的要素剔除，
// 渲染侧因此只能画成 0（看不见）。任何非零的兜底都会让屏幕上立着一栋视线穿得过去的楼。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASE_FALLBACK_M, HEIGHT_FALLBACK_M, buildings3dPaint } from './buildings3d.js'
import { parseBuildings } from '../occlusion/geojson.js'
import { SceneFrame } from '../occlusion/frame.js'

test('渲染侧缺高度的兜底是 0，与物理侧「剔除」同义（铁律 11、15）', () => {
  assert.equal(HEIGHT_FALLBACK_M, 0, '非零兜底会画出物理侧不存在的楼')
  assert.equal(BASE_FALLBACK_M, 0)
  const paint = buildings3dPaint() as Record<string, unknown>
  // 取插值表达式末尾那个 coalesce 的兜底值，直接从 paint 里读，不另抄一份
  const h = paint['fill-extrusion-height'] as unknown[]
  const coalesce = h[h.length - 1] as unknown[]
  assert.equal(coalesce[0], 'coalesce')
  assert.equal(coalesce[coalesce.length - 1], 0)
})

test('同一个要素：物理侧剔除的，渲染侧的兜底把它画成 0 高', () => {
  const frame = new SceneFrame(116.405, 39.99)
  const square = (lon: number, lat: number) => [[
    [lon, lat], [lon + 0.001, lat], [lon + 0.001, lat + 0.001], [lon, lat + 0.001], [lon, lat],
  ]]
  const doc = {
    type: 'FeatureCollection',
    features: [
      { properties: { id: 'ok', height_m: 30, base_m: 0 }, geometry: { type: 'Polygon', coordinates: square(116.4, 39.98) } },
      { properties: { id: 'no-height', base_m: 0 }, geometry: { type: 'Polygon', coordinates: square(116.41, 39.98) } },
      { properties: { id: 'zero-height', height_m: 0, base_m: 0 }, geometry: { type: 'Polygon', coordinates: square(116.42, 39.98) } },
    ],
  }
  const { buildings, stats } = parseBuildings(doc, frame)
  assert.deepEqual(buildings.map((b) => b.id), ['ok'], '缺高度与零高度都不进物理')
  assert.equal(stats.droppedHeight, 2, '剔除要计数，不是静默丢')
  // 渲染侧对这两个要素算出来的高度就是兜底值；兜底是 0，于是屏幕上也看不见
  assert.equal(HEIGHT_FALLBACK_M, 0)
})
