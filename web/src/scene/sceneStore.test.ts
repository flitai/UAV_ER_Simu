// 态势 store 的历史缓冲与按时刻取快照（V-3，D-061；13 报告 §5.3）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sceneStore, type EntitySample, type LinkSample } from './sceneStore.js'

const ent = (id: string, t: number, lon: number): EntitySample =>
  ({ t_s: t, id, lon, lat: 39.99, alt_m: 100, heading_deg: 0, speed_mps: 10, tx_on: true, center_Hz: 2.44e9 })
const link = (id: string, t: number, d: number): LinkSample =>
  ({ t_s: t, link_id: id, line_of_sight: true, distance_m: d, azimuth_deg: 0, elevation_deg: 0, path_loss_dB: 100,
     delay_s: 0, doppler_Hz: 0, valid_from_s: t, valid_to_s: t + 0.05, update_rate_Hz: 20, state: 'valid' })

test('实时 push 累积历史；snapshotAt 取每键最后一条 t_s ≤ t 的样点，航迹只画到 t', () => {
  sceneStore.reset()
  assert.equal(sceneStore.hasHistory(), false)
  for (let k = 0; k <= 10; k++) sceneStore.pushEntity(ent('uav-1', k, 116.40 + k * 0.001))
  sceneStore.pushEntity(ent('uav-2', 5, 116.50))
  sceneStore.pushLink(link('site-1-uav-1', 2, 200))
  sceneStore.pushLink(link('site-1-uav-1', 8, 800))
  assert.equal(sceneStore.hasHistory(), true)
  // live 仍是最新
  assert.equal(sceneStore.get().entities.get('uav-1')?.t_s, 10)
  const s5 = sceneStore.snapshotAt(5.5)
  assert.equal(s5.entities.get('uav-1')?.t_s, 5)
  assert.ok(Math.abs((s5.entities.get('uav-1')?.lon ?? 0) - 116.405) < 1e-9)
  assert.equal(s5.entities.get('uav-2')?.t_s, 5)
  assert.equal(s5.links.get('site-1-uav-1')?.distance_m, 200)
  assert.equal(s5.trails.get('uav-1')?.length, 6, '航迹只到 t = 5 的六个顶点')
  // t 早于第一条：没有
  const s0 = sceneStore.snapshotAt(-1)
  assert.equal(s0.entities.size, 0)
  // t 晚于最后一条：最后一条
  const s99 = sceneStore.snapshotAt(99)
  assert.equal(s99.entities.get('uav-1')?.t_s, 10)
  assert.equal(s99.links.get('site-1-uav-1')?.distance_m, 800)
  // 纯读：连取两次相同，live 不变
  assert.deepEqual(sceneStore.snapshotAt(5.5).entities.get('uav-1'), s5.entities.get('uav-1'))
  assert.equal(sceneStore.get().entities.get('uav-1')?.t_s, 10)
})

test('乱序到达插到正确位置；整批替换也建历史', () => {
  sceneStore.reset()
  sceneStore.pushEntity(ent('a', 3, 1))
  sceneStore.pushEntity(ent('a', 1, 2))
  sceneStore.pushEntity(ent('a', 2, 3))
  assert.equal(sceneStore.snapshotAt(1.5).entities.get('a')?.lon, 2)
  assert.equal(sceneStore.snapshotAt(2.5).entities.get('a')?.lon, 3)
  sceneStore.replaceFromTrack([ent('b', 0, 0), ent('b', 1, 1), ent('b', 2, 2)], [link('s-b', 0, 1), link('s-b', 2, 3)])
  assert.equal(sceneStore.hasHistory(), true)
  assert.equal(sceneStore.snapshotAt(1).entities.get('b')?.lon, 1)
  assert.equal(sceneStore.snapshotAt(1).links.get('s-b')?.distance_m, 1)
  assert.equal(sceneStore.snapshotAt(1).entities.has('a'), false, 'replace 清掉了旧历史')
  sceneStore.reset()
})
