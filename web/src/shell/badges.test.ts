import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resultBadge, runStateGlyph } from './badges.js'

test('运行态五个图标', () => {
  assert.deepEqual(['queued', 'running', 'finished', 'failed', 'cancelled'].map((r) => runStateGlyph(r as never).glyph), ['○', '▶', '■', '✕', '⊘'])
})

test('结果态规则：失败⇒无效、取消⇒不适用、运行中空心加（暂定）', () => {
  assert.equal(resultBadge('failed', 'valid').text, '无效')
  assert.equal(resultBadge('cancelled', 'valid').text, '不适用')
  const live = resultBadge('running', 'valid')
  assert.equal(live.hollow, true); assert.equal(live.suffix, '（暂定）'); assert.equal(live.text, '有效')
  const done = resultBadge('finished', 'degraded')
  assert.equal(done.hollow, false); assert.equal(done.suffix, ''); assert.equal(done.tone, 'warn'); assert.equal(done.glyph, '▲')
  assert.equal(resultBadge(null, null).text, '不适用')
})
