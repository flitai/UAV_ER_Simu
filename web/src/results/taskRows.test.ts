import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canCancel, pageNote, summaryRows, taskRow } from './taskRows.js'
import type { TaskRecord } from '../state/types.js'

const base: TaskRecord = {
  task_id: 't20260918-121706-7c42', diagram_id: 'chain-default', name: '典型链路 · 全合成',
  seed: 20260907, run_state: 'finished', result: 'valid', reasons: [],
  created_utc: '2026-09-18T12:17:06Z', wall_s: 14.772872875, realtime_factor: 0.4061498430785082,
  observation_points: [{ op_id: 's4', node: 'adc', port: 'out', products: ['spectrum'] }],
  data_refs: [], warnings: [], last_seq: 74115, scenario_id: 'demo-02',
  diagram_sha256: 'fcd9e8004e4e0f98dbd79dcc72648908de7a4306cbfaf5c46f3576146e413259',
  scenario_sha256: '46dbc3f254e1ff9ec50962cc30c98b51eeadbf7565b723993b15848c1a615027',
  engine_version: '0.1.0', seed_source: 'diagram',
  started_utc: '2026-09-18T12:17:06Z', ended_utc: '2026-09-18T12:17:20Z', exit_code: 0,
}

test('taskRow：时刻、墙钟与实时因子合一列、评价按站数选写法', () => {
  const r = taskRow(base, { timeZone: 'UTC' })
  assert.equal(r.when, '2026-09-18 12:17:06')
  assert.equal(r.scenarioId, 'demo-02')
  assert.equal(r.wall, '14.773 s ×0.4')
  assert.equal(r.metrics, '—', '没有评价器的任务不编一个数出来')
  assert.equal(r.holdout, false)

  const one = taskRow({ ...base, metrics_summary: [{ node_id: 'eval', truth_source: 'scenario', pd: 1, pfa: 0.0065, f1: 0.9976, accuracy: 1, state: 'valid' }] })
  assert.equal(one.metrics, 'Pd 1.000 · 识别 1.00')

  const three = taskRow({ ...base, metrics_summary: [0, 1, 2].map((i) => ({ node_id: `eval__site-${i}`, truth_source: 'scenario', pd: null, pfa: null, f1: null, accuracy: null, state: 'valid' })) })
  assert.equal(three.metrics, '3 站', 'K 站一行放不下，只写站数')

  // pd 是 null（分母为零）时写「—」，不当成 0（铁律 15，与 C-9 的 ROC 同一条）
  const nul = taskRow({ ...base, metrics_summary: [{ node_id: 'eval', truth_source: 'scenario', pd: null, pfa: null, f1: null, accuracy: null, state: 'valid' }] })
  assert.equal(nul.metrics, 'Pd — · 识别 —')

  const hold = taskRow({ ...base, data_refs: [{ node_id: 'tx', data_id: 'dronerfb_0_CH0_S4', holdout: true }] })
  assert.equal(hold.holdout, true)
})

test('taskRow：没跑完的任务不编墙钟', () => {
  const r = taskRow({ ...base, run_state: 'running', wall_s: undefined, realtime_factor: undefined })
  assert.equal(r.wall, '—')
})

test('pageNote：列不全就说清第几到第几', () => {
  assert.equal(pageNote(0, 0, 0), '共 0 个任务')
  assert.equal(pageNote(7, 0, 7), '共 7 个任务')
  assert.equal(pageNote(941, 0, 100), '共 941 个任务 · 第 1–100 个')
  assert.equal(pageNote(941, 900, 41), '共 941 个任务 · 第 901–941 个')
})

test('canCancel：只有排队中与运行中', () => {
  for (const rs of ['queued', 'running'] as const) assert.equal(canCancel({ ...base, run_state: rs }), true)
  for (const rs of ['finished', 'failed', 'cancelled'] as const) assert.equal(canCancel({ ...base, run_state: rs }), false)
})

test('summaryRows：选中的是当前任务时不重复左栏已有的四项（D-062）', () => {
  const other = summaryRows(base, false, false).map((r) => r.key)
  const cur = summaryRows(base, true, false).map((r) => r.key)
  for (const k of ['seed', 'wall', 'taps']) {
    assert.ok(other.includes(k), `不是当前任务时要有 ${k}`)
    assert.ok(!cur.includes(k), `当前任务时不该重复 ${k}（左栏 data-task-facts 已有）`)
  }
  assert.ok(cur.includes('scenario') && cur.includes('created'))
})

test('summaryRows：哈希与引擎版本只在 ?dev=1（D-039、09 §9）', () => {
  const plain = summaryRows(base, false, false)
  const dev = summaryRows(base, false, true)
  for (const k of ['diagram_sha256', 'scenario_sha256', 'engine', 'exit']) {
    assert.ok(!plain.some((r) => r.key === k), `默认不该出现 ${k}`)
    assert.ok(dev.some((r) => r.key === k && r.dev === true), `?dev=1 要有 ${k} 且标了 dev`)
  }
  assert.equal(dev.find((r) => r.key === 'diagram_sha256')?.value, 'fcd9e8004e4e…')
})
