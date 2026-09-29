import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtAgo, fmtBytes, fmtDb, fmtDelta, fmtHz, fmtInstant } from './format.js'

test('fmtDb / fmtDelta', () => {
  assert.equal(fmtDb(-68.24), '-68.2 dB')
  assert.equal(fmtDb(-68.24, 'dBm'), '-68.2 dBm')
  assert.equal(fmtDb(Number.NaN), '—')
  assert.equal(fmtDb(null), '—')
  assert.equal(fmtDelta(100000, fmtHz), '+100 kHz')
  assert.equal(fmtDelta(-12.4, (x) => fmtDb(x)), '−12.4 dB')
  assert.equal(fmtDelta(null, fmtHz), '—')
})

test('fmtInstant / fmtAgo：时区可注入，认不出来写「—」不拿当下顶替（U-4）', () => {
  assert.equal(fmtInstant('2026-09-18T12:17:06Z', { timeZone: 'UTC' }), '2026-09-18 12:17:06')
  assert.equal(fmtInstant('2026-09-18T12:17:06Z', { timeZone: 'Asia/Shanghai' }), '2026-09-18 20:17:06')
  assert.equal(fmtInstant(undefined), '—')
  assert.equal(fmtInstant('不是时刻'), '—')

  const now = Date.parse('2026-09-19T00:00:00Z')
  assert.equal(fmtAgo('2026-09-19T00:00:00Z', now), '刚刚')
  assert.equal(fmtAgo('2026-09-18T23:58:00Z', now), '2 分钟前')
  assert.equal(fmtAgo('2026-09-18T21:00:00Z', now), '3 小时前')
  assert.equal(fmtAgo('2026-09-14T00:00:00Z', now), '5 天前')
  assert.equal(fmtAgo('2026-06-19T00:00:00Z', now), '3 个月前')
  assert.equal(fmtAgo('2026-09-19T01:00:00Z', now), '刚刚', '未来时刻不写负数')
  assert.equal(fmtAgo(null), '—')
})

test('fmtBytes：十进制单位、三位有效数字（D-090）', () => {
  assert.equal(fmtBytes(640_000_000), '640 MB')
  assert.equal(fmtBytes(1_600_000_000), '1.6 GB')
  assert.equal(fmtBytes(39_999_892), '40 MB')
  assert.equal(fmtBytes(9_999_892), '10 MB')
  assert.equal(fmtBytes(400_000), '400 kB')
  assert.equal(fmtBytes(999), '999 B')
  assert.equal(fmtBytes(null), '—')
})
