import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DetectionRow } from '../api/client.js'
import { frameDurationByNode, frameDurationOf, segmentsOf } from './segments.js'

const row = (node: string, i: number, seg: number | null, extra: Partial<DetectionRow> = {}): DetectionRow => ({
  t_s: i * 0.002048, node_id: node, site_id: node.includes('__') ? node.split('__')[1] : undefined,
  start_sample: i * 1024, frame_index: i, segment_id: seg,
  f_lo_Hz: 2.44e9 - 2.25e5, f_hi_Hz: 2.44e9 + 2.25e5,
  statistic: seg === null ? 0.9 : 5 + i, threshold: 1.1, hit: seg !== null,
  snr_dB: seg === null ? -0.5 : 10 + i, overload: false, noise_frames_used: 256, ...extra,
})

test('segmentsOf：按 (node_id, segment_id) 分组，起止与峰值正确，按起点排序', () => {
  const rows = [
    row('det', 0, null), row('det', 1, 0), row('det', 2, 0, { band_power_dBm: -40 }), row('det', 3, null),
    row('det', 10, 1, { band_power_dBm: -35, overload: true }), row('det', 11, 1, { band_power_dBm: -50 }),
    row('det__site-2', 5, 0),
  ]
  const segs = segmentsOf(rows, 0.002048)
  assert.equal(segs.length, 3)
  assert.deepEqual(segs.map((s) => s.key), ['det|0', 'det__site-2|0', 'det|1'])
  const a = segs[0]!
  assert.equal(a.t_start, 1 * 0.002048)
  assert.ok(Math.abs(a.t_end - 3 * 0.002048) < 1e-12)
  assert.equal(a.frames, 2)
  assert.equal(a.peak_statistic, 7)
  assert.equal(a.peak_band_power_dBm, -40)
  assert.equal(a.overload, false)
  assert.equal(a.site_id, null)
  const b = segs[2]!
  assert.equal(b.peak_band_power_dBm, -35)
  assert.equal(b.overload, true)
  assert.equal(segs[1]!.site_id, 'site-2')
})

test('segmentsOf：非命中行与 segment_id 为 null 的行不进段；抽稀时帧数按 stride 估', () => {
  const rows = [row('det', 0, null), row('det', 4, 0), row('det', 8, 0), row('det', 12, 0)]
  const segs = segmentsOf(rows, 0.002048, 4)
  assert.equal(segs.length, 1)
  assert.equal(segs[0]!.frames, 12)
  assert.equal(segmentsOf([], 0.002048).length, 0)
})

test('frameDurationOf：索引优先，否则取同节点相邻行的最小正时差', () => {
  const rows = [row('det', 0, null), row('det', 1, null), row('det__x', 0, null), row('det__x', 3, null)]
  assert.equal(frameDurationOf(rows, 0.5), 0.5)
  assert.ok(Math.abs(frameDurationOf(rows, null) - 0.002048) < 1e-12)
  assert.equal(frameDurationOf([], null), 0)
})

test('逐站帧长：各站按自己的 dt 算突发时长（M-2，D-070）', () => {
  // 多站下各站的 DDC 抽取比可以不同，帧长随之不同。以前 detectionStore 取 index.nodes 的
  // 第一个 dt_s 给所有站用，于是别的站的突发时长全按第一个站的帧长算。
  const rows = [
    row('det__site-1', 0, 0), row('det__site-1', 1, 0),
    row('det__site-2', 0, 0), row('det__site-2', 2, 0),
  ]
  const segs = segmentsOf(rows, { 'det__site-1': 0.002048, 'det__site-2': 0.004096 })
  const s1 = segs.find((x) => x.node_id === 'det__site-1')!
  const s2 = segs.find((x) => x.node_id === 'det__site-2')!
  assert.equal(s1.t_end, 0.002048 * 2)
  assert.equal(s2.t_end, 0.004096 * 2, 'site-2 的段长应当是 site-1 的两倍')

  // 索引缺了 site-2 那一项时，回退到**它自己**相邻行的最小时差，而不是全局最小
  const by = frameDurationByNode(rows, { 'det__site-1': 0.002048 })
  assert.equal(by['det__site-1'], 0.002048)
  assert.equal(by['det__site-2'], 0.004096)

  // 给一个数仍然按老行为走（既有调用点与既有用例因此一字不改）：
  // site-2 末行在 0.004096，配上全局帧长 0.002048 就是 0.006144——这正是老写法把
  // site-1 的帧长安到 site-2 头上的后果，段尾因此短了一个 site-2 的帧。
  const flat = segmentsOf(rows, 0.002048)
  assert.equal(flat.find((x) => x.node_id === 'det__site-2')!.t_end, 0.004096 + 0.002048)
  assert.ok(s2.t_end > flat.find((x) => x.node_id === 'det__site-2')!.t_end)
})
