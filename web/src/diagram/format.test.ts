import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEng, formatEng, formatEngExact, summarize, plainNum } from './format.js'

test('工程计数法输入：前缀、科学计数、负号', () => {
  assert.equal(parseEng('2.44G'), 2.44e9)
  assert.equal(parseEng('20M'), 20e6)
  assert.equal(parseEng('1e6'), 1e6)
  assert.equal(parseEng('500k'), 500e3)
  assert.equal(parseEng('-70'), -70)
  assert.equal(parseEng(' 1.5 M '), 1.5e6)
  assert.equal(parseEng('6.1u'), 6.1e-6)
})

test('不合法输入返回 null，不猜', () => {
  for (const bad of ['', 'abc', '1.2.3', '5X', '--3', '1e']) assert.equal(parseEng(bad), null, bad)
})

test('显示按工程前缀，三到四位有效数字', () => {
  assert.equal(formatEng(2.44e9), '2.44 G')
  assert.equal(formatEng(500e3), '500 k')
  assert.equal(formatEng(-70), '-70')
  assert.equal(formatEng(0), '0')
})

test('往返：显示再解析回原值（同量级内）', () => {
  for (const v of [2.44e9, 500e3, 1e6, 20e6]) {
    const back = parseEng(formatEng(v).replace(' ', ''))
    assert.equal(back, v, String(v))
  }
})

test('节点摘要取最能说明用途的一两项，带单位', () => {
  const unit = (k: string) => ({ center_frequency_Hz: 'Hz', level_dBm: 'dBm' } as Record<string, string>)[k]
  assert.deepEqual(summarize({ center_frequency_Hz: 2.4405e9, level_dBm: -70 }, unit), ['2.44 G Hz', '-70 dBm'])
  assert.deepEqual(summarize({ data_id: 'dronerfb_0_CH0_S4' }, unit), ['dronerfb_0_CH0_S4'])
  assert.deepEqual(summarize({}, unit), [])
})

test('formatEngExact：输入框用的工程计数法能无损往返（formatEng 三位有效数字只给摘要看）', () => {
  for (const v of [1024, 8192, 65536, 48828.125, 2440500000, 500000, 1e-3, 6.1e-6, -20, 0.45, 20260907, 1.5]) {
    assert.equal(parseEng(formatEngExact(v)), v, `${v} → ${formatEngExact(v)}`)
  }
  assert.equal(formatEngExact(1024), '1.024 k')
  assert.equal(formatEngExact(2440500000), '2.4405 G')
  assert.equal(formatEngExact(0), '0')
})

test('plainNum：无量纲量不套工程词头（整数原样、小数去尾随零）', () => {
  // 这两个是实际踩到的：套上词头后虚警率读成「1 m」（米），FFT 点数读成「1.02 k」（丢了 1024 这个数本身）
  assert.equal(plainNum(0.001), '0.001')
  assert.equal(plainNum(1024), '1024')
  assert.equal(plainNum(8192), '8192')
  assert.equal(plainNum(0.5), '0.5')
  assert.equal(plainNum(1.0), '1')
  assert.equal(plainNum(0.1 + 0.2), '0.3')   // 十位有效数字吃掉浮点噪声
  assert.equal(plainNum(NaN), 'NaN')
})
