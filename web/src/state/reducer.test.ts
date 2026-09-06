import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEvent, initialState, reducer } from './reducer.js'
import type { AppState, ProductIndex, TaskRecord, WsTextEvent } from './types.js'

const rec = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  task_id: 't1', diagram_id: 'd', name: '示例', seed: 1, run_state: 'running', result: 'valid', reasons: [],
  created_utc: '2026-09-06T00:00:00Z', observation_points: [{ op_id: 's4', node: 'mix', port: 'out', products: ['envelope', 'spectrum'] }],
  data_refs: [], warnings: [], last_seq: 0, ...over,
})
const ev = (seq: number, type: string, payload: Record<string, unknown>, t_s = 0): WsTextEvent => ({ seq, task_id: 't1', type, t_s, payload })
const s0 = (): AppState => initialState(false, 2560, '')

test('导航与页签', () => {
  let s = reducer(s0(), { type: 'ui/navigate', view: 'results', resultsTab: 'tasks' })
  assert.equal(s.ui.view, 'results'); assert.equal(s.ui.resultsTab, 'tasks')
  s = reducer(s, { type: 'ui/navigate', view: 'diagram' })
  assert.equal(s.ui.view, 'diagram'); assert.equal(s.ui.resultsTab, 'tasks')
})

test('采用任务：已结束以 since = last_seq 订阅，运行中以 0', () => {
  const a = reducer(s0(), { type: 'task/adopt', record: rec({ run_state: 'finished', last_seq: 42 }) })
  assert.equal(a.task.subscribeSince, 42); assert.equal(a.ws.lastSeq, 42); assert.equal(a.signal.opId, 's4')
  const b = reducer(s0(), { type: 'task/adopt', record: rec({ run_state: 'running', last_seq: 42 }) })
  assert.equal(b.task.subscribeSince, 0); assert.equal(b.task.resultProvisional, true)
})

test('新建任务重置信号、日志与丢帧计数并给一条提示', () => {
  let s = reducer(s0(), { type: 'log/client', level: 'info', message: 'x' })
  s = reducer(s, { type: 'task/created', record: rec({ warnings: ['使用了验收集片段'] }) })
  assert.equal(s.log.ring.length, 0); assert.equal(s.ws.dropped, 0); assert.equal(s.context.taskId, 't1')
  assert.match(s.ui.toasts[0]!.text, /已提交任务 t1；使用了验收集片段/)
})

test('task.state 开始与结束：时长、观测点、结果态与提示', () => {
  let s = reducer(s0(), { type: 'task/created', record: rec({ run_state: 'queued', observation_points: [] }) })
  s = reducer(s, { type: 'stream/batch', wallMs: 0, events: [ev(1, 'task.state', { run_state: 'running', name: '示例', run: { duration_s: 2 }, observation_points: [{ op_id: 's4', node: 'mix', port: 'out', products: ['spectrum'] }] })] })
  assert.equal(s.task.runState, 'running'); assert.equal(s.task.duration_s, 2); assert.equal(s.signal.opId, 's4'); assert.equal(s.task.lastSeq, 1)
  const fin = reducer(s, { type: 'stream/batch', wallMs: 0, events: [ev(9, 'task.state', { run_state: 'finished', result: 'degraded', reasons: ['x'], realtime_factor: 12.5 }, 1.99)] })
  assert.equal(fin.task.runState, 'finished'); assert.equal(fin.task.result, 'degraded'); assert.equal(fin.task.resultProvisional, false)
  assert.equal(fin.task.realtimeFactor, 12.5); assert.equal(fin.task.t_s, 1.99)
  assert.equal(fin.ui.toasts.at(-1)!.kind, 'warn')
  const failed = reducer(s, { type: 'stream/batch', wallMs: 0, events: [ev(9, 'task.state', { run_state: 'failed' })] })
  assert.equal(failed.task.result, 'invalid'); assert.equal(failed.ui.toasts.at(-1)!.sticky, true)
  const cancelled = reducer(s, { type: 'stream/batch', wallMs: 0, events: [ev(9, 'task.state', { run_state: 'cancelled' })] })
  assert.equal(cancelled.task.result, 'not_applicable')
})

test('progress：墙钟跨度不足 500 ms 不给实时因子，之后按逻辑时间 / 墙钟估', () => {
  let s = reducer(s0(), { type: 'task/created', record: rec() })
  s = applyEvent(s, ev(2, 'progress', { round: 1 }, 0.1), 1000)
  assert.equal(s.task.realtimeFactor, null)
  s = applyEvent(s, ev(3, 'progress', { round: 2 }, 1.1), 2000)
  assert.ok(Math.abs(s.task.realtimeFactor! - 1.0) < 1e-9)
})

test('log 与 error 事件进环形缓冲；error 记到 task.error', () => {
  let s = reducer(s0(), { type: 'task/created', record: rec() })
  s = reducer(s, { type: 'stream/batch', wallMs: 0, events: [ev(2, 'log', { level: 'warning', message: 'w' }), ev(3, 'error', { code: 'run_failed', node_id: 'psd', port: '', message: 'boom' })] })
  assert.equal(s.log.ring.length, 2); assert.equal(s.log.ring[0]!.level, 'warn'); assert.equal(s.log.ring[1]!.node_id, 'psd')
  assert.equal(s.task.error?.code, 'run_failed')
})

test('signal/index：dBm 带常数 → dBm；dBFS 或缺常数 → dBFS 并记一条', () => {
  const base = reducer(s0(), { type: 'task/created', record: rec() })
  const idx: ProductIndex = { kind: 'spectrum', op_id: 's4', row_len: 1024, rows: 10, sample_rate_Hz: 1e6, center_Hz: 2.44e9, bin_width_Hz: 976.5625, frame_hop_samples: 1024, t0_s: 0, nfft: 1024, window: 'hann', scale: 'dBm', calibration: { offset_dB: 0, source: 'model' as const }, state: 'valid' as const, state_reasons: [], rows_available: 10, index_final: false, run_state: 'running' as const }
  const a = reducer(base, { type: 'signal/index', opId: 's4', index: idx })
  assert.equal(a.signal.display.unit, 'dBm'); assert.deepEqual(a.signal.display.calibration, { offset_dB: 0, source: 'model' })
  assert.deepEqual(a.signal.viewport, { t0: 0, t1: 10 * 1024 / 1e6, f0: -5e5, f1: 5e5, stat: 'max' })
  const b = reducer(base, { type: 'signal/index', opId: 's4', index: { ...idx, scale: 'dBFS', calibration: undefined } as ProductIndex })
  assert.equal(b.signal.display.unit, 'dBFS'); assert.equal(b.signal.display.calibration, null)
  const c = reducer(base, { type: 'signal/index', opId: 's4', index: { ...idx, calibration: undefined } as ProductIndex })
  assert.equal(c.signal.display.unit, 'dBFS'); assert.match(c.log.ring.at(-1)!.message, /没有标定常数/)
})

test('框图文本：解析错误、脏标与示例加载', () => {
  let s = reducer(s0(), { type: 'diagram/loadExample', text: '{"diagram_id":"x","run":{"seed":7}}' })
  assert.equal(s.diagram.dirty, false); assert.equal(s.context.diagramId, 'x'); assert.equal(s.context.seed, 7)
  s = reducer(s, { type: 'diagram/setText', text: '{"diagram_id":"x"' })
  assert.equal(s.diagram.dirty, true); assert.match(s.diagram.parseError!, /JSON 解析失败/)
  s = reducer(s, { type: 'diagram/markSaved' })
  assert.equal(s.diagram.dirty, false)
})

test('ws/status 关闭只在运行中任务上提示一次', () => {
  let s = reducer(s0(), { type: 'task/created', record: rec() })
  s = reducer(s, { type: 'ws/status', ws: { status: 'connected', lastSeq: 1, reconnects: 0, dropped: 0, attempt: 0, nextRetryMs: 0 } })
  s = reducer(s, { type: 'ws/status', ws: { status: 'closed', lastSeq: 1, reconnects: 0, dropped: 0, attempt: 0, nextRetryMs: 0 } })
  const n = s.ui.toasts.filter((t) => /断开/.test(t.text)).length
  s = reducer(s, { type: 'ws/status', ws: { status: 'closed', lastSeq: 1, reconnects: 0, dropped: 0, attempt: 0, nextRetryMs: 0 } })
  assert.equal(n, 1); assert.equal(s.ui.toasts.filter((t) => /断开/.test(t.text)).length, 1)
})
