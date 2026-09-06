import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SignalBuffer, peakBinOf } from './buffer.js'
import type { RowHeader } from '../api/frames.js'

const h = (row_index: number, seq = row_index + 1): RowHeader => ({ seq, task_id: 't', op_id: 's4', kind: 'spectrum', row_index, row_len: 3, t_s: 0 })

test('按 (op, kind) 环存，最新在前，环满保留最新', () => {
  const b = new SignalBuffer()
  b.reset('t')
  b.push(h(0), new Float32Array([1, 2, 3]))
  b.push(h(1), new Float32Array([4, 9, 6]))
  assert.equal(b.rows('s4', 'spectrum'), 2); assert.equal(b.cols('s4', 'spectrum'), 3)
  assert.deepEqual(Array.from(b.latestRow('s4', 'spectrum')!), [4, 9, 6])
  assert.deepEqual(Array.from(b.latestRow('s4', 'spectrum', 1)!), [1, 2, 3])
  assert.equal(peakBinOf(b.latestRow('s4', 'spectrum')), 1)
  assert.equal(b.rows('s4', 'envelope'), 0)
  b.push({ ...h(5), task_id: 'other' }, new Float32Array([0, 0, 0]))
  assert.equal(b.rows('s4', 'spectrum'), 2)     // 别的任务的行丢弃
  b.push(h(4), new Float32Array([7, 7, 7]))
  assert.deepEqual(b.droppedRanges('s4', 'spectrum'), [{ from: 2, to: 3 }])
  assert.equal(b.newestRowIndex('s4', 'spectrum'), 4)
  b.reset('t2')
  assert.equal(b.rows('s4', 'spectrum'), 0)
  assert.equal(peakBinOf(null), null)
})
