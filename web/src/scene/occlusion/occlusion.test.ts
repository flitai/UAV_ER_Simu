// 浏览器侧遮挡复算对**同一份**黄金基准的对拍（D3-6，D-074）。
//
// 这是 D-074 ① 那条决策的兑现：遮挡两边都算，C++ 是真理源，浏览器复算，
// **两侧同守 tests/golden/occlusion.json 的 148 例，rel ≤ 1e-9**。
// 对拍时用的是黄金基准当年那把尺子（legacy 投影），不是引擎实际运行的严格 ENU——
// 「要听懂当年那盘录音带，就得用当年那套播放参数」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { LocalSceneAdapter, type Building } from './adapter.js'
import { parseBuildings } from './geojson.js'
import { fresnelV, knifeEdgeLossDb, segmentOcclusion, lineOfSight } from './occlusion.js'
import { legacyFrameOcclusion, legacyToPlane, SceneFrame } from './frame.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const golden = JSON.parse(readFileSync(join(ROOT, 'tests/golden/occlusion.json'), 'utf8'))
const prop = JSON.parse(readFileSync(join(ROOT, 'tests/golden/propagation.json'), 'utf8'))

const TOL = 1e-9

function checkRel(got: number, want: number, what: string): void {
  const denom = Math.abs(want) > 1e-12 ? Math.abs(want) : 1
  const rel = Math.abs(got - want) / denom
  assert.ok(rel <= TOL || Math.abs(got - want) <= 1e-12,
    `${what}：得 ${got}，基准 ${want}，相对误差 ${rel}`)
}

/** 黄金基准里的 12 栋楼 → 平面米的体块。**外环首尾不闭合**（C++ 的约定，祖本是闭合的）。 */
function goldenBuildings(): { map: LocalSceneAdapter; lon0: number; lat0: number } {
  const lon0 = golden._meta.origin_point.lon as number
  const lat0 = golden._meta.origin_point.lat as number
  const fr = legacyFrameOcclusion(lat0)
  const list: Building[] = []
  for (const jb of golden._buildings) {
    const lons = jb.footprintLon as number[]
    const lats = jb.footprintLat as number[]
    assert.equal(lons.length, lats.length)
    const ringX: number[] = []
    const ringY: number[] = []
    for (let i = 0; i < lons.length; i++) {
      const p = legacyToPlane(fr, lon0, lat0, lons[i], lats[i])
      ringX.push(p.x)
      ringY.push(p.y)
    }
    list.push({ id: jb.id as string, ringX, ringY, baseM: jb.base_m as number, heightM: jb.height_m as number })
  }
  const map = new LocalSceneAdapter()
  map.setBuildings(list)
  return { map, lon0, lat0 }
}

test('刀口衍射：对 emcore 黄金基准 fresnelV 108 例 + knifeEdgeLoss_dB 14 例', () => {
  assert.equal(prop.fresnelV.length, 108)
  for (const c of prop.fresnelV) {
    checkRel(fresnelV(c.in[0], c.in[1], c.in[2], c.in[3]), c.out, 'fresnelV')
  }
  assert.equal(prop.knifeEdgeLoss_dB.length, 14)
  for (const c of prop.knifeEdgeLoss_dB) {
    checkRel(knifeEdgeLossDb(c.in[0]), c.out, 'knifeEdgeLoss_dB')
  }
})

test('建筑遮挡：对 emcore 黄金基准 148 例（与 C++ 同一份文件、同一判据）', () => {
  const { map, lon0, lat0 } = goldenBuildings()
  const fr = legacyFrameOcclusion(lat0)
  assert.equal(map.buildingCount(), 12)
  assert.equal(map.droppedCount(), 0)
  assert.equal(golden.segment_occlusion.length, 148)

  let blocked = 0
  for (const c of golden.segment_occlusion) {
    const t = legacyToPlane(fr, lon0, lat0, c.tx.lon, c.tx.lat)
    const r = legacyToPlane(fr, lon0, lat0, c.rx.lon, c.rx.lat)
    const got = segmentOcclusion(map,
      { x: t.x, y: t.y, z: c.tx.alt }, { x: r.x, y: r.y, z: c.rx.alt }, c.frequency_Hz)
    checkRel(got.obstructionLossDb, c.out.obstructionLoss_dB, 'obstructionLoss_dB')
    checkRel(got.intrusionM, c.out.intrusion_m, 'intrusion_m')
    assert.equal(got.blocked, c.out.blocked)
    if (got.blocked) blocked++
  }
  // 与 C++ 侧 test_occlusion.cpp 报的是同一个数
  assert.equal(blocked, 29, '148 例中判非视距的例数')
})

test('解析锚点与边界：掠射 6.0329 dB、v ≤ −0.78 截止、单调', () => {
  assert.ok(Math.abs(knifeEdgeLossDb(0) - 6.0329) < 1e-3)
  assert.equal(knifeEdgeLossDb(-0.78), 0)
  assert.equal(knifeEdgeLossDb(-2), 0)
  assert.ok(knifeEdgeLossDb(-0.7) > 0)
  let prev = knifeEdgeLossDb(0)
  for (let v = 0.5; v <= 20; v += 0.5) {
    const cur = knifeEdgeLossDb(v)
    assert.ok(cur > prev, `v=${v} 应更深`)
    prev = cur
  }
})

test('line_of_sight = !blocked，与损耗大小无关（07 §5.1）', () => {
  // 一栋 100 m 见方、40 m 高的楼，中心在原点；墙高扫到刚擦视线
  const map = new LocalSceneAdapter()
  const wall = (h: number): Building => ({
    id: 'W', ringX: [380, 420, 420, 380], ringY: [-80, -80, 80, 80], baseM: 0, heightM: h,
  })
  let grazingFound = false
  for (let h = 40; h <= 41; h += 0.02) {
    map.setBuildings([wall(h)])
    const r = segmentOcclusion(map, { x: 800, y: 0, z: 50 }, { x: 0, y: 0, z: 30 }, 2.44e9)
    if (!r.blocked) continue
    if (r.obstructionLossDb > 0 && r.obstructionLossDb < 8) {
      // 损耗才几分贝，但几何上确实被切断 → 仍判非视距
      assert.equal(lineOfSight(r), false)
      grazingFound = true
      break
    }
  }
  assert.ok(grazingFound, '应当扫得到一个掠射档')
})

test('适配器的几条行为约定与 C++ 一致', () => {
  const map = new LocalSceneAdapter()
  const b: Building = {
    id: 'B', ringX: [-50, 50, 50, -50], ringY: [-50, -50, 50, 50], baseM: 0, heightM: 40,
  }
  map.setBuildings([b])
  assert.equal(map.buildingCount(), 1)

  // 穿楼而过：命中
  const hit = map.raycast({ x: -500, y: 0, z: 10 }, { x: 500, y: 0, z: 10 })
  assert.ok(hit)
  assert.equal(hit!.intrusionM, 30)
  assert.equal(hit!.point.z, 40)

  // 楼顶掠过：视线高于楼顶即不算命中
  assert.equal(map.raycast({ x: -500, y: 0, z: 60 }, { x: 500, y: 0, z: 60 }), null)

  // 端点落在楼的投影内即排除该楼（自遮挡）
  assert.equal(map.raycast({ x: 0, y: 0, z: 45 }, { x: 500, y: 0, z: 10 }), null)

  // 无效要素剔除且计数，不静默丢（铁律 15）
  const m2 = new LocalSceneAdapter()
  m2.setBuildings([
    b,
    { id: 'thin', ringX: [0, 1], ringY: [0, 1], baseM: 0, heightM: 10 },
    { id: 'flat', ringX: [0, 1, 2], ringY: [0, 1, 2], baseM: 0, heightM: 0 },
  ])
  assert.equal(m2.buildingCount(), 1)
  assert.equal(m2.droppedCount(), 2)

  // 空场景优雅降级，不是错误
  const empty = new LocalSceneAdapter()
  assert.equal(empty.raycast({ x: -500, y: 0, z: 10 }, { x: 500, y: 0, z: 10 }), null)
  const r = segmentOcclusion(empty, { x: -500, y: 0, z: 10 }, { x: 500, y: 0, z: 10 }, 2.44e9)
  assert.equal(r.obstructionLossDb, 0)
  assert.equal(r.blocked, false)
})

test('SceneFrame：严格站心地平，且 z 不由它产生', () => {
  const frame = new SceneFrame(116.405, 39.99)
  const o = frame.toPlane(116.405, 39.99)
  assert.ok(Math.abs(o.x) < 1e-9 && Math.abs(o.y) < 1e-9)

  // 独立闭式：正北位移 ≈ 子午圈曲率半径 M·Δφ
  const a = 6378137.0
  const f = 1 / 298.257223563
  const e2 = f * (2 - f)
  const phi = (39.99 * Math.PI) / 180
  const s = Math.sin(phi)
  const N = a / Math.sqrt(1 - e2 * s * s)
  const M = (a * (1 - e2)) / Math.pow(1 - e2 * s * s, 1.5)
  const d2r = Math.PI / 180

  const north = frame.toPlane(116.405, 39.999)
  assert.ok(Math.abs(north.y - M * 0.009 * d2r) < 1e-3, `北向 ${north.y}`)

  // 正东走一段，北向坐标**不是零**：纬线圈朝极点弯，切平面上偏北 d²·tanφ/(2N)。
  // 这条就是「本帧是真切平面、不是等距圆柱投影」的分界线——legacy 那套在这里给恒零。
  const east = frame.toPlane(116.417, 39.99)
  const arc = N * Math.cos(phi) * 0.012 * d2r
  assert.ok(Math.abs(east.x - arc) < 1e-3, `东向 ${east.x} 对 ${arc}`)
  const curl = (arc * arc * Math.tan(phi)) / (2 * N)
  assert.ok(Math.abs(curl - 0.0689) < 0.01, `理论偏北 ${curl}`)
  assert.ok(Math.abs(east.y - curl) < 1e-3, `实测偏北 ${east.y}`)

  // z 原样透传，不是 ENU 的 up
  assert.equal(frame.point(116.405, 39.99, 30).z, 30)

  // legacy 投影在同一处给恒零——两套尺子确实不同，别拿错
  const fr = legacyFrameOcclusion(39.99)
  assert.equal(legacyToPlane(fr, 116.405, 39.99, 116.417, 39.99).y, 0)
})

test('真实建筑集上的五条射线：与 C++ 同守 occlusion-aoi.json（缺数据时明说跳过）', () => {
  // 148 例那张表用的是 12 栋合成楼加 legacy 投影，**测不到** GeoJSON 的解析规则、
  // 严格站心地平的平面帧、四万多栋楼上的桶网格。这一条补上那一段，
  // 与 engine/tests/test_buildings.cpp 读同一份文件、同一判据。
  const p = join(ROOT, 'data/scene/beijing-yayuncun/buildings.geojson')
  if (!existsSync(p)) {
    // data/** 不入 git（D-027）。**这不是通过**，是跳过（先例 D-073 ③）。
    console.log('    跳过：buildings.geojson 不在盘上，本条要真实建筑集')
    return
  }
  const g = JSON.parse(readFileSync(join(ROOT, 'tests/golden/occlusion-aoi.json'), 'utf8'))
  const m = JSON.parse(readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/manifest.json'), 'utf8'))
  const [lon0, lat0] = m.aoi.center as [number, number]
  const frame = new SceneFrame(lon0, lat0)
  const { buildings, stats } = parseBuildings(JSON.parse(readFileSync(p, 'utf8')), frame)
  const map = new LocalSceneAdapter()
  map.setBuildings(buildings)

  // 输入必须是同一份数据，否则这张表说的不是同一件事
  assert.equal(stats.buildings, g._meta.input.buildings_count)
  assert.equal(lon0, 116.405)
  assert.equal(lat0, 39.99)

  const fHz = g._meta.input.frequency_Hz as number
  const tol = g._meta.tolerance_rel as number
  assert.equal(g.segment_occlusion_aoi.length, 5)
  let worst = 0
  for (const c of g.segment_occlusion_aoi) {
    const [ax, ay, az, bx, by, bz] = c.ray as number[]
    const got = segmentOcclusion(map, { x: ax, y: ay, z: az }, { x: bx, y: by, z: bz }, fHz)
    assert.equal(got.blocked, c.out.blocked)
    const wl = c.out.obstructionLoss_dB as number
    const wi = c.out.intrusion_m as number
    const rl = Math.abs(got.obstructionLossDb - wl) / Math.abs(wl)
    const ri = Math.abs(got.intrusionM - wi) / Math.abs(wi)
    assert.ok(rl <= tol, `obstructionLoss_dB 得 ${got.obstructionLossDb} 基准 ${wl}，相对 ${rl}`)
    assert.ok(ri <= tol, `intrusion_m 得 ${got.intrusionM} 基准 ${wi}，相对 ${ri}`)
    worst = Math.max(worst, rl, ri)
  }
  // 两侧不逐位相同也不该期望逐位相同：椭球换算一边 GeographicLib、一边自写闭式
  console.log(`    五条射线对 C++ 最差相对差 ${worst.toExponential(3)}（判据 ${tol}）`)
})
