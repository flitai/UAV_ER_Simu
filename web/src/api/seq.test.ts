import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SeqTracker } from './seq.js'

test('连续、重复、缺号', () => {
  const t = new SeqTracker(5)
  assert.equal(t.classify(6, 'log', {}), 'apply'); assert.equal(t.lastSeq, 6)
  assert.equal(t.classify(6, 'log', {}), 'dup'); assert.equal(t.classify(3, 'log', {}), 'dup')
  assert.equal(t.classify(9, 'log', {}), 'gap'); assert.equal(t.lastSeq, 6)
})

test('seq 0 不推进，唯 dropped 令 lastSeq = to 并累计', () => {
  const t = new SeqTracker(10)
  assert.equal(t.classify(0, 'heartbeat', { last_seq: 99 }), 'conn'); assert.equal(t.lastSeq, 10)
  assert.equal(t.classify(0, 'dropped', { from: 11, to: 14, count: 4 }), 'conn'); assert.equal(t.lastSeq, 14); assert.equal(t.dropped, 4)
  assert.equal(t.classify(0, 'dropped', { from: 3, to: 5, count: 3 }), 'conn'); assert.equal(t.lastSeq, 14); assert.equal(t.dropped, 7)
  assert.equal(t.classify(15, 'log', {}), 'apply')
})

test('advanceTo 返回跳过的区间', () => {
  const t = new SeqTracker(2)
  assert.deepEqual(t.advanceTo(6), { from: 3, to: 5 }); assert.equal(t.lastSeq, 6)
  assert.equal(t.advanceTo(7), null); assert.equal(t.lastSeq, 7)
  assert.equal(t.advanceTo(3), null)
})
