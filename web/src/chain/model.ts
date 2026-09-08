// 典型链路的槽位表与状态模型（06 备忘录 §9G C-7；10 号报告 §2、§5；决策 D-051）。
//
// **链路视图是框图文档的投影，不是第二份状态。** 画面上的九个槽位由 `parse()` 从
// `diagram.text` 解出，改完参数由 `compile()` 编译回一份标准框图再走 `diagram/setDoc`。
// 于是撤销重做、脏标记、校验错误定位全部沿用 U-2 已有的那一套，不必再造一遍
// （09 §6.10「画布的真相是这个文档」对链路视图同样成立）。
//
// 槽位表是**唯一**声明「哪个环节用哪个组件、节点 id 叫什么、哪些参数从场景带出」的地方。
// 编译与反解都读它，UI 也读它，三处不会分叉。

import type { Catalog, ParamSpec } from '../api/catalog.js'
import { findComponent } from '../api/catalog.js'
import type { ChainMode, ParamValue } from '../diagram/doc.js'

export type { ChainMode }

export const TEMPLATE_ID = 'chain-v1'
export const TEMPLATE_VERSION = 1

/** 九个槽位，顺序即链路顺序（04 §5.1 的端到端对象）。 */
export type SlotId =
  | 'tx' | 'tx_ant' | 'ch' | 'rx_ant' | 'rx_fe' | 'adc' | 'ddc' | 'chan' | 'det'

/** 观测点，钉在链上的固定位置（04 §5.4 的 S0–S5；S6 不是 IQ，是检测识别产品）。 */
export type TapId = 's0' | 's1' | 's2' | 's3' | 's4' | 's5'

/** 槽位的四种状态。前三种见 10 报告 §2.5；`unavailable` 是组件还没实现（DDC 待 M-2 等）。 */
export type SlotState = 'active' | 'bypass' | 'not_applicable' | 'unavailable'

export interface SlotVariant {
  /** 组件类型名；不在目录里即该变体不可用 */
  type: string
  /** 编译出的节点 id，全模板唯一且固定——引擎报错按它反查槽位 */
  node: string
  /** 变体的中文名，下拉里显示 */
  label: string
  /** 绑定到场景的哪种对象；不绑定为 null */
  bind?: 'emitter' | 'site'
  /** 恒定参数：由模板决定、用户不可改 */
  fixed?: Record<string, ParamValue>
  /** 卡片正文显示哪几个参数 */
  summary: string[]
}

export interface SlotDef {
  id: SlotId
  /** 环节名 */
  label: string
  /** 04 §5.1 里对应的环节措辞，鼠标悬停时显示 */
  hint: string
  variants: SlotVariant[]
  /** 可否旁路（只有 DDC 与信道化可以，10 报告 §2.5） */
  bypassable?: boolean
  /** 缺省是否旁路 */
  defaultBypass?: boolean
  /** 回放模式下不适用的槽位 */
  replayNotApplicable?: boolean
}

/** 槽位表。改这里就改了整条链，编译、反解与界面同时跟随。 */
export const SLOTS: readonly SlotDef[] = [
  {
    id: 'tx', label: '辐射源', hint: '辐射源复基带信号',
    variants: [
      { type: 'SceneEmitterSource', node: 'tx', label: '场景辐射源', bind: 'emitter',
        fixed: { emit_at_tx_power: true }, summary: ['center_frequency_Hz', 'sample_rate_Hz'] },
      { type: 'FileReplaySource', node: 'tx', label: '实测片段回放', summary: ['data_id'] },
    ],
  },
  {
    id: 'tx_ant', label: '发射天线', hint: '发射特征与天线等效作用', replayNotApplicable: true,
    variants: [
      { type: 'AntennaGain', node: 'tx_ant', label: '天线增益', fixed: { role: 'tx' },
        summary: ['pattern', 'gain_dBi', 'polarization'] },
    ],
  },
  {
    id: 'ch', label: '传播信道', hint: '传播损耗、时延、多径、多普勒', replayNotApplicable: true,
    variants: [
      { type: 'SceneBoundChannel', node: 'ch', label: '场景绑定信道', bind: 'emitter',
        fixed: { gain_mode: 'path_loss_only' }, summary: ['delay_mode', 'apply_doppler'] },
      { type: 'FreeSpaceChannel', node: 'ch', label: '自由空间（定参）',
        summary: ['distance_m', 'frequency_Hz'] },
    ],
  },
  {
    id: 'rx_ant', label: '接收天线', hint: '接收天线与馈线', replayNotApplicable: true,
    variants: [
      { type: 'AntennaGain', node: 'rx_ant', label: '天线增益', fixed: { role: 'rx' },
        summary: ['pattern', 'gain_dBi', 'feeder_loss_dB'] },
    ],
  },
  {
    id: 'rx_fe', label: '接收机前端', hint: '接收机射频前端等效模型', replayNotApplicable: true,
    variants: [
      { type: 'ReceiverFrontEnd', node: 'rx_fe', label: '接收机前端',
        summary: ['nf_dB', 'gain_dB', 'lo_offset_Hz'] },
    ],
  },
  {
    id: 'adc', label: 'ADC', hint: 'ADC 采样与量化', replayNotApplicable: true,
    variants: [
      { type: 'AdcQuantizer', node: 'adc', label: 'ADC 量化',
        summary: ['bits', 'full_scale_dBm'] },
    ],
  },
  {
    id: 'ddc', label: 'DDC', hint: '数字下变频', bypassable: true, replayNotApplicable: true,
    variants: [
      { type: 'DDC', node: 'ddc', label: '数字下变频', summary: ['f_shift_Hz', 'decim'] },
    ],
  },
  {
    id: 'chan', label: '信道化', hint: '信道化', bypassable: true, defaultBypass: true,
    variants: [
      { type: 'Channelizer', node: 'chan', label: '多相信道化', summary: ['channels', 'select_channel'] },
    ],
  },
  {
    id: 'det', label: '检测识别评价', hint: '检测、识别与评价',
    variants: [
      { type: 'EnergyDetector', node: 'det', label: '能量检测',
        summary: ['nfft', 'pfa', 'noise_mode'] },
    ],
  },
]

export const SLOT_BY_ID: Readonly<Record<SlotId, SlotDef>> =
  Object.fromEntries(SLOTS.map((s) => [s.id, s])) as Record<SlotId, SlotDef>

/** 观测点在链上的锚点：优先挂第一个存在的槽位输出口。`s4` 另有兜底，见 compile。 */
export const TAP_ANCHOR: Readonly<Record<TapId, { slot: SlotId; label: string }>> = {
  s0: { slot: 'tx', label: 'S0 辐射源输出' },
  s1: { slot: 'rx_ant', label: 'S1 接收天线端' },
  s2: { slot: 'rx_fe', label: 'S2 前端输出' },
  s3: { slot: 'adc', label: 'S3 量化后' },
  s4: { slot: 'ddc', label: 'S4 主产品' },
  s5: { slot: 'chan', label: 'S5 子信道' },
}

export const TAP_ORDER: readonly TapId[] = ['s0', 's1', 's2', 's3', 's4', 's5']

export const MODE_LABEL: Readonly<Record<ChainMode, string>> = {
  synthetic: '全合成',
  replay: '实测回放',
  mixed: '混合增强',
}

/** 一个槽位的用户可编辑状态。 */
export interface SlotConfig {
  /** 选中的变体在 `SlotDef.variants` 里的下标 */
  variant: number
  /** 用户勾了旁路（只对 bypassable 有意义） */
  bypass: boolean
  params: Record<string, ParamValue>
}

/** 链路视图的完整状态。它由 `parse()` 从框图解出，由 `compile()` 编译回框图。 */
export interface ChainState {
  diagram_id: string
  name: string
  mode: ChainMode
  /** 场景引用；回放模式为 null */
  scenario: { scenario_id: string; sha256: string } | null
  siteId: string | null
  emitterId: string | null
  /** 混合模式的背景回放数据 */
  backgroundDataId: string | null
  run: { duration_s: number; seed: number; block_size?: number }
  slots: Record<SlotId, SlotConfig>
  taps: Record<TapId, boolean>
}

/** 某个槽位在当前模式与目录下的实际状态。 */
export function slotState(chain: ChainState, id: SlotId, cat: Catalog | null): SlotState {
  const def = SLOT_BY_ID[id]
  if (chain.mode === 'replay' && def.replayNotApplicable) return 'not_applicable'
  const v = def.variants[chain.slots[id].variant] ?? def.variants[0]!
  if (cat && !findComponent(cat, v.type)) return 'unavailable'
  if (def.bypassable && chain.slots[id].bypass) return 'bypass'
  return 'active'
}

/** 当前选中的变体。 */
export function variantOf(chain: ChainState, id: SlotId): SlotVariant {
  const def = SLOT_BY_ID[id]
  return def.variants[chain.slots[id].variant] ?? def.variants[0]!
}

/**
 * 组件还没实现时给的理由，写在卡片上（不隐藏，隐藏会让人以为链路只有七段）。
 * 表里没有的组件走 `unavailableReason()` 的兜底——那多半不是「本期未实现」，
 * 而是应用服务的目录旧了（引擎重建过但服务没重启），说成「未实现」会把人引到错路上。
 */
export const UNAVAILABLE_REASON: Readonly<Record<string, string>> = {
  DDC: '待 MATLAB Coder 产物（M-2）；本期旁路，S4 直接取 ADC 输出',
  Channelizer: '待 MATLAB Coder 产物（M-3）；本期旁路',
  FeatureExtractor: '待特征提取组件（C-4）',
  TemplateClassifier: '待模板匹配识别（C-4）',
  Evaluator: '待评价器（C-5）',
}

/** 某个组件不在目录里时该说什么。 */
export function unavailableReason(type: string): string {
  return UNAVAILABLE_REASON[type]
    ?? `组件目录里没有 ${type}。引擎重建过而应用服务没重启时会这样，重启服务即可刷新目录`
}

/** 建一份缺省链路状态。参数一律留空，由目录缺省与场景带出填。 */
export function emptyChain(mode: ChainMode = 'synthetic', id = 'chain-1'): ChainState {
  const slots = {} as Record<SlotId, SlotConfig>
  for (const d of SLOTS) slots[d.id] = { variant: 0, bypass: !!d.defaultBypass, params: {} }
  if (mode === 'replay') slots.tx.variant = 1        // 回放模式的辐射源是回放源
  return {
    diagram_id: id,
    name: `典型链路 · ${MODE_LABEL[mode]}`,
    mode,
    scenario: null,
    siteId: null,
    emitterId: null,
    backgroundDataId: null,
    run: { duration_s: 20, seed: 20260907 },
    slots,
    taps: { s0: false, s1: false, s2: false, s3: false, s4: true, s5: false },
  }
}

/** 某个槽位缺哪些必填参数（目录说必填、链路状态里没有、也不是恒定参数）。 */
export function missingParams(
  chain: ChainState, id: SlotId, cat: Catalog | null,
  /** 当前算得出来的派生量；算不出来的仍按必填看待，不静默留空（铁律 15） */
  derivable: readonly string[] = ALL_DERIVED,
): string[] {
  if (!cat) return []
  const v = variantOf(chain, id)
  const spec = findComponent(cat, v.type)
  if (!spec) return []
  const fixed = v.fixed ?? {}
  const derived = (DERIVED_PARAMS[id] ?? []).filter((n) => derivable.includes(n))
  const out: string[] = []
  for (const p of spec.params as ParamSpec[]) {
    if (!p.required || p.internal) continue
    if (p.name in fixed) continue
    if (derived.includes(p.name)) continue
    const val = chain.slots[id].params[p.name]
    if (val === undefined || val === '') out.push(p.name)
  }
  return out
}

/**
 * 由频率计划派生、用户不必填的参数（10 报告 §2.4「一处填、多处派生」）。
 * 它们在参数面板上只读显示并注明来源，编译时由 `compile()` 算出。
 */
export const DERIVED_PARAMS: Partial<Record<SlotId, string[]>> = {
  tx: ['sample_rate_Hz', 'total_samples', 'center_frequency_Hz'],
  det: ['band_lo_Hz', 'band_hi_Hz'],
  ch: ['frequency_Hz'],
}

const ALL_DERIVED: readonly string[] = Object.values(DERIVED_PARAMS).flat()
