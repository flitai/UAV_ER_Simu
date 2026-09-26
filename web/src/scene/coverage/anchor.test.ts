// 跨侧锚点（D-079）：覆盖图在目标所在那一点读出的路损，与引擎 E3 链路帧的 path_loss_dB 是同一个数。
//
// 拿 tests/regression/e3_occlusion_chain.py 跑出来的那次 E3 运行（golden-01、主模型自由空间、
// 不开阴影与天气）：对每个与航迹同时刻的链路帧，把目标放在航迹给的位置与高度上，用 cell.ts 在真实
// 建筑集上算 fspl + 刀口损耗，与帧里的 path_loss_dB 比。建筑集与运行目录都不入 git：
// 缺哪样就**明说跳过、不当作通过**（D-073 ③）。重生成运行：`uv run --quiet python tests/regression/e3_occlusion_chain.py`。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { LocalSceneAdapter } from '../occlusion/adapter.js'
import { SceneFrame } from '../occlusion/frame.js'
import { parseBuildings } from '../occlusion/geojson.js'
import { coverageCell } from './cell.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const RUN = join(ROOT, 'data/runs/e3-occlusion')
const BUILDINGS = join(ROOT, 'data/scene/beijing-yayuncun/buildings.geojson')
const SCENARIO = join(ROOT, 'data/scene/beijing-yayuncun/scenarios/golden-01.scenario.json')

const missing = [RUN, BUILDINGS].filter((p) => !existsSync(p))

test('覆盖图的单格路损 = 引擎 E3 链路帧的 path_loss_dB（同一点、同一频率）', { skip: missing.length ? `缺数据，跳过：${missing.join('、')}` : false }, () => {
  const readJsonl = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const links = readJsonl(join(RUN, 'links.jsonl')) as Array<{ t_s: number; path_loss_dB: number; line_of_sight: boolean; link_id: string }>
  const track = readJsonl(join(RUN, 'track.jsonl')) as Array<{ t_s: number; id: string; lon: number; lat: number; alt_m: number; center_Hz: number }>
  const sc = JSON.parse(readFileSync(SCENARIO, 'utf8'))
  const site = sc.sites[0]
  const terrain = sc.coordinate?.terrainHeight_m ?? 0
  const manifest = JSON.parse(readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/manifest.json'), 'utf8'))
  const [olon, olat] = manifest.aoi.center as [number, number]
  const frame = new SceneFrame(olon, olat)
  const map = new LocalSceneAdapter()
  map.setBuildings(parseBuildings(JSON.parse(readFileSync(BUILDINGS, 'utf8')), frame).buildings)

  const byT = new Map(track.filter((r) => r.id === 'uav-1').map((r) => [r.t_s, r]))
  let n = 0, nlos = 0, worst = 0
  for (const l of links) {
    const tr = byT.get(l.t_s)
    if (!tr) continue
    const c = coverageCell(
      { lon: site.position.lon, lat: site.position.lat, alt_m: site.position.alt_m },
      { lon: tr.lon, lat: tr.lat, alt_m: tr.alt_m }, terrain, { map, frame },
      { tx_power_dBm: 0, tx_gain_dBi: 0, rx_gain_dBi: 0, nf_dB: 0, noise_bw_Hz: 1, frequency_Hz: tr.center_Hz },
    )
    assert.ok(c.valid)
    assert.equal(c.blocked, !l.line_of_sight, `t = ${l.t_s} s 视距判定不同`)
    const e = Math.abs(c.fspl_dB + c.diffraction_dB - l.path_loss_dB)
    worst = Math.max(worst, e)
    assert.ok(e <= 1e-6, `t = ${l.t_s} s：覆盖图 ${c.fspl_dB + c.diffraction_dB} dB，链路帧 ${l.path_loss_dB} dB`)
    n++
    if (c.blocked) nlos++
  }
  assert.ok(n >= 50, `对上的时刻只有 ${n} 个`)
  assert.ok(nlos > 0, '一个非视距时刻都没有，锚点没测到遮挡那一半')
  console.log(`覆盖图 vs E3 链路帧：${n} 个时刻（非视距 ${nlos}），最差 ${worst.toExponential(3)} dB`)
})
