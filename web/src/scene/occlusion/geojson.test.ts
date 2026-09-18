// 解析规则与 C++ `engine/src/buildings_json.cpp` 一致（D3-6，D-074）。
// 铁律 11 要的是渲染与物理同源于**同一份数据**，那就必须同一套解析规则——
// 一边把 MultiPolygon 拆成三栋、另一边当一栋，两侧算出来的遮挡就不是一回事。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { LocalSceneAdapter } from './adapter.js'
import { segmentOcclusion } from './occlusion.js'
import { SceneFrame } from './frame.js'
import { parseBuildings } from './geojson.js'
import { ensureOcclusion, occlusionState, occlusionNote, resetOcclusionForTest } from './store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const FRAME = new SceneFrame(116.405, 39.99)

function rect(id: string | number, lon0: number, lat0: number, d: number, h: number, hole = false) {
  const ring = [[lon0, lat0], [lon0 + d, lat0], [lon0 + d, lat0 + d], [lon0, lat0 + d], [lon0, lat0]]
  const rings: number[][][] = [ring]
  if (hole) {
    rings.push([[lon0 + 0.2 * d, lat0 + 0.2 * d], [lon0 + 0.4 * d, lat0 + 0.2 * d],
      [lon0 + 0.4 * d, lat0 + 0.4 * d], [lon0 + 0.2 * d, lat0 + 0.2 * d]])
  }
  return {
    type: 'Feature',
    properties: { id, base_m: 0, height_m: h, src: 'est:area' },
    geometry: { type: 'Polygon', coordinates: rings },
  }
}

const fc = (features: unknown[]) => ({ type: 'FeatureCollection', features })

test('闭合环去末点、孔忽略并计数、退化与非正高度剔除', () => {
  const thin = rect('thin', 116.43, 39.99, 0.001, 10)
  thin.geometry.coordinates = [[[116.43, 39.99], [116.431, 39.99], [116.43, 39.99]]]
  const { buildings, stats } = parseBuildings(fc([
    rect('ok', 116.40, 39.99, 0.001, 20),
    rect('holed', 116.41, 39.99, 0.001, 30, true),
    rect('flat', 116.42, 39.99, 0.001, 0),
    thin,
  ]), FRAME)

  assert.equal(stats.features, 4)
  assert.equal(stats.polygons, 4)
  assert.equal(stats.holesIgnored, 1)
  assert.equal(stats.droppedHeight, 1)
  assert.equal(stats.droppedDegenerate, 1)
  assert.equal(stats.buildings, 2)
  assert.equal(buildings.length, 2)

  // GeoJSON 的五点环 → 四个顶点（首尾不闭合）
  assert.equal(buildings[0].id, 'ok')
  assert.equal(buildings[0].ringX.length, 4)
  assert.equal(buildings[0].ringY.length, 4)
  // 矩形首末两角同经度，差在北向上，所以量 y
  assert.ok(Math.abs(buildings[0].ringY[0] - buildings[0].ringY[3]) > 100)
})

test('MultiPolygon 按外环拆，id 加序号后缀', () => {
  const polys: number[][][][] = []
  for (let k = 0; k < 3; k++) {
    const lon = 116.40 + 0.002 * k
    const ring = [[lon, 39.99], [lon + 0.001, 39.99], [lon + 0.001, 39.991], [lon, 39.991], [lon, 39.99]]
    polys.push(k === 1 ? [ring, ring] : [ring])
  }
  const { buildings, stats } = parseBuildings(fc([{
    type: 'Feature',
    properties: { id: 12345, base_m: 0, height_m: 15 },
    geometry: { type: 'MultiPolygon', coordinates: polys },
  }]), FRAME)

  assert.equal(stats.multipolygons, 1)
  assert.equal(stats.parts, 3)
  assert.equal(stats.holesIgnored, 1)
  assert.deepEqual(buildings.map((b) => b.id), ['12345#0', '12345#1', '12345#2'])
})

test('几何类型不认识：计数并跳过，不静默丢（与 C++ 有意的一处不同）', () => {
  const { buildings, stats } = parseBuildings(fc([
    { type: 'Feature', properties: { id: 'p', height_m: 10 }, geometry: { type: 'Point', coordinates: [116.4, 39.99] } },
    rect('ok', 116.40, 39.99, 0.001, 20),
  ]), FRAME)
  assert.equal(stats.skippedGeometry, 1)
  assert.equal(buildings.length, 1)
})

test('懒加载：没人要就不取；取一次之后重复调用不再取', async () => {
  resetOcclusionForTest()
  assert.equal(occlusionState().status, 'idle')
  assert.equal(occlusionNote(), '未加载')

  let calls = 0
  const fakeFetch = (async () => {
    calls++
    return { ok: true, json: async () => fc([rect('a', 116.40, 39.99, 0.001, 20)]) }
  }) as unknown as typeof fetch

  const a = await ensureOcclusion('/x.geojson', 116.405, 39.99, fakeFetch)
  assert.ok(a)
  assert.equal(calls, 1)
  assert.equal(occlusionState().status, 'ready')
  assert.equal(occlusionState().stats?.buildings, 1)
  assert.match(occlusionNote(), /建筑 1 栋/)

  await ensureOcclusion('/x.geojson', 116.405, 39.99, fakeFetch)
  assert.equal(calls, 1, '第二次不该再取')
  resetOcclusionForTest()
})

test('取不到就说取不到，不拿空建筑集顶替（铁律 15）', async () => {
  resetOcclusionForTest()
  const bad = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch
  const a = await ensureOcclusion('/missing.geojson', 116.405, 39.99, bad)
  assert.equal(a, null)
  assert.equal(occlusionState().status, 'error')
  assert.match(occlusionNote(), /加载失败/)
  resetOcclusionForTest()
})

test('真实建筑集：解析计数与 C++ 逐项相同（缺数据时明说跳过）', () => {
  const p = join(ROOT, 'data/scene/beijing-yayuncun/buildings.geojson')
  if (!existsSync(p)) {
    // data/** 不入 git（D-027）。**这不是通过**，是跳过（先例 D-073 ③）。
    console.log('    跳过：buildings.geojson 不在盘上，本条要真实建筑集')
    return
  }
  const m = JSON.parse(readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/manifest.json'), 'utf8'))
  const [lon0, lat0] = m.aoi.center as [number, number]
  const frame = new SceneFrame(lon0, lat0)

  const t0 = Date.now()
  const doc = JSON.parse(readFileSync(p, 'utf8'))
  const tParse = Date.now() - t0
  const t1 = Date.now()
  const { buildings, stats } = parseBuildings(doc, frame)
  const tProject = Date.now() - t1

  // 这些数就是 C++ 侧 engine/tests/test_buildings.cpp 里断言的那一组。
  // **一处对不上就说明两边的解析规则分叉了**，而分叉不会报错、只会让遮挡结果悄悄不同。
  assert.equal(stats.features, 47582)
  assert.equal(stats.polygons, 47546)
  assert.equal(stats.multipolygons, 36)
  assert.equal(stats.parts, 116)
  assert.equal(stats.holesIgnored, 345)
  assert.equal(stats.droppedHeight, 0)
  assert.equal(stats.droppedDegenerate, 0)
  assert.equal(stats.skippedGeometry, 0)
  assert.equal(stats.buildings, 47662)

  const map = new LocalSceneAdapter()
  const t2 = Date.now()
  map.setBuildings(buildings)
  const tGrid = Date.now() - t2
  assert.equal(map.buildingCount(), 47662)
  assert.equal(map.droppedCount(), 0)
  console.log(`    JSON.parse ${tParse} ms、投影 ${tProject} ms、桶网格 ${tGrid} ms`)

  // 中心附近拉一条 2 km 的贴地视线，必然被楼切断（与 C++ 同一条断言）
  const r = segmentOcclusion(map, { x: -1000, y: 0, z: 1.5 }, { x: 1000, y: 0, z: 1.5 }, 2.44e9)
  assert.equal(r.blocked, true)
  assert.ok(r.obstructionLossDb > 6)
  console.log(`    中心 2 km 贴地视线：遮挡 ${r.obstructionLossDb.toFixed(4)} dB，侵入 ${r.intrusionM} m`)
})
