// firSpecs.ts 是冻结抽头表规格在浏览器一侧的**副本**，这份单测是把它钉在真理源上的那道闸：
// 直接读 `models/**/fir_*.json`（设计脚本冻结的那三份）逐项对拍。
// 改了表却忘了改副本（或反过来）在这里当场红——与引擎侧 `*_taps.cpp` 的逐位核对同一套办法（铁律 10）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { FIR_SPECS, firSpec, passbandEdgeHz, onGrid, gridText } from './firSpecs.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const table = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as {
  version: string
  spec: Record<string, unknown>
  entries: Array<Record<string, number>>
}

const SOURCES: Array<{ rel: string; version: string; key: string }> = [
  { rel: 'models/adc-ddc/fir_lp_v1.json', version: 'lp_v1', key: 'decim' },
  { rel: 'models/channelizer/fir_pfb_v1.json', version: 'pfb_v1', key: 'channels' },
  { rel: 'models/receiver/fir_rx_v1.json', version: 'rx_v1', key: 'bw_rel' },
]

test('三份冻结表都有对应的规格副本，版本号对得上', () => {
  for (const s of SOURCES) {
    const doc = table(s.rel)
    assert.equal(doc.version, s.version, s.rel)
    assert.ok(firSpec(s.version), `${s.version} 没有副本`)
  }
  // 反过来也要成立：副本里不许有真理源里没有的版本
  assert.deepEqual(Object.keys(FIR_SPECS).sort(), SOURCES.map((s) => s.version).sort())
})

test('档位表与冻结表的条目逐项相同（顺序与取值都比）', () => {
  for (const s of SOURCES) {
    const doc = table(s.rel)
    const want = doc.entries.map((e) => e[s.key]!)
    assert.deepEqual(FIR_SPECS[s.version]!.grid, want, `${s.version} 的档位表与 ${s.rel} 对不上`)
  }
})

test('通带与阻带边缘取自冻结表的 spec，不是手写的常数', () => {
  for (const s of SOURCES) {
    const doc = table(s.rel)
    const spec = FIR_SPECS[s.version]!
    const pb = doc.spec.passband_edge_rel_out
    const sb = doc.spec.stopband_edge_rel_out
    assert.equal(spec.passbandEdgeRelOut, typeof pb === 'number' ? pb : null, `${s.version} 通带边缘`)
    assert.equal(spec.stopbandEdgeRelOut, typeof sb === 'number' ? sb : null, `${s.version} 阻带边缘`)
    const tr = doc.spec.transition_rel_fs
    assert.equal(spec.transitionRelFs, typeof tr === 'number' ? tr : null, `${s.version} 过渡带`)
  }
})

test('通带边缘按输出采样率算；不认识的版本返回 null 而不是编一个数', () => {
  assert.equal(passbandEdgeHz('lp_v1', 5e6), 2e6)
  assert.equal(passbandEdgeHz('pfb_v1', 2.5e6), 1e6)
  assert.equal(passbandEdgeHz('rx_v1', 1e7), null, '接收滤波的通带由 bw_Hz 自己定')
  assert.equal(passbandEdgeHz('nope', 1e7), null)
  assert.equal(passbandEdgeHz('lp_v1', 0), null, '没有采样率就算不出')
})

test('档位判定不做「取最近一档」，只吃十进制表示误差', () => {
  assert.equal(onGrid('pfb_v1', 8), true)
  assert.equal(onGrid('pfb_v1', 6), false, '6 不在表里就是不在，不许靠到 8')
  assert.equal(onGrid('lp_v1', 20), true)
  assert.equal(onGrid('lp_v1', 3), false)
  // bw_rel 是十进制小数，0.3 在二进制里不精确，判定必须吃得下这点误差
  assert.equal(onGrid('rx_v1', 0.1 + 0.2), true)
  assert.equal(onGrid('rx_v1', 0.35), false)
  assert.equal(onGrid('nope', 8), false)
  assert.equal(gridText('pfb_v1'), '2 / 4 / 8 / 16 / 32 / 64')
})
