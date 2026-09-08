// 典型链路编译与反解的单测（C-7，D-051）。
//
// 对着**真目录**（tests/golden/component-catalog.json）与**真场景**（demo-01）跑：
// 编译出的框图必须是引擎认得的那一份，用桩数据测这层没有意义。
// 引擎那侧是否真的接受，由 tests/e2e/slice4-smoke.mjs 提交一次来证。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { Catalog } from '../api/catalog.js'
import { serialize, parse as parseDoc, type DiagramDoc } from '../diagram/doc.js'
import type { ScenarioDoc } from '../state/types.js'
import { compile, parseChain, switchMode } from './compile.js'
import { emptyChain, missingParams, slotState, SLOTS, TAP_ORDER, type ChainState } from './model.js'
import { freqPlan, planChecks, planOk } from './plan.js'
import { DEFAULT_CHAIN_TEXT } from './examples/default.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cat = JSON.parse(readFileSync(join(ROOT, 'tests/golden/component-catalog.json'), 'utf8')) as Catalog
const scenario = JSON.parse(
  readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json'), 'utf8'),
) as ScenarioDoc

/** demo-01 绑定齐全的全合成链。 */
function synthetic(): ChainState {
  const c = emptyChain('synthetic', 'chain-synthetic')
  c.scenario = { scenario_id: 'demo-01', sha256: 'a'.repeat(64) }
  c.siteId = 'site-1'
  c.emitterId = 'uav-1'
  c.run = { duration_s: 5, seed: 20260907 }
  c.slots.tx_ant.params = { gain_dBi: 2 }
  c.slots.rx_ant.params = { gain_dBi: 3 }
  c.slots.rx_fe.params = { nf_dB: 6, gain_dB: 20 }
  c.slots.adc.params = { full_scale_dBm: -20, bits: '14' }
  c.slots.det.params = { nfft: 1024 }
  c.taps.s1 = true
  return c
}

test('全合成：编译出的节点与连线就是九环节链（DDC / 信道化本期未实现，自动跳过）', () => {
  const r = compile(synthetic(), cat, scenario)
  const ids = r.doc.nodes.map((n) => n.id)
  assert.deepEqual(ids, ['scn', 'tx', 'tx_ant', 'ch', 'rx_ant', 'rx_fe', 'adc', 'det'])
  // 主链一路串下来，天线与信道另接场景参数帧
  const iq = r.doc.edges.filter((e) => e.to.port === 'in').map((e) => `${e.from.node}→${e.to.node}`)
  assert.deepEqual(iq, ['tx→tx_ant', 'tx_ant→ch', 'ch→rx_ant', 'rx_ant→rx_fe', 'rx_fe→adc', 'adc→det'])
  const scene = r.doc.edges.filter((e) => e.to.port === 'scene').map((e) => e.to.node)
  assert.deepEqual(scene, ['tx_ant', 'ch', 'rx_ant'])
  for (const e of r.doc.edges.filter((x) => x.to.port === 'scene')) {
    assert.equal(e.from.node, 'scn')
    assert.equal(e.from.port, 'link:uav-1')
  }
})

test('全合成：派生参数由频率计划填，用户不必填；场景带出的采样率与中心频率进节点', () => {
  const c = synthetic()
  const r = compile(c, cat, scenario)
  const tx = r.doc.nodes.find((n) => n.id === 'tx')!
  // demo-01 的站点接收机是 500 kS/s、2440.5 MHz；时长 5 s → 2500000 样点
  assert.equal(tx.params.sample_rate_Hz, 500000)
  assert.equal(tx.params.center_frequency_Hz, 2440500000)
  assert.equal(tx.params.total_samples, 2500000)
  // 恒定参数由模板给，不来自用户
  assert.equal(tx.params.emit_at_tx_power, true)
  assert.equal(r.doc.nodes.find((n) => n.id === 'ch')!.params.gain_mode, 'path_loss_only')
  assert.equal(r.doc.nodes.find((n) => n.id === 'tx_ant')!.params.role, 'tx')
  assert.equal(r.doc.nodes.find((n) => n.id === 'rx_ant')!.params.role, 'rx')
  // 检测频段由 S4 采样率派生（DDC 旁路时 S4 = 宽带）
  const det = r.doc.nodes.find((n) => n.id === 'det')!
  assert.equal(det.params.band_lo_Hz, -0.45 * 500000)
  assert.equal(det.params.band_hi_Hz, 0.45 * 500000)
})

test('全合成：S4 在 DDC 未启用时兜底落到链尾；勾了的观测点才写进框图', () => {
  const c = synthetic()
  const r = compile(c, cat, scenario)
  const ops = r.doc.observation_points ?? []
  assert.deepEqual(ops.map((o) => o.id), ['s1', 's4'])
  assert.deepEqual(ops.find((o) => o.id === 's1')!.node, 'rx_ant')
  // DDC 未实现 → S4 落在链尾的 adc 上（10 报告 §2.3 的兜底）
  assert.deepEqual(ops.find((o) => o.id === 's4')!.node, 'adc')
  for (const o of ops) assert.deepEqual(o.products, ['spectrum', 'envelope'])

  // 一个都不勾时不写 observation_points 字段
  const none = { ...c, taps: Object.fromEntries(TAP_ORDER.map((t) => [t, false])) } as ChainState
  assert.equal(compile(none, cat, scenario).doc.observation_points, undefined)
})

test('往返：compile(parseChain(doc)) 与原框图逐字节相同（三种模式）', () => {
  const cases: ChainState[] = [
    synthetic(),
    (() => {
      const c = switchMode(emptyChain('replay', 'chain-replay'), 'replay')
      c.slots.tx.params = { data_id: 'dronerfb_0_CH0_S4' }
      c.slots.det.params = { nfft: 1024, band_lo_Hz: -1e5, band_hi_Hz: 1e5 }
      c.run = { duration_s: 0.05, seed: 1 }
      return c
    })(),
    (() => {
      const c = switchMode(synthetic(), 'mixed')
      c.diagram_id = 'chain-mixed'
      c.backgroundDataId = 'dronerfb_0_CH0_S4'
      return c
    })(),
  ]
  for (const c of cases) {
    const once = serialize(compile(c, cat, scenario).doc, cat)
    const back = parseDoc(once)
    assert.equal(back.ok, true, c.diagram_id)
    if (!back.ok) continue
    const chain2 = parseChain(back.doc)
    assert.ok(chain2, `${c.diagram_id} 应能反解`)
    const twice = serialize(compile(chain2!, cat, scenario).doc, cat)
    assert.equal(twice, once, `${c.diagram_id} 往返应逐字节相同`)
  }
})

test('反解：不是本模板的框图一律返回 null，不勉强对应', () => {
  const slice1 = readFileSync(join(ROOT, 'engine/tests/diagrams/slice1_tone_noise_psd.json'), 'utf8')
  const r = parseDoc(slice1)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(parseChain(r.doc), null, '没有 template_ref 的框图解不开')

  // template_ref 对但节点被改过（用户在自由画布里加了东西）
  const c = synthetic()
  const doc = compile(c, cat, scenario).doc
  const tampered: DiagramDoc = { ...doc, nodes: [...doc.nodes, { id: 'extra', type: 'ToneSource', params: {} }] }
  assert.equal(parseChain(tampered), null)

  // 版本不符
  const oldVer: DiagramDoc = { ...doc, template_ref: { template_id: 'chain-v1', mode: 'synthetic', version: 99 } }
  assert.equal(parseChain(oldVer), null)
})

test('模式切换：保留已填参数，只改变体与不适用状态；混合模式关掉前端噪声', () => {
  const c = synthetic()
  const m = switchMode(c, 'mixed')
  assert.equal(m.slots.rx_ant.params.gain_dBi, 3, '已填参数应保留')
  assert.equal(m.slots.rx_fe.params.noise_mode, 'none', '背景自带噪声，不再注入')
  const rp = switchMode(c, 'replay')
  assert.equal(rp.scenario, null, '回放模式没有场景绑定')
  // 回放模式下六个前端环节不适用
  for (const id of ['tx_ant', 'ch', 'rx_ant', 'rx_fe', 'adc', 'ddc'] as const) {
    assert.equal(slotState(rp, id, cat), 'not_applicable', id)
  }
  assert.equal(slotState(rp, 'det', cat), 'active')
})

test('槽位状态：未实现的组件标 unavailable，可旁路的标 bypass', () => {
  const c = synthetic()
  // DDC 与 Channelizer 还没进目录（待 M-2 / M-3）
  assert.equal(slotState(c, 'ddc', cat), 'unavailable')
  assert.equal(slotState(c, 'chan', cat), 'unavailable')
  // 已实现且没旁路的是 active
  for (const id of ['tx', 'tx_ant', 'ch', 'rx_ant', 'rx_fe', 'adc', 'det'] as const) {
    assert.equal(slotState(c, id, cat), 'active', id)
  }
  // 目录为 null 时不判断可用性（还没拿到目录，不能说人家没实现）
  assert.notEqual(slotState(c, 'ddc', null), 'unavailable')
})

test('必填检查：派生参数与恒定参数不算「待填」', () => {
  const c = synthetic()
  for (const d of SLOTS) {
    if (slotState(c, d.id, cat) !== 'active') continue
    assert.deepEqual(missingParams(c, d.id, cat), [], `${d.id} 不应有待填项`)
  }
  // 去掉一个真的必填项就要报出来
  const bad = { ...c, slots: { ...c.slots, rx_fe: { ...c.slots.rx_fe, params: {} } } }
  assert.deepEqual(missingParams(bad, 'rx_fe', cat), ['nf_dB'])
})

test('频率计划：demo-01 的派生量与六项检查', () => {
  const c = synthetic()
  const p = freqPlan(c, scenario)
  assert.equal(p.fs_rf, 500000)
  assert.equal(p.f_rx, 2440500000)
  assert.equal(p.f_tx, 2440500000)
  assert.equal(p.bw_tx, 400000)
  assert.equal(p.decim, 1, 'DDC 旁路时抽取比为 1')
  assert.equal(p.fs_s4, 500000)

  const checks = planChecks(c, p)
  // demo-01 的带宽 400 kHz + 保护带 25 kHz ≤ 500 kHz
  assert.equal(p.guard, 25000)
  assert.equal(checks.find((x) => x.id === 'bandwidth')!.ok, true)
  assert.equal(checks.find((x) => x.id === 'edge')!.ok, true)
  assert.equal(planOk(checks), true)

  // 把带宽推到超采样率：第一项必须报出来
  const wide = JSON.parse(JSON.stringify(scenario)) as ScenarioDoc
  ;((wide.emitters as Array<Record<string, unknown>>)[0]!.emission as Record<string, unknown>).bw_Hz = 900000
  const c2 = planChecks(c, freqPlan(c, wide))
  assert.equal(c2.find((x) => x.id === 'bandwidth')!.ok, false)
  assert.equal(planOk(c2), false)
})

test('回放模式：编译出的框图只有回放源与检测，没有场景引用', () => {
  const c = switchMode(emptyChain('replay', 'chain-replay'), 'replay')
  c.slots.tx.params = { data_id: 'dronerfb_0_CH0_S4' }
  const r = compile(c, cat, scenario)
  assert.deepEqual(r.doc.nodes.map((n) => n.id), ['tx', 'det'])
  assert.equal(r.doc.nodes[0]!.type, 'FileReplaySource')
  assert.equal(r.doc.scenario_ref, undefined)
  assert.equal(r.doc.template_ref!.mode, 'replay')
  // 回放模式没有场景可派生频段：**不覆盖用户填的值**，也不拿 0 顶替（铁律 15）
  assert.equal(r.doc.nodes.find((n) => n.id === 'det')!.params.band_lo_Hz, undefined)
  assert.deepEqual(missingParams(c, 'det', cat, []), ['band_lo_Hz', 'band_hi_Hz'])

  // 用户自己给了频段就照用
  const c2 = { ...c, slots: { ...c.slots, det: { ...c.slots.det, params: { band_lo_Hz: -1e5, band_hi_Hz: 1e5 } } } }
  const r2 = compile(c2, cat, scenario)
  assert.equal(r2.doc.nodes.find((n) => n.id === 'det')!.params.band_lo_Hz, -1e5)
})

test('混合增强：背景回放在链尾与合成目标相加，S4 落在混合之后', () => {
  const c = switchMode(synthetic(), 'mixed')
  c.backgroundDataId = 'dronerfb_0_CH0_S4'
  const r = compile(c, cat, scenario)
  const ids = r.doc.nodes.map((n) => n.id)
  assert.ok(ids.includes('bg') && ids.includes('mix'))
  const toMix = r.doc.edges.filter((e) => e.to.node === 'mix')
  assert.deepEqual(toMix.map((e) => `${e.from.node}.${e.to.port}`), ['adc.a', 'bg.b'])
  assert.equal((r.doc.observation_points ?? []).find((o) => o.id === 's4')!.node, 'mix')
  // 检测接在混合之后
  assert.equal(r.doc.edges.find((e) => e.to.node === 'det')!.from.node, 'mix')
})

test('节点到槽位的反查表覆盖每个节点：引擎报错才能高亮到卡片', () => {
  const r = compile(switchMode(synthetic(), 'mixed'), cat, scenario)
  for (const n of r.doc.nodes) {
    assert.ok(r.nodeSlot[n.id], `节点 ${n.id} 应能反查到槽位`)
  }
})

test('内置缺省链路：解得开、重新编译后逐字节相同、六项检查全过', () => {
  const r = parseDoc(DEFAULT_CHAIN_TEXT)
  assert.equal(r.ok, true)
  if (!r.ok) return
  const chain = parseChain(r.doc)
  assert.ok(chain, '内置缺省应能被 parseChain 解开')
  // 重新编译后逐字节相同：生成器与运行时用的是同一套代码，改一边另一边必须跟着变
  assert.equal(serialize(compile(chain!, cat, scenario).doc, cat), DEFAULT_CHAIN_TEXT)

  const checks = planChecks(chain!, freqPlan(chain!, scenario))
  for (const k of checks) assert.equal(k.ok, true, `${k.label}：${k.detail}`)
})

test('ADC 量化噪声检查：不给接收机增益就拦下来（实测逼出来的那一条）', () => {
  const r = parseDoc(DEFAULT_CHAIN_TEXT)
  assert.equal(r.ok, true)
  if (!r.ok) return
  const chain = parseChain(r.doc)!
  // 缺省有 20 dB 增益：过
  const withGain = planChecks(chain, freqPlan(chain, scenario)).find((k) => k.id === 'adc_floor')!
  assert.equal(withGain.ok, true)
  assert.match(withGain.detail, /余量 15\.0 dB/)

  // 去掉增益：−111 dBm 的热噪声落到 −20 dBm 满量程、14 位 ADC 的最低有效位之下
  const noGain: ChainState = {
    ...chain,
    slots: { ...chain.slots, rx_fe: { ...chain.slots.rx_fe, params: { nf_dB: 6 } } },
  }
  const k = planChecks(noGain, freqPlan(noGain, scenario)).find((x) => x.id === 'adc_floor')!
  assert.equal(k.ok, false)
  assert.match(k.detail, /加大接收机增益/)
})
