import { test } from 'node:test'
import assert from 'node:assert/strict'
import { csvFromWindow, exportFilename } from './export.js'

test('exportFilename 含 task、op、时间窗，非法字符替换', () => {
  assert.equal(exportFilename('csv', 't20260906-1', 's4', 0.4, 1.6), 't20260906-1_s4_0.400s-1.600s.csv')
  assert.equal(exportFilename('png', 'a b/c', 'op:1', 0, 2), 'a_b_c_op_1_0.000s-2.000s.png')
})

test('csvFromWindow：行数 = rows + 1（+ 注释行），列头为列中心绝对频率，包络另起一段', () => {
  const spec = { data: new Float32Array([-100, -90, -80, -70]), rows: 2, cols: 2, t0: 0.5, t1: 0.7, f0: -1000, f1: 1000 }
  const env = { data: new Float32Array([0.1, 1, 0.5, 0, 0, 0]), rows: 2, cols: 3, t0: 0.5, t1: 0.7, f0: null, f1: null }
  const text = csvFromWindow(spec, env, { center_Hz: 2.44e9, t0_s: 1 }, 'dBm', 0.1)
  const lines = text.trimEnd().split('\n')
  assert.equal(lines[1], 't_s,2439999500,2440000500')
  assert.equal(lines[2], '1.5,-100,-90')
  assert.equal(lines[3], '1.6,-80,-70')
  assert.equal(lines[4], '')
  assert.equal(lines[6], 't_s,min_dB,max_dB,rms_dB')
  const e7 = lines[7]!.split(',').map(Number)
  assert.equal(e7[0], 1.5); assert.ok(Math.abs(e7[1]! + 20) < 1e-5); assert.equal(e7[2], 0); assert.ok(Math.abs(e7[3]! + 6.0206) < 1e-3)
  assert.equal(lines[8], '1.6,-300,-300,-300')
  const only = csvFromWindow(spec, null, { center_Hz: 0, t0_s: 0 }, 'dBFS')
  assert.equal(only.trimEnd().split('\n').length, 4)
})
