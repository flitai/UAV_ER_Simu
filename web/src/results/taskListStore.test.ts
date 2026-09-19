import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeTaskList, taskListStore } from './taskListStore.js'
import type { TaskRecord } from '../state/types.js'

const rec = (id: string, run_state: TaskRecord['run_state']): TaskRecord => ({
  task_id: id, diagram_id: 'chain-default', name: '典型链路', seed: 1, run_state,
  result: run_state === 'finished' ? 'valid' : 'not_applicable', reasons: [],
  created_utc: '2026-09-18T12:00:00Z', observation_points: [], data_refs: [], warnings: [], last_seq: 0,
})

test('taskListStore：patch 只在真变了时通知，reset 回到空', () => {
  taskListStore.reset()
  let n = 0
  const off = taskListStore.subscribe(() => { n += 1 })
  taskListStore.patch({ status: 'loading' })
  assert.equal(n, 1)
  taskListStore.patch({ status: 'loading' })
  assert.equal(n, 1, '没变就不通知')
  taskListStore.patch({ tasks: [rec('t1', 'finished')], total: 941, offset: 0, status: 'ok' })
  assert.equal(n, 2)
  assert.equal(taskListStore.get().total, 941)
  off()
  taskListStore.reset()
  assert.deepEqual(taskListStore.get().tasks, [])
})

test('probeTaskList：只出计数与状态，不把行塞进探针', () => {
  taskListStore.reset()
  taskListStore.patch({
    tasks: [rec('t1', 'finished'), rec('t2', 'running'), rec('t3', 'queued')],
    total: 941, offset: 100, selected: 't2', status: 'ok',
  })
  const p = probeTaskList(taskListStore.get())
  assert.deepEqual(p, { status: 'ok', total: 941, offset: 100, shown: 3, selected: 't2', running: 2, error: null })
  assert.ok(!JSON.stringify(p).includes('chain-default'), '探针里不该有行内容')
  taskListStore.reset()
})
