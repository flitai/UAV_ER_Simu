// presets.ts 是机型预设表规格在浏览器一侧的副本，这份单测把它钉在真理源上（Q-2，D-088）：
// 直接读 models/radiator/presets-v1.json 与 fir_rsmp_v1.json 逐项对拍（同 firSpecs.test.ts 的办法）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { RADIATOR_PRESETS, RSMP_DECIM, RSMP_INTERP, isOfdmFamily, presetById, presetsOfType, rsmpAllowedFs, rsmpDecimFor } from './presets.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const json = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))

test('预设副本与 models/radiator/presets-v1.json 逐项相同（顺序、类型、标签、名、原生采样率、占用带宽）', () => {
  const doc = json('models/radiator/presets-v1.json')
  const nums = new Map<string, { fs_native_Hz: number }>(doc.numerologies.map((n: { id: string; fs_native_Hz: number }) => [n.id, n]))
  assert.equal(RADIATOR_PRESETS.length, doc.presets.length)
  doc.presets.forEach((p: Record<string, unknown>, i: number) => {
    const c = RADIATOR_PRESETS[i]!
    assert.equal(c.id, p.id)
    assert.equal(c.type, p.type)
    assert.equal(c.role, p.role)
    assert.equal(c.name, p.name)
    assert.equal(c.fs_native_Hz, nums.get(String(p.numerology))!.fs_native_Hz)
    assert.equal(c.occupied_bw_Hz, p.occupied_bw_Hz)
  })
})

test('重采样档位与冻结表 fir_rsmp_v1.json 相同', () => {
  const t = json('models/radiator/fir_rsmp_v1.json')
  assert.equal(RSMP_INTERP, t.spec.interp_L)
  assert.deepEqual([...RSMP_DECIM], t.spec.decim_M_supported)
})

test('可取采样率：15.36 MS/s 原生取 20 / 40 / 80 MS/s，30.72 取 40 / 80（与 geo 报文同一组数）', () => {
  assert.deepEqual(rsmpAllowedFs(presetById('dji-video-10m')!), [20e6, 40e6, 80e6])
  assert.deepEqual(rsmpAllowedFs(presetById('dji-video-20m-a')!), [40e6, 80e6, 160e6])
  assert.equal(rsmpDecimFor(presetById('dji-video-20m-a')!, 80e6), 48)
  assert.equal(rsmpDecimFor(presetById('dji-droneid')!, 10e6), 0)
})

test('类型判断与按类型列预设', () => {
  assert.ok(isOfdmFamily('ofdm') && isOfdmFamily('droneid') && !isOfdmFamily('burst'))
  assert.deepEqual(presetsOfType('droneid').map((p) => p.id), ['dji-droneid'])
  assert.ok(presetsOfType('ofdm').every((p) => p.type === 'ofdm'))
})
