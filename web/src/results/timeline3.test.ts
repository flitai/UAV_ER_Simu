import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeTimeline3, timeline3 } from './timeline3.js'
import type { RecognitionRow, TruthRow } from '../api/client.js'
import type { DetectionSegment } from './segments.js'

const truth = (o: Partial<TruthRow>): TruthRow => ({
  t_s: 0, t_end_s: 1, node_id: 'eval', emitter_id: 'uav-1', label: 'cw_beacon',
  waveform: 'tone', center_Hz: 2.4405e9, bw_Hz: 4e5, in_band: true, ...o,
})
const seg = (o: Partial<DetectionSegment>): DetectionSegment => ({
  key: 'det|0', node_id: 'det', site_id: null, segment_id: 0, t_start: 0, t_end: 1, frames: 10,
  peak_statistic: 5, peak_band_power_dBm: -70, peak_snr_dB: 7, overload: false,
  f_lo_Hz: 2.44e9, f_hi_Hz: 2.441e9, ...o,
})
const rec = (o: Partial<RecognitionRow>): RecognitionRow => ({
  t_s: 0, t_end_s: 1, node_id: 'rec', segment_id: 0, label: 'cw_beacon', posterior: 0.9,
  top_n: [], distance: 1, result: 'known', unknown_kind: null, evidence_quality: 'full',
  library_version: 'v1', trace: {}, ...o,
})

test('三行条带：起止逐值来自行本身，按时间排序，站为 null 时不过滤（C-9）', () => {
  const t = timeline3(null,
    [truth({ t_s: 2, t_end_s: 2.5 }), truth({ t_s: 0, t_end_s: 0.5 })],
    [seg({ key: 'det|1', segment_id: 1, t_start: 2.01, t_end: 2.48 })],
    [rec({ segment_id: 1, t_s: 2.01, t_end_s: 2.48 })])
  assert.deepEqual(t.truth.map((b) => [b.t0, b.t1]), [[0, 0.5], [2, 2.5]])
  assert.deepEqual(t.detect.map((b) => [b.t0, b.t1]), [[2.01, 2.48]])
  assert.deepEqual(t.recognize.map((b) => [b.t0, b.t1]), [[2.01, 2.48]])
  assert.equal(t.truth[0].text, '信标')
  assert.equal(t.detect[0].text, '1')
})

test('焦点站只画那一站的三行', () => {
  const t = timeline3('site-2',
    [truth({ site_id: 'site-1' }), truth({ site_id: 'site-2', t_s: 3, t_end_s: 4 })],
    [seg({ site_id: 'site-1' }), seg({ key: 'det|2', site_id: 'site-2', t_start: 3, t_end: 4 })],
    [rec({ site_id: 'site-1' })])
  assert.equal(t.site, 'site-2')
  assert.equal(t.truth.length, 1)
  assert.equal(t.truth[0].t0, 3)
  assert.equal(t.detect.length, 1)
  assert.equal(t.recognize.length, 0)
})

test('识别为 unknown 的段按 unknown 着色与写名，不写它的 Top-1 标签', () => {
  const t = timeline3(null, [], [], [rec({ label: 'cw_beacon', result: 'unknown' })])
  assert.equal(t.recognize[0].text, '未知')
  assert.equal(t.recognize[0].color, '#a33333')
  assert.match(t.recognize[0].title, /识别 cw_beacon/)   // 悬停仍说出 Top-1 是什么，不藏
})

test('零时长的段（回放清单真值）按 minSpan 加宽到看得见，起点不动', () => {
  const t = timeline3(null, [truth({ t_s: 1, t_end_s: 1 })], [], [], 0.05)
  assert.deepEqual([t.truth[0].t0, t.truth[0].t1], [1, 1.05])
})

test('探针：三行条数与覆盖时长（重叠只算一次）', () => {
  const t = timeline3(null,
    [truth({ t_s: 0, t_end_s: 1 }), truth({ t_s: 0.5, t_end_s: 2 })], [], [])
  const p = probeTimeline3(t)
  assert.equal(p.truth, 2)
  assert.equal(p.truthCover, 2)
  assert.deepEqual(p.first, { t0: 0, t1: 1, text: '信标' })
})
