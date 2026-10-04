import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DetectionRow } from '../api/client.js'
import { frameDurationByNode, frameDurationOf, segmentsOf, tfSegmentsOf } from './segments.js'
import { subbandModeOf, visibleSegments, type DetectionState } from './detectionStore.js'

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

// 分子带（Q-4b，D-093）
const DT = 0.002048
const DF = 1 / DT
const REF = 2.44e9 - 2.25e5
const cl = (seg: number, i0: number, n: number, stat = 3, snr = 6) =>
  ({ f_lo_Hz: REF + i0 * DF, f_hi_Hz: REF + (i0 + n) * DF, bins: n, statistic: stat, snr_dB: snr, band_power_dBm: -60 + stat, segment_id: seg })

test('tfSegmentsOf：按 (node_id, 分子带段号) 分组，频段取核心（至少一半的帧里命中过的频点），同一帧多簇只计一帧', () => {
  const rows = [
    row('det', 0, null, { subband_hit: false, subbands: [] }),
    row('det', 1, null, { subband_hit: true, subbands: [cl(0, 10, 4)] }),
    row('det', 2, 7, { subband_hit: true, subbands: [cl(0, 10, 6, 9, 12), cl(1, 40, 2)] }),
    row('det', 3, null, { subband_hit: true, subbands: [cl(0, 12, 2), cl(0, 20, 1)], overload: true }),
    row('det__site-2', 2, null, { subband_hit: true, subbands: [cl(0, 30, 2)] }),
  ]
  const segs = tfSegmentsOf(rows, DT)
  assert.equal(segs.length, 3)
  const a = segs.find((g) => g.key === 'det|tf0')!
  assert.equal(a.tf, true)
  assert.equal(a.frames, 3)
  assert.ok(Math.abs(a.t_start - DT) < 1e-12 && Math.abs(a.t_end - 4 * DT) < 1e-12)
  // 计数 10:2 11:2 12:3 13:3 14:1 15:1 20:1，三帧里至少两帧 → 10..13
  assert.ok(Math.abs(a.f_lo_Hz - (REF + 10 * DF)) < 1e-6)
  assert.ok(Math.abs(a.f_hi_Hz - (REF + 14 * DF)) < 1e-6)
  assert.equal(a.peak_statistic, 9)
  assert.equal(a.peak_snr_dB, 12)
  assert.equal(a.overload, true)
  const b = segs.find((g) => g.key === 'det|tf1')!
  assert.equal(b.frames, 1)
  assert.ok(Math.abs(b.f_lo_Hz - (REF + 40 * DF)) < 1e-6 && Math.abs(b.f_hi_Hz - (REF + 42 * DF)) < 1e-6)
  const c = segs.find((g) => g.key === 'det__site-2|tf0')!
  assert.equal(c.site_id, 'site-2')
  // 帧级段号与分子带段号是两套编号：帧级 segment_id 7 不出现在分子带段里
  assert.ok(!segs.some((g) => g.segment_id === 7))
  // 抽稀时帧数按 stride 估
  assert.equal(tfSegmentsOf(rows, DT, 4).find((g) => g.key === 'det|tf0')!.frames, 12)
})

test('tfSegmentsOf：一个频点都没过半时取全部命中过的频点；没有 subbands 的行不进段', () => {
  const rows = [
    row('det', 0, null, { subband_hit: true, subbands: [cl(0, 10, 2)] }),
    row('det', 1, null, { subband_hit: true, subbands: [cl(0, 13, 2)] }),
    row('det', 2, null, { subband_hit: true, subbands: [cl(0, 16, 2)] }),
    row('det', 3, 0),
  ]
  const [g] = tfSegmentsOf(rows, DT)
  assert.ok(Math.abs(g.f_lo_Hz - (REF + 10 * DF)) < 1e-6 && Math.abs(g.f_hi_Hz - (REF + 18 * DF)) < 1e-6)
  assert.equal(tfSegmentsOf([row('det', 0, 0)], DT).length, 0)
})

test('visibleSegments：分子带模式下给分子带段，站过滤照旧；subbandModeOf 认索引与行上的键', () => {
  const frameSeg = segmentsOf([row('det', 1, 0)], DT)
  const tfSeg = tfSegmentsOf([row('det', 1, null, { subbands: [cl(3, 10, 2)] }), row('det__site-2', 1, null, { subbands: [cl(0, 10, 2)] })], DT)
  const base = { segments: frameSeg, tfSegments: tfSeg, siteFilter: null } as unknown as DetectionState
  assert.equal(visibleSegments({ ...base, subbandMode: false }), frameSeg)
  assert.deepEqual(visibleSegments({ ...base, subbandMode: true }).map((g) => g.key), ['det|tf3', 'det__site-2|tf0'])
  assert.deepEqual(visibleSegments({ ...base, subbandMode: true, siteFilter: 'site-2' }).map((g) => g.key), ['det__site-2|tf0'])
  assert.equal(subbandModeOf(null, [row('det', 1, 0)]), false)
  assert.equal(subbandModeOf(null, [row('det', 1, 0, { subband_hit: false })]), true)
})
