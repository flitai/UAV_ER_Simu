import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState } from './reducer.js'
import { probeApp, scaleLabel, timeBasis, wsStatusText } from './selectors.js'
import type { ProductIndex } from './types.js'

const idx = (over: Partial<ProductIndex>): ProductIndex => ({
  kind: 'spectrum', op_id: 's4', row_len: 1024, rows: 1, sample_rate_Hz: 1e6, center_Hz: 0, t0_s: 0, scale: 'dBFS',
  state: 'valid', state_reasons: [], rows_available: 1, index_final: false, run_state: 'running', ...over,
})

test('轴标文字：用户只见 dBm，开发者模式带来源；无常数一律 dBFS（未标定）', () => {
  const cal = idx({ scale: 'dBm', calibration: { offset_dB: 0, source: 'model' } })
  assert.equal(scaleLabel(cal, false), 'dBm')
  assert.equal(scaleLabel(cal, true), 'dBm · 标定：模型')
  assert.equal(scaleLabel(idx({ scale: 'dBm', calibration: { offset_dB: -50, source: 'paper' } }), true), 'dBm · 标定：论文')
  assert.equal(scaleLabel(idx({ scale: 'dBFS' }), false), 'dBFS（未标定）')
  assert.equal(scaleLabel(idx({ scale: 'dBFS' }), true), 'dBFS（未标定）')
  assert.equal(scaleLabel(idx({ scale: 'dBm' }), false), 'dBFS（未标定）')   // 写了 dBm 却无常数
  assert.equal(scaleLabel(null, false), null)
})

test('时间基准与 WS 文字', () => {
  const s = initialState(false, 1920, '')
  assert.deepEqual(timeBasis(s), { text: 'WGS-84 · AGL · LogicalSim', attr: 'WGS-84 AGL LogicalSim' })
  assert.equal(timeBasis({ ...s, task: { ...s.task, dataRefs: 1 } }).attr, 'WGS-84 AGL FileAcquisition')
  assert.equal(wsStatusText({ status: 'connected', lastSeq: 1842, reconnects: 0, dropped: 0, attempt: 0, nextRetryMs: 0 }), '● 已连接 seq 1842')
  assert.equal(wsStatusText({ status: 'reconnecting', lastSeq: 1, reconnects: 2, dropped: 0, attempt: 2, nextRetryMs: 2000 }), '● 重连中（第 2 次，2 s 后）')
  assert.equal(wsStatusText({ status: 'closed', lastSeq: 1, reconnects: 0, dropped: 0, attempt: 0, nextRetryMs: 0 }), '● 已断开')
})

test('探针 app 子对象含 09 §10 的全部键', () => {
  const s = initialState(true, 1920, '')
  const a = probeApp(s, { mapInstanceId: 1, rows: 0, cols: 0, peakBin: null })
  for (const k of ['view', 'context', 'task', 'ws', 'drawer', 'unsaved', 'undo', 'links', 'signal', 'badges', 'mapInstanceId']) assert.ok(k in a, k)
  for (const k of ['opId', 'viewport', 'rows', 'cols', 'peakBin', 'scaleLabel', 'calibration', 'waterfallNewestRow', 'markers']) assert.ok(k in a.signal, k)
  assert.equal(a.signal.waterfallNewestRow, 'top'); assert.equal(a.badges.noScene, true); assert.equal(a.mapInstanceId, 1)
})
