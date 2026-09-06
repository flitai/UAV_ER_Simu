import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOG_CAP, filterLog, levelOf, lineFromEvent, pushLines } from './logRing.js'
import type { LogLine } from './types.js'

const line = (i: number, level: LogLine['level'] = 'info', message = `m${i}`): LogLine => ({ id: i, seq: i, t_s: 0, level, message, origin: 'engine' })

test('环形上限只留最新', () => {
  const lines = Array.from({ length: LOG_CAP + 5 }, (_, i) => line(i))
  const ring = pushLines([], lines)
  assert.equal(ring.length, LOG_CAP); assert.equal(ring[0]!.id, 5); assert.equal(ring.at(-1)!.id, LOG_CAP + 4)
})

test('级别映射与事件转行', () => {
  assert.equal(levelOf('warning'), 'warn'); assert.equal(levelOf('ERROR'), 'error'); assert.equal(levelOf(undefined), 'info')
  const l = lineFromEvent({ seq: 3, task_id: 't', type: 'error', t_s: 1.5, payload: { code: 'x', node_id: 'n', port: 'p', message: 'boom' } }, 9)
  assert.equal(l?.level, 'error'); assert.equal(l?.node_id, 'n'); assert.equal(l?.port, 'p'); assert.match(l!.message, /^x：boom/)
  assert.equal(lineFromEvent({ seq: 1, task_id: 't', type: 'progress', t_s: 0, payload: {} }, 1), null)
})

test('过滤：级别与关键字', () => {
  const ring = [line(1, 'info', 'alpha'), line(2, 'warn', 'beta'), line(3, 'error', 'gamma')]
  assert.equal(filterLog(ring, 'all', '').length, 3)
  assert.equal(filterLog(ring, 'warn', '').length, 2)
  assert.equal(filterLog(ring, 'error', '').length, 1)
  assert.equal(filterLog(ring, 'all', 'GAM').length, 1)
})
