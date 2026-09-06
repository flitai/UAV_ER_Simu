import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState } from './reducer.js'
import { probeApp, productStateNote, scaleLabel, timeBasis, wsStatusText } from './selectors.js'
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
  for (const k of ['opId', 'viewport', 'rows', 'cols', 'peakBin', 'scaleLabel', 'calibration', 'waterfallNewestRow', 'markers', 'mode', 'follow', 'cursor_t_s', 'lastFetch', 'bounds', 'drawnRows', 'hatchedRows', 'geom', 'shown', 'fetchStatus']) assert.ok(k in a.signal, k)
  assert.equal(a.signal.waterfallNewestRow, 'top'); assert.equal(a.badges.noScene, true); assert.equal(a.mapInstanceId, 1)
  assert.equal(a.signal.mode, 'follow'); assert.deepEqual(a.signal.markers, [{ id: 'M1', freq_Hz: null, level_dB: null }])
  assert.deepEqual(a.perf, { longTasks: null })
  assert.equal(probeApp(initialState(false, 1920, ''), { mapInstanceId: 1, rows: 0, cols: 0, peakBin: null }).perf, null)
  const withView = probeApp(s, { mapInstanceId: 1, rows: 0, cols: 0, peakBin: null, longTasks: { count: 0, maxMs: 0 }, signalView: {
    mode: 'browse', W: 800, H: 400, dpr: 2, drawnRows: 400, hatchedRows: 0, fetchStatus: 'idle', fetchDetail: null,
    m1: { k: 614, f: 2.4401e9, v: -70.9 }, m2Level: null, hover: null, bounds: { spectrum: [56, 856], waterfall: [56, 856] }, shown: { t0: 0, t1: 2, f0: -5e5, f1: 5e5 }, envRange: null, liveRows: 0, liveFrames: 0,
    lastFetch: { key: { task: 't', op: 's4', t0: 0, t1: 2, f0: -5e5, f1: 5e5, px: 800, py: 400, stat: 'max', envPx: 400 }, spec: { data: new Float32Array(0), rows: 400, cols: 800, t0: 0, t1: 2, f0: -5e5, f1: 5e5 }, env: null, state: 'valid', meta: { rows: 400, cols: 800, t0: 0, t1: 2, f0: -5e5, f1: 5e5, stat: 'max', state: 'valid' } },
  } })
  assert.equal(withView.signal.mode, 'browse'); assert.equal(withView.signal.lastFetch?.py, 400); assert.equal(withView.signal.markers[0]?.level_dB, -70.9)
  assert.deepEqual(withView.perf, { longTasks: { count: 0, maxMs: 0 } })
})

test('productStateNote：有效或无索引不提示；降级 / 无效 / 不适用带第一条原因与色调', () => {
  assert.equal(productStateNote(null), null)
  assert.equal(productStateNote(idx({ state: 'valid', state_reasons: ['x'] })), null)
  assert.deepEqual(productStateNote(idx({ state: 'degraded', state_reasons: ['采集参数来自论文而非设备记录', '第二条'] })),
    { text: '降级：采集参数来自论文而非设备记录', tone: 'warn' })
  assert.deepEqual(productStateNote(idx({ state: 'degraded', state_reasons: [] })), { text: '降级', tone: 'warn' })
  assert.deepEqual(productStateNote(idx({ state: 'invalid', state_reasons: ['短读'] })), { text: '无效：短读', tone: 'bad' })
  assert.deepEqual(productStateNote(idx({ state: 'not_applicable', state_reasons: [] })), { text: '不适用', tone: 'na' })
})
