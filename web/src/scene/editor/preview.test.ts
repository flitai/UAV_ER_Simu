// 浏览器预览与 C++ 航迹的逐时刻对拍（06 备忘录 §9C G-4 的验收：差 ≤ 1e-6 度）。
//
// 黄金基准由 cuav_run --scenario-track 生成（scripts/gen_scenario_track_golden.py）。
// 这条测试是「预览只做直线插值、但必须与引擎同式」这条约定的执行点：
// 两边任何一处公式走样——用半正矢算段长、改成增量积分、段速取错航点——都会在这里红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RoutePreview, ActivityPreview, chordDistanceM, lookAngles, type Waypoint } from './preview.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..', '..')

interface GoldenSample {
  t_s: number
  id: string
  lon: number
  lat: number
  alt_m: number
  heading_deg: number
  speed_mps: number
  tx_on: boolean
  center_Hz: number
}

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Record<string, unknown>
}

test('航迹预览与 cuav_run --scenario-track 的黄金基准逐时刻一致（≤ 1e-6 度）', () => {
  const golden = readJson('tests/golden/scenario-track-golden-01.json')
  const scenario = readJson('data/scene/beijing-yayuncun/scenarios/golden-01.scenario.json')
  const tol = (golden.tolerance as Record<string, number>).position_deg
  const tolAlt = (golden.tolerance as Record<string, number>).alt_m

  const routes = scenario.routes as Array<Record<string, unknown>>
  const route = routes.find((r) => r.emitter_id === 'uav-1')!
  const preview = new RoutePreview(route.waypoints as Waypoint[], route.loop === true)

  const emitters = scenario.emitters as Array<Record<string, unknown>>
  const emission = emitters[0].emission as Record<string, unknown>
  const acts = new ActivityPreview(
    (scenario.activities ?? []) as Array<Record<string, unknown>>,
    'uav-1',
    emission.center_Hz as number,
  )

  const samples = golden.samples as GoldenSample[]
  let maxLon = 0
  let maxLat = 0
  let maxAlt = 0
  for (const s of samples) {
    if (s.id !== 'uav-1') continue
    const m = preview.stateAt(s.t_s)
    maxLon = Math.max(maxLon, Math.abs(m.position.lon - s.lon))
    maxLat = Math.max(maxLat, Math.abs(m.position.lat - s.lat))
    maxAlt = Math.max(maxAlt, Math.abs(m.position.alt_m - s.alt_m))
    assert.equal(acts.txOnAt(s.t_s), s.tx_on, `t=${s.t_s} 的发射开关`)
    assert.equal(acts.centerHzAt(s.t_s), s.center_Hz, `t=${s.t_s} 的中心频率`)
  }
  assert.ok(samples.length > 300, `基准样点太少：${samples.length}`)
  assert.ok(maxLon < tol, `经度最大差 ${maxLon} 超过 ${tol}`)
  assert.ok(maxLat < tol, `纬度最大差 ${maxLat} 超过 ${tol}`)
  assert.ok(maxAlt < tolAlt, `高度最大差 ${maxAlt} 超过 ${tolAlt}`)
})

test('航迹预览：航向与速度也与基准一致', () => {
  const golden = readJson('tests/golden/scenario-track-golden-01.json')
  const scenario = readJson('data/scene/beijing-yayuncun/scenarios/golden-01.scenario.json')
  const route = (scenario.routes as Array<Record<string, unknown>>)[0]
  const preview = new RoutePreview(route.waypoints as Waypoint[], route.loop === true)
  for (const s of golden.samples as GoldenSample[]) {
    const m = preview.stateAt(s.t_s)
    assert.ok(Math.abs(m.heading_deg - s.heading_deg) < 1e-9, `t=${s.t_s} 航向 ${m.heading_deg} vs ${s.heading_deg}`)
    assert.ok(Math.abs(m.speed_mps - s.speed_mps) < 1e-12, `t=${s.t_s} 速度`)
  }
})

test('距离口径：ECEF 弦长，与半正矢在 3 km 上差不到 5 米（有意偏离，见 preview.ts）', () => {
  const a = { lon: 116.4035, lat: 39.9885, alt_m: 50 }
  const b = { lon: 116.43, lat: 40.011, alt_m: 160 }
  const chord = chordDistanceM(a, b)
  assert.ok(chord > 3000 && chord < 3500, `弦长 ${chord}`)

  const R = 6371000
  const d2r = Math.PI / 180
  const dLat = (b.lat - a.lat) * d2r
  const dLon = (b.lon - a.lon) * d2r
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * d2r) * Math.cos(b.lat * d2r) * Math.sin(dLon / 2) ** 2
  const ground = 2 * R * Math.asin(Math.sqrt(h))
  const haversine = Math.hypot(ground, b.alt_m - a.alt_m)
  assert.ok(Math.abs(chord - haversine) < 5, `弦长与半正矢差 ${Math.abs(chord - haversine)}`)
})

test('视线角：正南北精确，正东西因椭球略偏 90 度', () => {
  const o = { lon: 116.405, lat: 39.99, alt_m: 100 }
  const north = lookAngles(o, { lon: 116.405, lat: 40.0, alt_m: 100 }).azimuth_deg
  assert.ok(Math.min(north, 360 - north) < 1e-6, `正北方位 ${north}`)
  assert.ok(Math.abs(lookAngles(o, { lon: 116.405, lat: 39.98, alt_m: 100 }).azimuth_deg - 180) < 1e-6)
  // 同纬度两点的大圆向极地拱，北半球起始方位略小于 90——与 C++ 侧同一结论
  const east = lookAngles(o, { lon: 116.415, lat: 39.99, alt_m: 100 }).azimuth_deg
  assert.ok(Math.abs(east - 90) < 0.01 && east < 90, `正东方位 ${east}`)
  // 正上方 100 米：俯仰 90 度
  assert.ok(Math.abs(lookAngles(o, { lon: 116.405, lat: 39.99, alt_m: 200 }).elevation_deg - 90) < 1e-6)
})
