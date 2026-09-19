// 卡片派生读数的单测（V-1，D-061）。对着真场景 golden-03 跑：三站三源，链路标识里站与源都含连字符。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { ScenarioDoc } from '../../state/types.js'
import type { BearingSample, LinkSample, PositionSample } from '../sceneStore.js'
import {
  buildSiteCards, buildTargetCards, groundDistanceM, noisePowerDbm, probeCards, probeSiteCards, qualityRank, rxPowerDbm,
  type SituationLike,
} from './derive.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
function demo03(): ScenarioDoc {
  return JSON.parse(readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/scenarios/golden-03.scenario.json'), 'utf8')) as ScenarioDoc
}

function link(link_id: string, over: Partial<LinkSample> = {}): LinkSample {
  return { t_s: 1, link_id, line_of_sight: true, distance_m: 2805.6, azimuth_deg: 212.39, elevation_deg: 1.8257,
           path_loss_dB: 109.158, delay_s: 9.36e-6, doppler_Hz: 149.4, valid_from_s: 1, valid_to_s: 1.05,
           update_rate_Hz: 20, state: 'valid', ...over }
}
function bearing(site_id: string, emitter_id: string, q: string): BearingSample {
  return { t_s: 1, site_id, emitter_id, link_id: `${site_id}-${emitter_id}`, bearing_deg: 212.9, bearing_std_deg: 2.05,
           snr_dB: 40, level_dBm: -70, df_quality: q, df_result_state: 'valid', use_policy: 'normal', mixture: false }
}
function position(emitter_id: string, method: string, cep_m: number): PositionSample {
  return { t_s: 1, emitter_id, method, lon: 116.39, lat: 39.98, semi_major_m: 20, semi_minor_m: 10, rotation_deg: 30,
           cep_m, gdop: 1.2, min_crossing_angle_deg: 40, geometry_quality: 'good', time_quality: null,
           participating_sites: ['site-1', 'site-2', 'site-3'], state: 'valid' }
}

test('接收电平与信噪比按链路帧算，与引擎 locate.cpp:255-257 同式', () => {
  assert.equal(rxPowerDbm(27, 2, 3, 100), -68)
  // −174 + 6 + 10·log10(5e5) = −111.0103
  assert.ok(Math.abs(noisePowerDbm(6, 5e5) - -111.0103) < 1e-3)
  assert.ok(Math.abs(groundDistanceM(1000, 60) - 500) < 1e-9)
})

test('目标卡：每源一张、每站一行；有链路帧的行按标识精确匹配并算出电平，没有的行退到浏览器几何', () => {
  const doc = demo03()
  const sit: SituationLike = { entities: new Map(), links: new Map(), bearings: new Map(), positions: new Map() }
  sit.links.set('site-1-uav-1', link('site-1-uav-1', { path_loss_dB: 100 }))
  sit.bearings.set('site-1-uav-1', bearing('site-1', 'uav-1', 'DF-Q2'))
  sit.positions.set('uav-1:aoa', position('uav-1', 'aoa', 8))
  const cards = buildTargetCards(doc, sit)
  assert.deepEqual(cards.map((c) => c.id), ['uav-1', 'uav-2', 'uav-3'])
  const c = cards[0]!
  assert.equal(c.sites.length, 3)
  const r1 = c.sites[0]!
  assert.equal(r1.site_id, 'site-1')
  assert.equal(r1.source, 'link')
  // golden-03：uav-1 发射 27 dBm、天线 2 dBi；site-1 天线 3 dBi、噪声系数 6 dB、采样率 500 kHz
  assert.equal(r1.rx_dBm, 27 + 2 + 3 - 100)
  assert.ok(Math.abs((r1.snr_dB ?? NaN) - (-68 - noisePowerDbm(6, 5e5))) < 1e-9)
  assert.equal(r1.bearing?.df_quality, 'DF-Q2')
  assert.ok(Math.abs((r1.ground_m ?? 0) - groundDistanceM(2805.6, 1.8257)) < 1e-9)
  // 没有链路帧的站：只有浏览器几何，电平与路损为 null（不编）
  const r2 = c.sites[1]!
  assert.equal(r2.source, 'preview')
  assert.ok((r2.distance_m ?? 0) > 0)
  assert.equal(r2.path_loss_dB, null)
  assert.equal(r2.rx_dBm, null)
  assert.equal(r2.bearing, null)
  // 未运行：运动取场景初始位置，航向与速度为 null
  assert.equal(c.motion?.source, 'scenario')
  assert.equal(c.motion?.heading_deg, null)
  assert.deepEqual(c.fixes.map((f) => [f.method, f.cep_m]), [['aoa', 8]])
  // 最近站取所有行的最小距离——没有链路帧的站按浏览器几何算，也参与比较
  const dists = c.sites.map((r) => r.distance_m).filter((d): d is number => d !== null)
  assert.equal(c.nearest_m, Math.min(...dists))
  assert.ok((c.nearest_m ?? Infinity) <= 2805.6)
  assert.equal(c.inZone, null)
})

test('实体样点到达后运动来自它；缺发射功率之类的配置时电平为 null', () => {
  const doc = demo03()
  const sit: SituationLike = { entities: new Map(), links: new Map(), bearings: new Map(), positions: new Map() }
  sit.entities.set('uav-2', { t_s: 3, id: 'uav-2', lon: 116.4, lat: 39.99, alt_m: 80, heading_deg: 90, speed_mps: 12, tx_on: true, center_Hz: 2.44e9 })
  sit.links.set('site-2-uav-2', link('site-2-uav-2'))
  const doc2 = JSON.parse(JSON.stringify(doc)) as ScenarioDoc
  delete ((doc2.emitters as Array<Record<string, unknown>>)[1]!.emission as Record<string, unknown>).tx_power_dBm
  const c = buildTargetCards(doc2, sit)[1]!
  assert.equal(c.motion?.source, 'entity')
  assert.equal(c.motion?.heading_deg, 90)
  assert.equal(c.motion?.tx_on, true)
  const r = c.sites.find((x) => x.site_id === 'site-2')!
  assert.equal(r.source, 'link')
  assert.equal(r.rx_dBm, null)
  assert.equal(r.snr_dB, null)
})

test('站点卡：链路数与最差测向档；探针形状逐项挑', () => {
  const doc = demo03()
  const sit: SituationLike = { entities: new Map(), links: new Map(), bearings: new Map(), positions: new Map() }
  sit.bearings.set('site-1-uav-1', bearing('site-1', 'uav-1', 'DF-Q1'))
  sit.bearings.set('site-1-uav-3', bearing('site-1', 'uav-3', 'DF-Q3'))
  const sc = buildSiteCards(doc, sit)
  assert.deepEqual(sc.map((c) => c.id), ['site-1', 'site-2', 'site-3'])
  assert.equal(sc[0]!.links, 3)
  assert.equal(sc[0]!.worst_quality, 'DF-Q3')
  assert.equal(sc[1]!.worst_quality, null)
  assert.equal(sc[0]!.sync_state, 'locked')
  assert.ok(qualityRank('invalid') > qualityRank('DF-Q4') && qualityRank('DF-Q4') > qualityRank('DF-Q1'))
  const pc = probeCards(buildTargetCards(doc, sit))
  assert.deepEqual(Object.keys(pc[0]!).sort(), ['fixes', 'id', 'inZone', 'motionSource', 'nearest_m', 'platform_type', 'sites'])
  assert.deepEqual(Object.keys(pc[0]!.sites[0]!).sort(),
    ['azimuth_deg', 'bearing_deg', 'df_quality', 'distance_m', 'path_loss_dB', 'rx_dBm', 'sigma_deg', 'site_id', 'snr_dB', 'source'])
  assert.deepEqual(probeSiteCards(sc)[0], { id: 'site-1', links: 3, worst_quality: 'DF-Q3', sync_state: 'locked' })
})

test('告警区判定进卡片：golden-03 的 z-east 圆心处在区内，限高之上不在，远处不在', () => {
  const doc = demo03()
  const sit: SituationLike = { entities: new Map(), links: new Map(), bearings: new Map(), positions: new Map() }
  sit.entities.set('uav-2', { t_s: 70, id: 'uav-2', lon: 116.4105, lat: 39.99, alt_m: 90, heading_deg: 180, speed_mps: 12, tx_on: true, center_Hz: 2.44e9 })
  sit.entities.set('uav-1', { t_s: 70, id: 'uav-1', lon: 116.4105, lat: 39.99, alt_m: 500, heading_deg: 0, speed_mps: 20, tx_on: true, center_Hz: 2.44e9 })
  const cards = buildTargetCards(doc, sit)
  assert.equal(cards.find((c) => c.id === 'uav-2')?.inZone, 'z-east')
  assert.equal(cards.find((c) => c.id === 'uav-2')?.inZoneName, '东侧告警区')
  assert.equal(cards.find((c) => c.id === 'uav-1')?.inZone, null, '限高 300 m 之上')
  assert.equal(cards.find((c) => c.id === 'uav-3')?.inZone, null, '静止点在圈外')
})
