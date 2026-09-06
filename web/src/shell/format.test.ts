import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtDb, fmtDelta, fmtHz } from './format.js'

test('fmtDb / fmtDelta', () => {
  assert.equal(fmtDb(-68.24), '-68.2 dB')
  assert.equal(fmtDb(-68.24, 'dBm'), '-68.2 dBm')
  assert.equal(fmtDb(Number.NaN), '—')
  assert.equal(fmtDb(null), '—')
  assert.equal(fmtDelta(100000, fmtHz), '+100 kHz')
  assert.equal(fmtDelta(-12.4, (x) => fmtDb(x)), '−12.4 dB')
  assert.equal(fmtDelta(null, fmtHz), '—')
})
