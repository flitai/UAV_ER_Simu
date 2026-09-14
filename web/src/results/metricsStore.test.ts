import { test } from 'node:test'
import assert from 'node:assert/strict'
import { metricsStore, probeMetrics } from './metricsStore.js'
import type { MetricsDoc } from '../api/client.js'

test('评价 store：探针摘要逐节给四个数与状态，null 照抄；换任务即清（C-5）', () => {
  metricsStore.reset('t1')
  const doc = {
    schema_version: 'cuav-metrics/1', task_id: 't1', localization: null,
    sites: [{
      node_id: 'eval__site-1', site_id: 'site-1', truth_source: 'scenario',
      params: { truth_source: 'scenario', match_overlap: 0.5, roc_points: 32, nfft: 1024 },
      detector: { sample_rate_Hz: 5e5, f_lo_Hz: 2.44e9, f_hi_Hz: 2.441e9, frame_dt_s: 0.002048, threshold: 1.1 },
      trace: { model_id: 'eval-baseline' },
      frames: { total: 10, truth_on: 5, tp: 4, fp: 0, fn: 1, tn: 5, pd: 0.8, pfa: 0, precision: 1, recall: 0.8, f1: 0.888 },
      segments: { truth: 1, truth_out_of_band: 0, detected: 1, matched: 1, false_segments: 0, pd_segment: 1, detect_delay_s: { mean: 0.01, max: 0.01 } },
      roc: { working_point: { threshold: 1.1, pd: 0.8, pfa: 0 }, points: [] },
      recognition: { state: 'valid', labels: ['cw_beacon', 'unknown'], confusion: [[1, 0], [0, 0]], evaluated: 1, unmatched: 0, accuracy: 1, unknown_rate: 0, ambiguous_rate: 0, per_class: [] },
      quality: { overload_frames: 0, noise_stale_frames: null, truth_rows: 1 },
      state: 'valid', reasons: [],
    }, {
      node_id: 'eval__site-2', site_id: 'site-2', truth_source: 'scenario',
      params: { truth_source: 'scenario', match_overlap: 0.5, roc_points: 32, nfft: 1024 },
      detector: { sample_rate_Hz: 5e5, f_lo_Hz: 2.44e9, f_hi_Hz: 2.441e9, frame_dt_s: 0.002048, threshold: 1.1 },
      trace: { model_id: 'eval-baseline' },
      frames: { total: 10, truth_on: 10, tp: 0, fp: 0, fn: 10, tn: 0, pd: 0, pfa: null, precision: null, recall: 0, f1: null },
      segments: { truth: 1, truth_out_of_band: 0, detected: 0, matched: 0, false_segments: 0, pd_segment: 0, detect_delay_s: { mean: null, max: null } },
      roc: { working_point: { threshold: 1.1, pd: 0, pfa: null }, points: [] },
      recognition: { state: 'valid', labels: [], confusion: [], evaluated: 0, unmatched: 0, accuracy: null, unknown_rate: null, ambiguous_rate: null, per_class: [] },
      quality: { overload_frames: 0, noise_stale_frames: null, truth_rows: 1 },
      state: 'valid', reasons: [],
    }],
  } as MetricsDoc
  metricsStore.patch({ doc, status: 'final' })
  const p = probeMetrics(metricsStore.get())
  assert.equal(p.status, 'final')
  assert.equal(p.sites.length, 2)
  assert.deepEqual(p.sites[0], { node_id: 'eval__site-1', site_id: 'site-1', truth_source: 'scenario', pd: 0.8, pfa: 0, f1: 0.888, accuracy: 1, pd_segment: 1, truth: 1, matched: 1, state: 'valid' })
  assert.equal(p.sites[1]!.pfa, null)
  assert.equal(p.sites[1]!.accuracy, null)
  metricsStore.reset('t2')
  assert.equal(metricsStore.get().doc, null)
  assert.equal(probeMetrics(metricsStore.get()).sites.length, 0)
})
