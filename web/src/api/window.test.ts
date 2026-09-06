import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkWindowBody, envelopeQueryString, parseRetryAfterMs, parseSuggest, parseWindowHeaders, spectrumQueryString } from './window.js'

const hdr = (m: Record<string, string>) => (n: string) => m[n] ?? null

test('parseWindowHeaders：谱带 f0/f1/stat，包络没有；缺关键头抛错', () => {
  const s = parseWindowHeaders(hdr({ 'x-cuav-rows': '4', 'x-cuav-cols': '6', 'x-cuav-t0': '0.003', 'x-cuav-t1': '0.013000000000000001', 'x-cuav-f0': '-12500', 'x-cuav-f1': '7500', 'x-cuav-stat': 'max', 'x-cuav-state': 'valid' }))
  assert.deepEqual(s, { rows: 4, cols: 6, t0: 0.003, t1: 0.013000000000000001, f0: -12500, f1: 7500, stat: 'max', state: 'valid' })
  const e = parseWindowHeaders(hdr({ 'x-cuav-rows': '5', 'x-cuav-cols': '3', 'x-cuav-t0': '0', 'x-cuav-t1': '0.23', 'x-cuav-state': 'degraded' }))
  assert.deepEqual(e, { rows: 5, cols: 3, t0: 0, t1: 0.23, f0: null, f1: null, stat: null, state: 'degraded' })
  assert.throws(() => parseWindowHeaders(hdr({ 'x-cuav-cols': '3', 'x-cuav-t0': '0', 'x-cuav-t1': '1', 'x-cuav-state': 'valid' })), /X-CUAV-ROWS/)
  assert.throws(() => parseWindowHeaders(hdr({ 'x-cuav-rows': '1', 'x-cuav-cols': '3', 'x-cuav-t0': '0', 'x-cuav-t1': '1' })), /X-CUAV-STATE/)
})

test('checkWindowBody / parseRetryAfterMs / parseSuggest', () => {
  const meta = { rows: 2, cols: 3, t0: 0, t1: 1, f0: null, f1: null, stat: null, state: 'valid' }
  checkWindowBody(24, meta)
  assert.throws(() => checkWindowBody(20, meta), /short_body/)
  assert.equal(parseRetryAfterMs('2'), 2000)
  assert.equal(parseRetryAfterMs(null), 1000)
  assert.equal(parseRetryAfterMs('abc'), 1000)
  assert.deepEqual(parseSuggest({ error: 'payload_too_large', suggest: { px: 1024.7, py: 300 } }), { px: 1024, py: 300 })
  assert.equal(parseSuggest({ suggest: { px: 0, py: 1 } }), null)
  assert.equal(parseSuggest('x'), null)
})

test('查询串：数字原样、px/py 取整并限 9 位', () => {
  assert.equal(spectrumQueryString({ t0: 0.4, t1: 1.6, f0: -2e5, f1: 2e5, px: 1800.9, py: 0, stat: 'mean' }), 't0=0.4&t1=1.6&f0=-200000&f1=200000&px=1800&py=1&stat=mean')
  assert.equal(envelopeQueryString({ t0: 0, t1: 2, px: 1e12 }), 't0=0&t1=2&px=999999999')
})
