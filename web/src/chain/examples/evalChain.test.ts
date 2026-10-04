// 评测数据集链路生成器的单测（试样集步骤 3，D-092）。对着真目录与真场景（golden-01）跑。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { Catalog } from '../../api/catalog.js'
import { parse as parseDoc } from '../../diagram/doc.js'
import type { ScenarioDoc } from '../../state/types.js'
import { buildEvalChain, EvalChainError, type EvalChainSpec } from './evalChain.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const cat = JSON.parse(readFileSync(join(ROOT, 'tests/golden/component-catalog.json'), 'utf8')) as Catalog
const scenario = JSON.parse(
  readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/scenarios/golden-01.scenario.json'), 'utf8'),
) as ScenarioDoc

function spec(over: Partial<EvalChainSpec> = {}): EvalChainSpec {
  return {
    schema_version: 'cuav-eval-chain/1', diagram_id: 'eval-test', name: '评测链路单测',
    scenario: 'data/scene/beijing-yayuncun/scenarios/golden-01.scenario.json',
    run: { duration_s: 1, seed: 7 },
    // golden-01 是 500 kS/s、400 kHz 占用：抽取 2 后通带边缘 100 kHz，「滤波器过渡带足够」必然不通过
    slots: { rx_fe: { gain_dB: 20 }, adc: { full_scale_dBm: -20 }, ddc: { decim: 2, f_shift_Hz: 0 }, det: { nfft: 1024 } },
    taps: ['s3', 's4'], iq: ['s3', 's4'],
    plan_allow: ['transition'],
    ...over,
  }
}

test('按规格编译：观测点开原始 IQ、DDC 启用、往返逐字节相同（D-092）', () => {
  const r = buildEvalChain(spec(), scenario, 'a'.repeat(64), cat, null)
  assert.deepEqual(r.failing, ['transition'])
  const p = parseDoc(r.text)
  assert.equal(p.ok, true)
  if (!p.ok) return
  const ops = Object.fromEntries((p.doc.observation_points ?? []).map((o) => [o.id, o.products]))
  assert.deepEqual(ops.s3, ['spectrum', 'envelope', 'iq'])
  assert.deepEqual(ops.s4, ['spectrum', 'envelope', 'iq'])
  const ddc = p.doc.nodes.find((n) => n.type === 'DDC')
  assert.ok(ddc, 'DDC 节点在链上')
  assert.equal(ddc!.params?.decim, 2)
})

test('放行表必须恰好等于没通过的检查项：少一项、多一项都报错', () => {
  assert.throws(() => buildEvalChain(spec({ plan_allow: [] }), scenario, 'a'.repeat(64), cat, null),
    (e: unknown) => e instanceof EvalChainError && /不在放行表里：transition/.test(e.message))
  assert.throws(() => buildEvalChain(spec({ plan_allow: ['transition', 'edge'] }), scenario, 'a'.repeat(64), cat, null),
    (e: unknown) => e instanceof EvalChainError && /其实通过了.*edge/.test(e.message))
})

test('白名单外的槽位与 S0 原始 IQ 都拒', () => {
  assert.throws(() => buildEvalChain(spec({ slots: { tx: { gain_dBi: 2 } } }), scenario, 'a'.repeat(64), cat, null),
    /不能改槽位 tx/)
  assert.throws(() => buildEvalChain(spec({ taps: ['s0', 's3'], iq: ['s0'] }), scenario, 'a'.repeat(64), cat, null),
    /只能开在 S3–S5/)
})
