// 视距探测（D3-7，D-074）。
//
// **物理不在这里测**：视距与刀口损耗全部来自 `occlusion/`，那一份与 C++ 同守
// `tests/golden/occlusion.json` 的 148 例与 `occlusion-aoi.json` 的五条射线（D3-6）。
// 这里测的是探测本身那三件事：场景里的量取对没有、端点的高度口径对不对、
// 以及切片 ⑤ 验收的那一条——**楼两侧一致**。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { LocalSceneAdapter } from './occlusion/adapter.js'
import { parseBuildings } from './occlusion/geojson.js'
import { SceneFrame } from './occlusion/frame.js'
import { computeLosProbe, probeInputAt, type LosProbeInput } from './losProbe.js'
import { initialState } from '../state/reducer.js'
import type { AppState, ScenarioDoc } from '../state/types.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const BUILDINGS = join(ROOT, 'data/scene/beijing-yayuncun/buildings.geojson')

const scenario = JSON.parse(
  readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json'), 'utf8'),
) as ScenarioDoc

function stateWith(doc: ScenarioDoc): AppState {
  const s = initialState(false, 1920, '')
  return { ...s, scene: { ...s.scene, scenario: { ...s.scene.scenario, id: 'demo-01', doc } } }
}

test('探测输入：站取焦点站、频率取焦点目标的发射中心、高度取它此刻的离地高', () => {
  const r = probeInputAt(stateWith(scenario), 116.41, 39.995)
  assert.ok(!('error' in r), JSON.stringify(r))
  const input = (r as { input: LosProbeInput }).input
  assert.equal(input.site_id, 'site-1')
  assert.equal(input.site.alt_m, 30)              // 站 30 m，terrainHeight_m = 0
  assert.equal(input.frequency_Hz, 2440500000)
  // 没跑过任务时态势走浏览器航迹预览，t = 0 处就是第一个航点的高度
  assert.equal(input.height_agl_m, 50)
  // 用户在卡片上改高度即覆盖它
  const over = probeInputAt(stateWith(scenario), 116.41, 39.995, 8)
  assert.equal((over as { input: LosProbeInput }).input.height_agl_m, 8)
})

test('取不到站或取不到频率时说得出缘由，不编缺省值（铁律 15）', () => {
  const s0 = initialState(false, 1920, '')
  assert.deepEqual(probeInputAt(s0, 116.4, 39.99), { error: '还没有载入场景' })

  const noSite = JSON.parse(JSON.stringify(scenario)) as ScenarioDoc
  noSite.sites = []
  assert.match((probeInputAt(stateWith(noSite), 116.4, 39.99) as { error: string }).error, /没有站点/)

  const noFreq = JSON.parse(JSON.stringify(scenario)) as ScenarioDoc
  delete ((noFreq.emitters as Array<Record<string, unknown>>)[0]!.emission as Record<string, unknown>).center_Hz
  delete ((noFreq.sites as Array<Record<string, unknown>>)[0]!.receiver as Record<string, unknown>).center_Hz
  assert.match((probeInputAt(stateWith(noFreq), 116.4, 39.99) as { error: string }).error, /取不到频率/)
})

test('楼两侧一致：楼后非视距、楼前视距（切片 ⑤ 的验收，缺数据时明说跳过）', () => {
  if (!existsSync(BUILDINGS)) {
    // data/** 不入 git（D-027）。**这不是通过**，是跳过（先例 D-073 ③）。
    console.log('    跳过：buildings.geojson 不在盘上，本条要真实建筑集')
    return
  }
  const m = JSON.parse(readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/manifest.json'), 'utf8'))
  const [lon0, lat0] = m.aoi.center as [number, number]
  const frame = new SceneFrame(lon0, lat0)
  const { buildings } = parseBuildings(JSON.parse(readFileSync(BUILDINGS, 'utf8')), frame)
  const map = new LocalSceneAdapter()
  map.setBuildings(buildings)

  const base = (probeInputAt(stateWith(scenario), 0, 0, 40) as { input: LosProbeInput }).input
  // 站在观测区域中心。挑一栋高过假设高度的楼，沿「站 → 楼心」这条线在楼前楼后各取一点：
  // 楼后必被它挡住；楼前要不要也挑得开阔，所以按「第一个楼前也通的候选」取。
  const site = frame.toPlane(base.site.lon, base.site.lat)
  const cands = buildings
    .map((b) => {
      let cx = 0, cy = 0
      for (let i = 0; i < b.ringX.length; i++) { cx += b.ringX[i]!; cy += b.ringY[i]! }
      cx /= b.ringX.length
      cy /= b.ringY.length
      let half = 0
      for (let i = 0; i < b.ringX.length; i++) half = Math.max(half, Math.hypot(b.ringX[i]! - cx, b.ringY[i]! - cy))
      return { b, cx, cy, half, r: Math.hypot(cx - site.x, cy - site.y) }
    })
    .filter((c) => c.b.heightM >= 60 && c.r > 120 && c.r < 800)
    .sort((a, b) => a.r - b.r)
  assert.ok(cands.length > 0, '观测区域中心附近应当有高过 60 m 的楼')

  // 平面米 → 经纬度：只为造两个探测点，尺度用本地等距圆柱近似足够（±25 m 的余量在这个尺度上稳）
  const mPerDegLat = 111034.4
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180)
  const probeAt = (x: number, y: number) => computeLosProbe(map, frame, {
    ...base, lon: lon0 + x / mPerDegLon, lat: lat0 + y / mPerDegLat,
  })

  let picked: { id: string; near: ReturnType<typeof probeAt>; far: ReturnType<typeof probeAt> } | null = null
  let farAllBlocked = true
  for (const c of cands.slice(0, 40)) {
    const ux = (c.cx - site.x) / c.r
    const uy = (c.cy - site.y) / c.r
    const near = probeAt(site.x + ux * (c.r - c.half - 25), site.y + uy * (c.r - c.half - 25))
    const far = probeAt(site.x + ux * (c.r + c.half + 25), site.y + uy * (c.r + c.half + 25))
    // 楼后那一侧是**无条件**的：视线在楼那儿只有 30–40 m 高，楼有 60 m 以上
    if (far.line_of_sight) farAllBlocked = false
    if (!picked && near.line_of_sight && !far.line_of_sight) {
      picked = { id: c.b.id, near, far }
    }
  }
  assert.equal(farAllBlocked, true, '高过假设高度的楼，其后方不可能是视距')
  assert.ok(picked, '四十栋候选楼里应当至少有一栋的楼前是开阔的')
  // 非视距那一侧必须真的报出损耗与侵入深度，不是只翻一个布尔（07 §5.1：两者是两回事）
  assert.ok(picked!.far.diffraction_dB > 0, `刀口损耗应为正，得 ${picked!.far.diffraction_dB}`)
  assert.ok(picked!.far.intrusion_m > 0)
  assert.equal(picked!.near.diffraction_dB, 0)
  assert.equal(picked!.near.intrusion_m, 0)
  console.log(`    楼 ${picked!.id}：楼前视距、楼后非视距 ${picked!.far.diffraction_dB.toFixed(1)} dB`
    + `（侵入 ${picked!.far.intrusion_m.toFixed(1)} m，距离 ${picked!.far.distance_m.toFixed(0)} m）`)
})
