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
import { compile, nodeId, parseChain, splitNodeId, switchMode } from './compile.js'
import { emptyChain, missingParams, PROPAGATION_PARAMS, retiredNote, slotState, SLOTS, SLOT_BY_ID, TAP_ORDER, tapLabel, type ChainState } from './model.js'
import { propConflict, propView, visiblePropParams } from './effects.js'
import { freqPlan, planChecks, planOk } from './plan.js'
import { DEFAULT_CHAIN_TEXT } from './examples/default.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const cat = JSON.parse(readFileSync(join(ROOT, 'tests/golden/component-catalog.json'), 'utf8')) as Catalog
const scenario = JSON.parse(
  readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/scenarios/demo-01.scenario.json'), 'utf8'),
) as ScenarioDoc
/** 三站三源，多站用例用它——demo-01 只有一个站，拿它测多站等于测了个假的。 */
const scenario3 = JSON.parse(
  readFileSync(join(ROOT, 'data/scene/beijing-yayuncun/scenarios/demo-03.scenario.json'), 'utf8'),
) as ScenarioDoc

/** 解一份必定合法的框图文本，省掉每处都写 if (!r.ok)。 */
function parseOk(text: string): DiagramDoc {
  const r = parseDoc(text)
  assert.equal(r.ok, true)
  if (!r.ok) throw new Error('unreachable')
  return r.doc
}

/** demo-03 上的全合成链，可指定选几个站几个源。 */
function multi(siteIds: string[], emitterIds: string[]): ChainState {
  const c = synthetic()
  c.diagram_id = 'chain-multi'
  c.scenario = { scenario_id: 'demo-03', sha256: 'b'.repeat(64) }
  c.siteIds = siteIds
  c.emitterIds = emitterIds
  return c
}

/** demo-01 绑定齐全的全合成链。 */
function synthetic(): ChainState {
  const c = emptyChain('synthetic', 'chain-synthetic')
  c.scenario = { scenario_id: 'demo-01', sha256: 'a'.repeat(64) }
  c.siteIds = ['site-1']
  c.emitterIds = ['uav-1']
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
  // 检测识别评价一张卡三个环节（C-4）：检测之后跟着特征提取与模板识别
  assert.deepEqual(ids, ['scn', 'tx', 'tx_ant', 'ch', 'rx_ant', 'rx_fe', 'adc', 'det', 'feat', 'rec', 'eval'])
  // 主链一路串下来，天线与信道另接场景参数帧；识别接特征输出
  const iq = r.doc.edges.filter((e) => e.to.port === 'in').map((e) => `${e.from.node}→${e.to.node}`)
  assert.deepEqual(iq, ['tx→tx_ant', 'tx_ant→ch', 'ch→rx_ant', 'rx_ant→rx_fe', 'rx_fe→adc', 'adc→det', 'feat→rec'])
  // 特征提取的 iq 口接检测器的同一上游（S4 尾），det 口接检测器输出
  const feat = r.doc.edges.filter((e) => e.to.node === 'feat').map((e) => `${e.from.node}→${e.to.port}`)
  assert.deepEqual(feat, ['adc→iq', 'det→det'])
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
  // 典型链路的检测器模板固定滑动噪声估计、按站绑定场景（D-063）：
  // noise_mode 与目录缺省 probe 不同，所以一定写进框图；绑站只为给检测行注入 site_id
  assert.equal(det.params.noise_mode, 'sliding')
  assert.deepEqual(det.scene_binding, { scenario_id: 'demo-01', site_id: 'site-1' })
  // 反解不把模板固定值回写进用户状态，往返仍逐字节
  const back = parseChain(r.doc)!
  assert.equal(back.slots.det.params.noise_mode, undefined)
  assert.equal(serialize(compile(back, cat, scenario).doc, cat), serialize(r.doc, cat))
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

test('槽位状态：不在目录里的组件标 unavailable，可旁路的标 bypass', () => {
  const c = synthetic()
  // DDC（M-2，D-070）与信道化（M-3，D-071）都已进目录，两个槽位都缺省旁路
  assert.equal(slotState(c, 'ddc', cat), 'bypass')
  assert.equal(slotState(c, 'chan', cat), 'bypass')
  // 取消勾选旁路就活了——这是看到 DDC 与信道化工作的入口
  const on = { ...c, slots: { ...c.slots, ddc: { ...c.slots.ddc, bypass: false } } }
  assert.equal(slotState(on, 'ddc', cat), 'active')
  const onChan = { ...c, slots: { ...c.slots, chan: { ...c.slots.chan, bypass: false } } }
  assert.equal(slotState(onChan, 'chan', cat), 'active')
  // 目录里真没有的组件才是 unavailable——把信道化从目录里拿掉当场就能看出来
  const catNoChan = { ...cat, components: cat.components.filter((x) => x.type !== 'Channelizer') }
  assert.equal(slotState(onChan, 'chan', catNoChan), 'unavailable')
  // 已实现且没旁路的是 active
  for (const id of ['tx', 'tx_ant', 'ch', 'rx_ant', 'rx_fe', 'adc', 'det'] as const) {
    assert.equal(slotState(c, id, cat), 'active', id)
  }
  // 目录为 null 时不判断可用性（还没拿到目录，不能说人家没实现）
  assert.notEqual(slotState(c, 'chan', null), 'unavailable')
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

test('频率计划的 DDC 判据与 compile 同源：不在目录 / 旁路 / 回放都算没参与（M-2，D-070）', () => {
  // 这条以前是红的：freqPlan 只看 bypass，于是「组件不在目录里但用户填过 decim」时会算出一个
  // 根本不存在的 fs_s4，而 compile 又拿它派生检测器频段（±0.45·fs_s4），频段被凭空收窄。
  const withDecim = (base: ChainState): ChainState =>
    ({ ...base, slots: { ...base.slots, ddc: { ...base.slots.ddc, bypass: false, params: { decim: 4 } } } })

  const noDdc: Catalog = { ...cat, components: cat.components.filter((x) => x.type !== 'DDC') }
  const a = freqPlan(withDecim(synthetic()), scenario, noDdc)
  assert.equal(a.decim, 1, '组件不在目录里就不该算抽取')
  assert.equal(a.fs_s4, a.fs_rf)

  const b = freqPlan(synthetic(), scenario, cat)
  assert.equal(b.decim, 1, '缺省旁路时抽取比为 1')

  const c3 = freqPlan(withDecim(synthetic()), scenario, cat)
  assert.equal(c3.decim, 4, '目录里有且没旁路时才真的抽取')
  assert.equal(c3.fs_s4, c3.fs_rf / 4)

  // 回放模式下 DDC 不适用（replayNotApplicable），即使 bypass 为 false 也不该算
  const rp: ChainState = { ...emptyChain('replay'), slots: { ...emptyChain('replay').slots } }
  const rp2 = { ...rp, slots: { ...rp.slots, ddc: { ...rp.slots.ddc, bypass: false, params: { decim: 8 } } } }
  assert.equal(freqPlan(rp2, null, cat).decim, 1, '回放模式下 DDC 不适用')

  // cat 省略时退回老行为，不影响既有调用点
  assert.equal(freqPlan(withDecim(synthetic()), scenario).decim, 4)
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

  const checks = planChecks(c, p, scenario)
  // demo-01 的带宽 400 kHz + 保护带 25 kHz ≤ 500 kHz
  assert.equal(p.guard, 25000)
  assert.equal(checks.find((x) => x.id === 'bandwidth')!.ok, true)
  assert.equal(checks.find((x) => x.id === 'edge')!.ok, true)
  assert.equal(planOk(checks), true)

  // 把带宽推到超采样率：第一项必须报出来
  const wide = JSON.parse(JSON.stringify(scenario)) as ScenarioDoc
  ;((wide.emitters as Array<Record<string, unknown>>)[0]!.emission as Record<string, unknown>).bw_Hz = 900000
  const c2 = planChecks(c, freqPlan(c, wide), wide)
  assert.equal(c2.find((x) => x.id === 'bandwidth')!.ok, false)
  assert.equal(planOk(c2), false)
})

test('回放模式：编译出的框图只有回放源与检测，没有场景引用', () => {
  const c = switchMode(emptyChain('replay', 'chain-replay'), 'replay')
  c.slots.tx.params = { data_id: 'dronerfb_0_CH0_S4' }
  const r = compile(c, cat, scenario)
  assert.deepEqual(r.doc.nodes.map((n) => n.id), ['tx', 'det', 'feat', 'rec', 'eval'])
  assert.equal(r.doc.nodes[0]!.type, 'FileReplaySource')
  assert.equal(r.doc.scenario_ref, undefined)
  // 没有场景就没有绑定：检测行将不带 site_id（D-063），模板固定的 noise_mode 照写
  assert.equal(r.doc.nodes[1]!.scene_binding, undefined)
  assert.equal(r.doc.nodes[1]!.params.noise_mode, 'sliding')
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

  const checks = planChecks(chain!, freqPlan(chain!, scenario), scenario)
  for (const k of checks) assert.equal(k.ok, true, `${k.label}：${k.detail}`)
})

test('ADC 量化噪声检查：不给接收机增益就拦下来（实测逼出来的那一条）', () => {
  const r = parseDoc(DEFAULT_CHAIN_TEXT)
  assert.equal(r.ok, true)
  if (!r.ok) return
  const chain = parseChain(r.doc)!
  // 缺省有 20 dB 增益：过
  // 噪声系数自 D-054 起由场景逐站带出，这条检查因此必须拿到场景才算得对
  const withGain = planChecks(chain, freqPlan(chain, scenario), scenario).find((k) => k.id === 'adc_floor')!
  assert.equal(withGain.ok, true)
  assert.match(withGain.detail, /余量 15\.0 dB/)

  // 去掉增益：−111 dBm 的热噪声落到 −20 dBm 满量程、14 位 ADC 的最低有效位之下
  const noGain: ChainState = {
    ...chain,
    slots: { ...chain.slots, rx_fe: { ...chain.slots.rx_fe, params: {} } },
  }
  const k = planChecks(noGain, freqPlan(noGain, scenario), scenario).find((x) => x.id === 'adc_floor')!
  assert.equal(k.ok, false)
  assert.match(k.detail, /加大接收机增益/)
})

// ------------------------------------------------------------ 多源 / 多站实例化（L-2，D-053）

test('实例 id：只有取值多于一个的维度才加后缀，N = K = 1 时一个后缀都不出现', () => {
  assert.equal(nodeId('ch', { id: 'uav-1', many: false }, { id: 'site-1', many: false }), 'ch')
  assert.equal(nodeId('ch', { id: 'uav-1', many: true }, { id: 'site-1', many: false }), 'ch__uav-1')
  assert.equal(nodeId('ch', { id: 'uav-1', many: false }, { id: 'site-1', many: true }), 'ch__site-1')
  assert.equal(nodeId('ch', { id: 'uav-1', many: true }, { id: 'site-1', many: true }), 'ch__uav-1__site-1')
})

test('splitNodeId：按已知基名切分，tx 与 tx_ant 不会混', () => {
  assert.deepEqual(splitNodeId('tx'), { base: 'tx', rest: '' })
  assert.deepEqual(splitNodeId('tx__uav-1'), { base: 'tx', rest: 'uav-1' })
  assert.deepEqual(splitNodeId('tx_ant'), { base: 'tx_ant', rest: '' })
  assert.deepEqual(splitNodeId('tx_ant__uav-1__site-2'), { base: 'tx_ant', rest: 'uav-1__site-2' })
  assert.deepEqual(splitNodeId('sup__site-1'), { base: 'sup', rest: 'site-1' })
  assert.equal(splitNodeId('user_block_7'), null)
})

test('多源：前四环节按源分支，接收天线后叠加成一路（11 报告 §2.2）', () => {
  const r = compile(multi(['site-1'], ['uav-1', 'uav-2']), cat, scenario3)
  const ids = r.doc.nodes.map((n) => n.id)
  assert.deepEqual(ids, [
    'scn',
    'tx__uav-1', 'tx__uav-2',
    'tx_ant__uav-1', 'ch__uav-1', 'rx_ant__uav-1',
    'tx_ant__uav-2', 'ch__uav-2', 'rx_ant__uav-2',
    'sup', 'rx_fe', 'adc', 'det', 'feat', 'rec', 'eval',
  ])
  // 两条支路各自进叠加，此后只有一路
  const toSup = r.doc.edges.filter((e) => e.to.node === 'sup').map((e) => `${e.from.node}→${e.to.port}`)
  assert.deepEqual(toSup, ['rx_ant__uav-1→in1', 'rx_ant__uav-2→in2'])
  const iq = r.doc.edges.filter((e) => e.to.port === 'in').map((e) => `${e.from.node}→${e.to.node}`)
  assert.ok(iq.includes('sup→rx_fe'))
  assert.ok(iq.includes('rx_fe→adc'))
  // 每条链路各取自己那个源的参数帧
  const scene = r.doc.edges.filter((e) => e.to.port === 'scene')
  assert.equal(scene.length, 6)
  for (const e of scene) {
    assert.equal(e.from.node, 'scn')
    assert.equal(e.from.port, e.to.node.endsWith('uav-1') ? 'link:uav-1' : 'link:uav-2')
  }
})

test('多源：S1 挂在叠加之后——接收机看到的就是各源之和', () => {
  const c = multi(['site-1'], ['uav-1', 'uav-2'])
  c.taps.s1 = true
  c.taps.s0 = true
  const r = compile(c, cat, scenario3)
  const ops = (r.doc.observation_points ?? []).map((o) => `${o.id}@${o.node}`)
  // S0 在辐射源上，按**源**实例化；S1 起按站（此处 K = 1，故无后缀）
  // S4 缺省就勾着（emptyChain），K = 1 故无后缀；DDC 未实现时兜底落在链尾
  assert.deepEqual(ops, ['s0__uav-1@tx__uav-1', 's0__uav-2@tx__uav-2', 's1@sup', 's4@adc'])
})

test('多站：接收天线之后每环节一站一份，场景参数源也一站一个且只第一个报实体', () => {
  const r = compile(multi(['site-1', 'site-2'], ['uav-1']), cat, scenario3)
  const ids = r.doc.nodes.map((n) => n.id)
  assert.deepEqual(ids, [
    'scn__site-1', 'scn__site-2',
    'tx',
    'tx_ant__site-1', 'ch__site-1', 'rx_ant__site-1', 'rx_fe__site-1', 'adc__site-1', 'det__site-1', 'feat__site-1', 'rec__site-1', 'eval__site-1',
    'tx_ant__site-2', 'ch__site-2', 'rx_ant__site-2', 'rx_fe__site-2', 'adc__site-2', 'det__site-2', 'feat__site-2', 'rec__site-2', 'eval__site-2',
  ])
  const scn = r.doc.nodes.filter((n) => n.id.startsWith('scn'))
  assert.equal(scn[0]!.params.report_entities, undefined, '第一个照常报实体（不写即缺省真）')
  assert.equal(scn[1]!.params.report_entities, false, '其余关掉，否则 track.jsonl 涨 K 倍')
  // 单源多站时不需要叠加节点
  assert.ok(!ids.includes('sup__site-1'))
  // 信道同时绑源与站：它既要知道发射功率，又要知道接收端是谁
  const ch = r.doc.nodes.find((n) => n.id === 'ch__site-1')!
  assert.deepEqual(ch.scene_binding, { scenario_id: 'demo-03', entity_id: 'uav-1', site_id: 'site-1' })
  // 辐射源只绑源：它一份波形扇出到全部站，绑站是错的（引擎也会拒，因为目录没声明 site_id）
  assert.deepEqual(r.doc.nodes.find((n) => n.id === 'tx')!.scene_binding,
    { scenario_id: 'demo-03', entity_id: 'uav-1' })
})

test('特征提取的帧长与合并空隙从检测器派生（10 §4.3），改检测器两处同步；往返逐字节（C-4）', () => {
  const c = synthetic()
  c.slots.det.params = { nfft: 512, merge_gap_frames: 3 }
  c.slots.feat.params = { nfft: 4096, noise_gate: 3 }           // 残留的旧值必须被检测器的覆盖
  c.slots.rec.params = { accept_threshold: 0.55 }
  const r = compile(c, cat, scenario)
  const feat = r.doc.nodes.find((n) => n.id === 'feat')!
  const rec = r.doc.nodes.find((n) => n.id === 'rec')!
  assert.equal(feat.type, 'FeatureExtractor')
  assert.equal(feat.params.nfft, 512)
  assert.equal(feat.params.merge_gap_frames, 3)
  assert.equal(feat.params.noise_gate, 3)
  assert.deepEqual(feat.scene_binding, { scenario_id: 'demo-01', site_id: 'site-1' })
  assert.equal(rec.type, 'TemplateClassifier')
  assert.equal(rec.params.accept_threshold, 0.55)
  assert.equal(rec.params.library_version, undefined, '缺省 v1 不写；库文件位置是内部参数，永远不进框图（D-037）')
  assert.equal(rec.params.library_path, undefined)
  // 往返逐字节：解回来再编译，一样
  const text = serialize(r.doc, cat)
  const back = parseChain(parseOk(text))!
  assert.equal(serialize(compile(back, cat, scenario).doc, cat), text)
  assert.equal(back.slots.rec.params.accept_threshold, 0.55)
  // 缺省检测器：特征提取器什么也不写（两边缺省相同）
  const d = compile(synthetic(), cat, scenario).doc.nodes.find((n) => n.id === 'feat')!
  assert.deepEqual(d.params, {})
})

test('评价器槽位：真值来源随模式、nfft 随检测器、data_id 随信号源 / 背景；rec 没编译时不连 rec 口；scene 口按源扇入；往返逐字节（C-5）', () => {
  // 全合成：scenario 真值，det / rec 都接，scene1 接本站对唯一源的链路帧，没有 data_id
  const c = synthetic()
  c.slots.det.params = { nfft: 512 }
  c.slots.eval.params = { match_overlap: 0.6, truth_source: 'none', nfft: 4096 }   // 残留的派生键必须被覆盖
  const r = compile(c, cat, scenario)
  const ev = r.doc.nodes.find((n) => n.id === 'eval')!
  assert.equal(ev.type, 'Evaluator')
  assert.deepEqual(ev.params, { match_overlap: 0.6, nfft: 512 })   // truth_source = scenario 是目录缺省，与其它缺省值一样不写
  assert.deepEqual(ev.scene_binding, { scenario_id: 'demo-01', site_id: 'site-1' })
  const into = r.doc.edges.filter((e) => e.to.node === 'eval').map((e) => `${e.from.node}.${e.from.port}>${e.to.port}`).sort()
  assert.deepEqual(into, ['det.out>det', 'rec.out>rec', 'scn.link:uav-1>scene1'])
  assert.ok(r.activeSlots.includes('eval'))
  const text = serialize(r.doc, cat)
  const back = parseChain(parseOk(text))!
  assert.equal(serialize(compile(back, cat, scenario).doc, cat), text)
  assert.equal(back.slots.eval.params.match_overlap, 0.6)

  // 三源三站：每站一个 eval__<site>，scene1..3 接本站对三个源的帧
  const m = multi(['site-1', 'site-2', 'site-3'], ['uav-1', 'uav-2', 'uav-3'])
  const rm = compile(m, cat, scenario3)
  const evs = rm.doc.nodes.filter((n) => n.type === 'Evaluator').map((n) => n.id).sort()
  assert.deepEqual(evs, ['eval__site-1', 'eval__site-2', 'eval__site-3'])
  const s2 = rm.doc.edges.filter((e) => e.to.node === 'eval__site-2').map((e) => `${e.from.node}.${e.from.port}>${e.to.port}`).sort()
  assert.deepEqual(s2, ['det__site-2.out>det', 'rec__site-2.out>rec', 'scn__site-2.link:uav-1>scene1', 'scn__site-2.link:uav-2>scene2', 'scn__site-2.link:uav-3>scene3'])

  // 回放：manifest 真值 + 信号源的录音标识，不绑站，没有 scene 口
  const rp = switchMode(synthetic(), 'replay')
  rp.slots.tx.params = { data_id: 'dronerfb_0_CH0_S4' }
  const rr = compile(rp, cat, null)
  const evr = rr.doc.nodes.find((n) => n.id === 'eval')!
  assert.equal(evr.params.truth_source, 'manifest')
  assert.equal(evr.params.data_id, 'dronerfb_0_CH0_S4')
  assert.equal(evr.scene_binding, undefined)
  assert.deepEqual(rr.doc.edges.filter((e) => e.to.node === 'eval').map((e) => e.to.port).sort(), ['det', 'rec'])

  // 混合：scenario 真值 + 背景片段的录音标识（评价器据此核对背景是否含目标）
  const mx = switchMode(synthetic(), 'mixed')
  mx.backgroundDataId = 'dronerfb_1_CH0_S4'
  const evm = compile(mx, cat, scenario).doc.nodes.find((n) => n.id === 'eval')!
  assert.equal(evm.params.truth_source, undefined)   // scenario 是缺省，不写
  assert.equal(evm.params.data_id, 'dronerfb_1_CH0_S4')

  // rec 不可用（目录里没有识别器）时不编译、也不连 rec 口（评价器把识别一栏记 not_applicable）；rec 本身不可旁路
  const catNoRec = { ...cat, components: cat.components.filter((c) => c.type !== 'TemplateClassifier') }
  const rn = compile(synthetic(), catNoRec, scenario)
  assert.equal(rn.doc.nodes.find((n) => n.id === 'rec'), undefined)
  assert.deepEqual(rn.doc.edges.filter((e) => e.to.node === 'eval').map((e) => e.to.port).sort(), ['det', 'scene1'])
})

test('多站：观测点每站各一份，产品目录名带站后缀', () => {
  const c = multi(['site-1', 'site-2'], ['uav-1'])
  c.taps.s1 = true
  c.taps.s4 = true
  const r = compile(c, cat, scenario3)
  const ops = (r.doc.observation_points ?? []).map((o) => o.id)
  assert.deepEqual(ops, ['s1__site-1', 's1__site-2', 's4__site-1', 's4__site-2'])
  assert.equal(tapLabel('s4__site-2'), 'S4 主产品 · site-2')
  assert.equal(tapLabel('s4'), 'S4 主产品')
})

test('往返：1×1 / 3×1 / 1×3 / 3×3 编译再反解都逐字节相同', () => {
  const combos: Array<[string[], string[]]> = [
    [['site-1'], ['uav-1']],
    [['site-1'], ['uav-1', 'uav-2', 'uav-3']],
    [['site-1', 'site-2', 'site-3'], ['uav-1']],
    [['site-1', 'site-2', 'site-3'], ['uav-1', 'uav-2', 'uav-3']],
  ]
  for (const [siteIds, emitterIds] of combos) {
    const single = siteIds.length === 1 && emitterIds.length === 1
    const c = single ? synthetic() : multi(siteIds, emitterIds)
    const sc = single ? scenario : scenario3
    const label = `${emitterIds.length}×${siteIds.length}`
    const once = serialize(compile(c, cat, sc).doc, cat)
    const r = parseDoc(once)
    assert.equal(r.ok, true, label)
    if (!r.ok) continue
    const back = parseChain(r.doc)
    assert.ok(back, `${label} 应解得开`)
    assert.deepEqual(back!.siteIds, siteIds)
    assert.deepEqual(back!.emitterIds, emitterIds)
    assert.equal(serialize(compile(back!, cat, sc).doc, cat), once, `${label} 往返应逐字节相同`)
  }
})

test('反解：同一实体的多个实例参数不一致即返回 null（被手改过，不猜）', () => {
  // rx_ant 归**站**（D-054）：同一个站对 N 个源是同一副接收天线，两份参数必须一模一样。
  // 拿馈线损耗做手脚而不是增益——增益已改为由场景带出，不再是链路状态里的参数
  const doc = compile(multi(['site-1'], ['uav-1', 'uav-2']), cat, scenario3).doc
  const hacked = JSON.parse(JSON.stringify(doc)) as DiagramDoc
  const one = hacked.nodes.find((n) => n.id === 'rx_ant__uav-2')!
  one.params = { ...one.params, feeder_loss_dB: 1.5 }
  assert.equal(parseChain(hacked), null)
})

test('反解：共用槽位（传播信道）的实例之间不一致同样返回 null', () => {
  const doc = compile(multi(['site-1'], ['uav-1', 'uav-2']), cat, scenario3).doc
  const hacked = JSON.parse(JSON.stringify(doc)) as DiagramDoc
  const one = hacked.nodes.find((n) => n.id === 'ch__uav-2')!
  one.params = { ...one.params, delay_mode: 'off' }
  assert.equal(parseChain(hacked), null)
})

test('逐实体设置：不同实体可以不同，且往返逐字节相同（D-054）', () => {
  // 三个站各配一台不同的接收机前端；发射天线的馈线损耗按源分别设
  const c = multi(['site-1', 'site-2', 'site-3'], ['uav-1', 'uav-2', 'uav-3'])
  c.slots.rx_fe.byEntity = { 'site-2': { gain_dB: 30 }, 'site-3': { gain_dB: 10, lo_offset_Hz: 1000 } }
  c.slots.tx_ant.byEntity = { 'uav-3': { feeder_loss_dB: 2 } }

  const once = serialize(compile(c, cat, scenario3).doc, cat)
  const doc = parseDoc(once)
  assert.equal(doc.ok, true)
  if (!doc.ok) return

  // 编译时逐实例写的是各自的有效值
  const g = (id: string) => doc.doc.nodes.find((n) => n.id === id)!.params.gain_dB
  assert.equal(g('rx_fe__site-1'), 20)
  assert.equal(g('rx_fe__site-2'), 30)
  assert.equal(g('rx_fe__site-3'), 10)
  assert.equal(doc.doc.nodes.find((n) => n.id === 'rx_fe__site-3')!.params.lo_offset_Hz, 1000)
  // 发射天线归源：同一架机对三个站是同一副天线
  for (const site of ['site-1', 'site-2', 'site-3']) {
    assert.equal(doc.doc.nodes.find((n) => n.id === `tx_ant__uav-3__${site}`)!.params.feeder_loss_dB, 2)
    assert.equal(doc.doc.nodes.find((n) => n.id === `tx_ant__uav-1__${site}`)!.params.feeder_loss_dB, undefined)
  }

  const back = parseChain(doc.doc)
  assert.ok(back)
  assert.equal(serialize(compile(back!, cat, scenario3).doc, cat), once, '往返应逐字节相同')
})

test('归约是确定性的：众数作共用底值，票数并列取实体 id 字典序最小者（D-054）', () => {
  // 三个站的 gain_dB 取值 20 / 20 / 30：众数 20 进共用底值，只有 site-3 进覆盖
  const c = multi(['site-1', 'site-2', 'site-3'], ['uav-1'])
  c.slots.rx_fe.byEntity = { 'site-3': { gain_dB: 30 } }
  const r1 = parseChain(parseOk(serialize(compile(c, cat, scenario3).doc, cat)))!
  assert.equal(r1.slots.rx_fe.params.gain_dB, 20)
  assert.deepEqual(r1.slots.rx_fe.byEntity, { 'site-3': { gain_dB: 30 } })

  // 两票对一票（30 / 30 / 20）：众数 30 成底值，site-1 进覆盖——
  // 有效值一个没变，所以往返仍逐字节相同
  const c2 = multi(['site-1', 'site-2', 'site-3'], ['uav-1'])
  c2.slots.rx_fe.byEntity = { 'site-2': { gain_dB: 30 }, 'site-3': { gain_dB: 30 } }
  const doc2 = serialize(compile(c2, cat, scenario3).doc, cat)
  const r2 = parseChain(parseOk(doc2))!
  assert.equal(r2.slots.rx_fe.params.gain_dB, 30)
  assert.deepEqual(r2.slots.rx_fe.byEntity, { 'site-1': { gain_dB: 20 } })
  assert.equal(serialize(compile(r2, cat, scenario3).doc, cat), doc2, '往返应逐字节相同')

  // 归约两次结果相同（幂等），说明划分唯一
  assert.deepEqual(parseChain(parseOk(serialize(compile(r2, cat, scenario3).doc, cat))), r2)
})

test('单源单站：byEntity 不产生，编译结果与 D-053 时代一模一样（D-054 的退化）', () => {
  const back = parseChain(parseOk(serialize(compile(synthetic(), cat, scenario).doc, cat)))!
  for (const id of Object.keys(back.slots)) {
    assert.equal(back.slots[id as keyof typeof back.slots].byEntity, undefined, id)
  }
})

test('换变体：上一个变体的参数不写进新组件（2026-09-09 用户实测）', () => {
  // 走真实路径：链路是从框图解出来的，`parseChain` 会把三个由频率计划派生的参数留在状态里。
  // 换成回放源后它们一个都不该写出去，否则引擎报「FileReplaySource 未知参数 center_frequency_Hz」，
  // 而报文指向的是用户刚选的那个组件，看不出问题出在换变体上
  const c = parseChain(parseOk(DEFAULT_CHAIN_TEXT))!
  assert.equal(c.slots.tx.params.center_frequency_Hz, 2440500000, '前提：派生参数确实留在状态里')
  const replay = { ...c, slots: { ...c.slots, tx: { ...c.slots.tx, variant: 1 } } }
  const tx = compile(replay, cat, scenario).doc.nodes.find((n) => n.id === 'tx')!
  assert.equal(tx.type, 'FileReplaySource')
  const known = new Set(cat.components.find((x) => x.type === 'FileReplaySource')!.params.map((x) => x.name))
  assert.deepEqual(Object.keys(tx.params).filter((k) => !known.has(k)), [])

  // 不写 ≠ 丢弃：状态里还留着，换回去照旧写出来
  assert.equal(replay.slots.tx.params.center_frequency_Hz, 2440500000)
  const backNode = compile(c, cat, scenario).doc.nodes.find((n) => n.id === 'tx')!
  assert.equal(backNode.params.center_frequency_Hz, 2440500000)
})

test('换变体：目录还没到手时不做过滤（不知道谁认识谁，交给引擎判）', () => {
  const c = parseChain(parseOk(DEFAULT_CHAIN_TEXT))!
  const replay = { ...c, slots: { ...c.slots, tx: { ...c.slots.tx, variant: 1 } } }
  const tx = compile(replay, null, scenario).doc.nodes.find((n) => n.id === 'tx')!
  assert.ok('center_frequency_Hz' in tx.params)
})

test('辐射源的变体由模式决定，卡片上不给第二个开关（D-057）', () => {
  // 「场景辐射源」= 全合成 / 混合增强，「实测片段回放」= 实测回放，本来就是同一件事。
  // 同一件事两个入口只会多一个操作口、把逻辑弄复杂（用户 2026-09-09 指示）
  assert.equal(SLOT_BY_ID.tx.variantFrom, 'mode')
  // 除辐射源外，多变体的环节仍由卡片自己选（传播信道的两个变体不对应任何模式）
  for (const d of SLOTS) {
    if (d.id === 'tx') continue
    assert.notEqual(d.variantFrom, 'mode', `${d.id} 不该跟着模式走`)
  }

  // 模式一换，变体跟着走，编译出来就是那个模式该有的样子
  const r = switchMode(synthetic(), 'replay')
  assert.equal(r.slots.tx.variant, SLOT_BY_ID.tx.variants.findIndex((v: { type: string }) => v.type === 'FileReplaySource'))
  assert.equal(r.scenario, null, '回放数据与场景无关（防线二、三）')
  assert.deepEqual(compile(r, cat, null).doc.nodes.map((n) => n.id), ['tx', 'det', 'feat', 'rec', 'eval'])

  const back = switchMode(r, 'synthetic')
  assert.equal(back.slots.tx.variant, 0)
  // 混合增强用的也是变体 0（合成目标走全链，回放背景在链尾相加）
  assert.equal(switchMode(synthetic(), 'mixed').slots.tx.variant, 0)
})

test('换模式不丢前端参数：暂存进 template_ref 再取回来（D-055）', () => {
  // 界面每改一次都「编译成文档 → 再解回来」，视图不持有第二份状态。
  // 回放模式下前端六个环节不变成节点，参数只能存在 template_ref 里，否则一去不返（铁律 15）
  const cycle = (c: ChainState): ChainState =>
    parseChain(parseOk(serialize(compile(c, cat, scenario).doc, cat)))!

  const start = parseChain(parseOk(DEFAULT_CHAIN_TEXT))!
  assert.equal(start.slots.adc.params.full_scale_dBm, -20)
  assert.equal(start.slots.rx_fe.params.gain_dB, 20)

  const replay = cycle(switchMode(start, 'replay'))
  assert.equal(replay.mode, 'replay')
  // 前端两个环节的参数确实被存下来了
  const doc = compile(replay, cat, scenario).doc
  assert.deepEqual(Object.keys(doc.template_ref!.inactive_slots ?? {}), ['rx_fe', 'adc'])
  assert.equal(doc.template_ref!.inactive_slots!.adc!.params!.full_scale_dBm, -20)

  const back = cycle(switchMode(replay, 'synthetic'))
  assert.equal(back.mode, 'synthetic')
  assert.equal(back.slots.adc.params.full_scale_dBm, -20, 'ADC 满量程要活着回来')
  assert.equal(back.slots.rx_fe.params.gain_dB, 20, '前端增益要活着回来')
})

test('旁路与未实现的环节同样不丢参数（D-055）', () => {
  const cycle = (c: ChainState): ChainState =>
    parseChain(parseOk(serialize(compile(c, cat, scenario).doc, cat)))!
  const c = parseChain(parseOk(DEFAULT_CHAIN_TEXT))!
  const withParams: ChainState = {
    ...c,
    slots: {
      ...c.slots,
      chan: { ...c.slots.chan, params: { channels: 16 }, bypass: true },  // 用户勾了旁路
      ddc: { ...c.slots.ddc, params: { decim: 4 } },                      // 组件还没实现
    },
  }
  const back = cycle(withParams)
  assert.equal(back.slots.chan.params.channels, 16)
  assert.equal(back.slots.ddc.params.decim, 4)
})

test('逐实体的单独设置也跟着暂存（D-055 + D-054）', () => {
  const cycle = (c: ChainState): ChainState =>
    parseChain(parseOk(serialize(compile(c, cat, scenario3).doc, cat)))!
  const c = multi(['site-1', 'site-2', 'site-3'], ['uav-1'])
  const withOverride: ChainState = {
    ...c,
    slots: { ...c.slots, ddc: { ...c.slots.ddc, params: { decim: 4 }, byEntity: { 'site-2': { decim: 8 } } } },
  }
  const back = cycle(withOverride)
  assert.equal(back.slots.ddc.params.decim, 4)
  assert.deepEqual(back.slots.ddc.byEntity, { 'site-2': { decim: 8 } })
})

test('槽位全是活的时候不写 inactive_slots，既有框图逐字节不变（D-055）', () => {
  const doc = compile(parseChain(parseOk(DEFAULT_CHAIN_TEXT))!, cat, scenario).doc
  // 缺省链里 ddc / chan / df / loc 都不活，但参数全空，所以整段不写
  assert.equal(doc.template_ref!.inactive_slots, undefined)
  assert.equal(serialize(doc, cat), DEFAULT_CHAIN_TEXT)
})

test('回放模式不做 ADC 量化噪声这条检查（2026-09-09 用户实测截图）', () => {
  // 回放模式下 ADC 与接收机前端都是「回放数据已含」、不参与计算，噪声系数又要靠场景带出，
  // 这条检查只会永远落到「算不出」那一支，在界面上挂一个消不掉的红叉
  const rp = switchMode(emptyChain('replay', 'chain-replay'), 'replay')
  const ids = planChecks(rp, freqPlan(rp, null), null).map((k) => k.id)
  assert.ok(!ids.includes('adc_floor'), `回放模式不该有这一条：${ids.join()}`)

  // 全合成照常有
  const syn = synthetic()
  assert.ok(planChecks(syn, freqPlan(syn, scenario), scenario).map((k) => k.id).includes('adc_floor'))
})

// ------------------------------------------------------------ 传播效应与代理参数（D-058）

test('缺省链一个传播参数都不写：E1 是目录缺省，既有框图逐字节不变', () => {
  const r = compile(synthetic(), cat, scenario)
  const scn = r.doc.nodes.find((n) => n.id === 'scn')!
  for (const name of PROPAGATION_PARAMS) assert.equal(name in scn.params, false)
  assert.equal(r.doc.template_ref!.inactive_slots?.ch, undefined)
})

test('代理参数写到 scn 节点、不写 ch 节点，往返逐字节', () => {
  const c = synthetic()
  c.slots.ch.params = {
    ...c.slots.ch.params,
    prop_level: 'E2', prop_primary: 'urban_empirical', env_class: 'dense_urban',
    prop_shadow: true, shadow_sigma_dB: 7,
  }
  const r = compile(c, cat, scenario)
  const scn = r.doc.nodes.find((n) => n.id === 'scn')!
  assert.equal(scn.params.prop_level, 'E2')
  assert.equal(scn.params.prop_primary, 'urban_empirical')
  assert.equal(scn.params.env_class, 'dense_urban')
  assert.equal(scn.params.prop_shadow, true)
  assert.equal(scn.params.shadow_sigma_dB, 7)
  const ch = r.doc.nodes.find((n) => n.id === 'ch')!
  for (const name of PROPAGATION_PARAMS) assert.equal(name in ch.params, false)

  // 往返：解回来的链路状态里代理参数回到 ch 槽位，再编译逐字节相同
  const text = serialize(r.doc, cat)
  const back = parseChain(parseOk(text))!
  assert.equal(back.slots.ch.params.prop_level, 'E2')
  assert.equal(back.slots.ch.params.shadow_sigma_dB, 7)
  assert.equal(serialize(compile(back, cat, scenario).doc, cat), text)
})

test('多站：K 个 scn 拿到同一份代理参数（ch 是全图共用的槽位）', () => {
  const c = multi(['site-1', 'site-2', 'site-3'], ['uav-1'])
  c.slots.ch.params = { ...c.slots.ch.params, prop_level: 'E2', prop_primary: 'two_ray' }
  const r = compile(c, cat, scenario3)
  const scns = r.doc.nodes.filter((n) => n.id.startsWith('scn'))
  assert.equal(scns.length, 3)
  for (const n of scns) {
    assert.equal(n.params.prop_level, 'E2')
    assert.equal(n.params.prop_primary, 'two_ray')
  }
  const text = serialize(r.doc, cat)
  assert.equal(serialize(compile(parseChain(parseOk(text))!, cat, scenario3).doc, cat), text)
})

test('手改成各站不一致的代理参数：反解拒绝，不取第一个了事', () => {
  const c = multi(['site-1', 'site-2'], ['uav-1'])
  c.slots.ch.params = { ...c.slots.ch.params, prop_level: 'E2', prop_primary: 'two_ray' }
  const doc = compile(c, cat, scenario3).doc
  const other = doc.nodes.find((n) => n.id === 'scn__site-2')!
  other.params = { ...other.params, prop_primary: 'urban_empirical' }
  assert.equal(parseChain(doc), null)
})

test('还没选场景时代理参数收进 inactive_slots，切回来不丢（铁律 15）', () => {
  const c = emptyChain('synthetic', 'chain-nosce')
  c.slots.ch.params = { prop_level: 'E2', prop_primary: 'two_ray', ground_type: 'water' }
  const r = compile(c, cat, null)
  assert.equal(r.doc.nodes.some((n) => n.id === 'scn'), false)   // 没有场景就没有 scn 节点
  const kept = r.doc.template_ref!.inactive_slots!.ch!
  assert.deepEqual(kept.params, { ground_type: 'water', prop_level: 'E2', prop_primary: 'two_ray' })
  const text = serialize(r.doc, cat)
  const back = parseChain(parseOk(text))!
  assert.equal(back.slots.ch.params.prop_level, 'E2')
  assert.equal(back.slots.ch.params.ground_type, 'water')
  assert.equal(serialize(compile(back, cat, null).doc, cat), text)
})

test('回放模式：ch 整个不适用，代理参数随槽位一起暂存并复原', () => {
  const c = emptyChain('replay', 'chain-replay')
  c.slots.tx.params = { data_id: 'x', sample_rate_Hz: 1e6, center_frequency_Hz: 2.44e9 }
  c.slots.ch.params = { prop_level: 'E2', prop_weather: true, rain_rate_mmh: 25 }
  const text = serialize(compile(c, cat, null).doc, cat)
  const back = parseChain(parseOk(text))!
  assert.equal(back.slots.ch.params.prop_level, 'E2')
  assert.equal(back.slots.ch.params.rain_rate_mmh, 25)
  assert.equal(serialize(compile(back, cat, null).doc, cat), text)
})

test('传播效应清单与 geo/propagation.cpp 的 included_loss_terms 同一套规则', () => {
  assert.deepEqual(propView({}).terms, ['free_space'])
  // E1 下勾了别的也不算数——引擎那边会直接报错，清单不能装作算了
  assert.deepEqual(propView({ prop_shadow: true }).terms, ['free_space'])
  assert.deepEqual(
    propView({ prop_level: 'E2', prop_primary: 'two_ray', prop_shadow: true }).terms,
    ['free_space', 'ground_reflection', 'shadow'],
  )
  assert.deepEqual(
    propView({ prop_level: 'E2', prop_primary: 'urban_empirical', prop_weather: true }).terms,
    ['free_space', 'urban_mean', 'weather'],
  )
  // 城市经验带分位裕度时它自己就含阴影（闸二据此拦）
  assert.deepEqual(
    propView({ prop_level: 'E2', prop_primary: 'urban_empirical',
               urban_loss_mode: 'mean_with_shadow_margin' }).terms,
    ['free_space', 'urban_mean', 'shadow'],
  )
  assert.match(propView({ prop_level: 'E2', prop_primary: 'urban_empirical' }).text, /城区/)
})

test('右栏按当前档位显隐：E1 只有档位一项，选了双径才出材质', () => {
  assert.deepEqual(visiblePropParams(propView({})), ['prop_level'])
  const twoRay = visiblePropParams(propView({ prop_level: 'E2', prop_primary: 'two_ray' }))
  assert.ok(twoRay.includes('ground_type'))
  assert.ok(twoRay.includes('coherence_rho'))
  assert.ok(!twoRay.includes('ref_distance_m'))
  const urban = visiblePropParams(propView({ prop_level: 'E2', prop_primary: 'urban_empirical' }))
  assert.ok(urban.includes('ref_distance_m'))
  assert.ok(!urban.includes('ground_type'))
  assert.ok(!urban.includes('rain_rate_mmh'))
  assert.ok(visiblePropParams(propView({ prop_level: 'E2', prop_weather: true }))
    .includes('rain_rate_mmh'))
})

test('前端的相容判据与引擎 PropagationConfig::validate 一一对应', () => {
  const V = (p: Record<string, unknown>) => propView(p as Record<string, never>)
  assert.equal(propConflict(V({})), null)
  assert.match(propConflict(V({ prop_level: 'E3' }))!, /D3/)
  assert.match(propConflict(V({ prop_primary: 'two_ray' }))!, /E2/)
  assert.match(
    propConflict(V({ prop_level: 'E2', prop_primary: 'urban_empirical',
                     urban_loss_mode: 'mean_with_shadow_margin', prop_shadow: true }))!,
    /双计/)
})

test('传播信道只有一个变体：定参自由空间已撤（D-059）', () => {
  assert.equal(SLOT_BY_ID.ch.variants.length, 1)
  assert.equal(SLOT_BY_ID.ch.variants[0]!.type, 'SceneBoundChannel')
  // 变体只剩一个，卡片上就不该再出现下拉——判据与 SlotCard 的渲染条件是同一个
  assert.equal(SLOT_BY_ID.ch.variants.length > 1, false)
})

test('用了已撤掉变体的框图：不硬解、不改写，落到「不是典型链路」并说得出缘由', () => {
  const doc = compile(synthetic(), cat, scenario).doc
  const ch = doc.nodes.find((n) => n.id === 'ch')!
  ch.type = 'FreeSpaceChannel'
  ch.params = { distance_m: 1000, frequency_Hz: 2.4405e9 }
  delete ch.scene_binding
  assert.equal(parseChain(doc), null)
  assert.match(retiredNote(doc.nodes.map((n) => n.type))!, /自由空间（定参）/)
  assert.equal(retiredNote(['SceneBoundChannel', 'AntennaGain']), null)
})

test('频率计划第 11 项：E3 与「自由空间定参 + 高档位」都被拦住', () => {
  const c = synthetic()
  const ok = planChecks(c, freqPlan(c, scenario), scenario).find((k) => k.id === 'propagation')!
  assert.equal(ok.ok, true)

  const e3 = synthetic()
  e3.slots.ch.params = { ...e3.slots.ch.params, prop_level: 'E3' }
  const bad = planChecks(e3, freqPlan(e3, scenario), scenario).find((k) => k.id === 'propagation')!
  assert.equal(bad.ok, false)
  assert.equal(planOk(planChecks(e3, freqPlan(e3, scenario), scenario)), false)

  // 回放模式不做这条检查：没有场景也没有 scn 节点，传播配置不参与计算
  const rp = emptyChain('replay', 'chain-rp')
  rp.slots.ch.params = { prop_level: 'E3' }
  assert.equal(planChecks(rp, freqPlan(rp, null), null).some((k) => k.id === 'propagation'), false)
})

test('频率计划：跳频点也要过铁律 4 的闸（G-6，D-069）', () => {
  const c = synthetic()
  // 无 hop：df_max 就是 |f_tx − f_rx|，出处为空 → 文案与改动前逐字相同
  const p0 = freqPlan(c, scenario)
  assert.equal(p0.df_max, 0)
  assert.equal(p0.df_max_where, '')
  const d0 = planChecks(c, p0, scenario).find((x) => x.id === 'edge')!
  assert.ok(d0.detail.startsWith('|Δf| + B/2 + 保护带 ='), d0.detail)

  // 加一条跳频活动，序列里有一点把 |Δf| 推到 150 kHz：150 + 200 + 25 = 375 ≥ 250 → 不通过
  const hop = JSON.parse(JSON.stringify(scenario)) as ScenarioDoc
  ;(hop.activities as Array<Record<string, unknown>>).push({
    emitter_id: 'uav-1', t_s: 70, event: 'hop',
    args: { sequence: [2440500000, 2440650000], dwell_s: 0.01 },
  })
  const p1 = freqPlan(c, hop)
  assert.equal(p1.f_tx, 2440500000, 'f_tx 仍是 emission.center_Hz（DDC 的缺省频移在用它）')
  assert.equal(p1.df_max, 150000)
  const e1 = planChecks(c, p1, hop).find((x) => x.id === 'edge')!
  assert.equal(e1.ok, false)
  assert.ok(e1.detail.includes('最坏跳频点 2440.650 MHz'), e1.detail)
})
