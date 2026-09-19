// 场景实体的**电子设备参数**字段表（D-054）。
//
// 这张表是唯一的定义处，两个界面都读它：场景视图的对象表单（`ObjectForm.tsx`）与框图页的
// 典型链路（`chain/ChainView.tsx`）。用户拍板「两处都留」，那就必须共用一套定义——
// 各写一份迟早会出现「在场景页改了噪声系数，框图页显示的还是老值」这类分叉。
//
// 表里只放**设备**参数。位置、离地高、航线、活动是几何与行为，不在此列：它们的编辑入口
// 只在场景视图，框图页不该出现一个「把无人机挪到别处」的输入框。
//
// `rel` 是相对实体根的点路径，配 `devicePath()` 拼成 `setPath()` 认的绝对路径。
// 用相对路径而不是绝对路径，是因为同一个字段在两处界面里的下标不同，写死下标就没法共用。

import type { Obj } from './scenarioOps.js'

export type DeviceKind = 'site' | 'emitter'

export interface DeviceField {
  /** 稳定键。`chain/model.ts` 的 `FROM_SCENE` 表按它引用字段，改 `rel` 不会波及那边 */
  key: string
  label: string
  /** 显示单位；无量纲写空串 */
  unit: string
  /** 相对实体根的点路径，如 `receiver.nf_dB` */
  rel: string
  type: 'number' | 'enum' | 'text'
  /** `type === 'enum'` 时的取值域，与场景 schema 一致 */
  options?: readonly string[]
  /** 缺省值：字段缺席时显示它，但**不**代表文件里有这个值 */
  fallback?: string
  /** 只在满足条件时出现（波形字段随波形种类变） */
  when?: (entity: Obj) => boolean
}

/** 读实体上的相对路径；读不到返回 undefined，不拿默认值顶替（铁律 15）。 */
export function readField(entity: Obj | undefined, rel: string): unknown {
  let cur: unknown = entity
  for (const k of rel.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Obj)[k]
  }
  return cur
}

/** 拼出 `setPath()` 认的绝对路径：`sites.0.receiver.nf_dB`。 */
export function devicePath(kind: DeviceKind, index: number, rel: string): string {
  return `${kind === 'site' ? 'sites' : 'emitters'}.${index}.${rel}`
}

function hasWaveformKey(k: string) {
  return (e: Obj) => typeof readField(e, `emission.waveform.${k}`) === 'number'
}

/**
 * 站点的设备参数。
 *
 * `clock` 一组自 D-053 就在场景格式里，但**界面上一直没有入口**，只能手改 JSON——
 * golden-03 那三组站钟就是这么写进去的。它们是站的时统指标，正是「电子设备参数」，
 * 这次一并放出来。字段缺席时 `setPath` 会把 `clock` 建出来（D-054）。
 */
export const SITE_DEVICE_FIELDS: readonly DeviceField[] = [
  // 型号本身也要能设，否则「同型号共用一套参数」这件事在界面上根本发动不起来（D-054）
  { key: 'site.model', label: '设备型号', unit: '', rel: 'equipment_model', type: 'text' },
  { key: 'site.antenna_gain', label: '天线增益', unit: 'dBi', rel: 'antenna.gain_dBi', type: 'number' },
  { key: 'site.fs', label: '采样率', unit: 'Hz', rel: 'receiver.fs_Hz', type: 'number' },
  { key: 'site.center', label: '中心频率', unit: 'Hz', rel: 'receiver.center_Hz', type: 'number' },
  { key: 'site.bw', label: '带宽', unit: 'Hz', rel: 'receiver.bw_Hz', type: 'number' },
  { key: 'site.nf', label: '噪声系数', unit: 'dB', rel: 'receiver.nf_dB', type: 'number' },
  { key: 'site.clock_sigma', label: '站钟同步 σ', unit: 'ns', rel: 'clock.sync_sigma_ns', type: 'number' },
  { key: 'site.clock_bias', label: '固定钟差', unit: 'ns', rel: 'clock.bias_ns', type: 'number' },
  { key: 'site.rx_delay', label: '通道群时延', unit: 'ns', rel: 'clock.rx_delay_ns', type: 'number' },
  { key: 'site.rx_delay_sigma', label: '群时延 σ', unit: 'ns', rel: 'clock.rx_delay_sigma_ns', type: 'number' },
  {
    key: 'site.sync_state', label: '同步状态', unit: '', rel: 'clock.sync_state', type: 'enum',
    options: ['locked', 'holdover', 'unsynced'], fallback: 'locked',
  },
]

/** 辐射源的设备参数。`polarization` 同样是自 D-051 就有格式、界面一直没入口的一项。 */
export const EMITTER_DEVICE_FIELDS: readonly DeviceField[] = [
  // 缺省留空即回退 platform_type 作分组键（D-054）
  { key: 'em.model', label: '设备型号', unit: '', rel: 'equipment_model', type: 'text' },
  { key: 'em.center', label: '中心频率', unit: 'Hz', rel: 'emission.center_Hz', type: 'number' },
  { key: 'em.bw', label: '占用带宽', unit: 'Hz', rel: 'emission.bw_Hz', type: 'number' },
  { key: 'em.tx_power', label: '发射功率', unit: 'dBm', rel: 'emission.tx_power_dBm', type: 'number' },
  { key: 'em.antenna_gain', label: '天线增益', unit: 'dBi', rel: 'emission.antenna_gain_dBi', type: 'number' },
  {
    key: 'em.polarization', label: '极化', unit: '', rel: 'emission.polarization', type: 'enum',
    options: ['vertical', 'horizontal', 'slant45', 'rhcp', 'lhcp'], fallback: 'vertical',
  },
  { key: 'em.offset', label: '频偏', unit: 'Hz', rel: 'emission.waveform.offset_Hz', type: 'number', when: hasWaveformKey('offset_Hz') },
  { key: 'em.period', label: '突发周期', unit: 's', rel: 'emission.waveform.period_s', type: 'number', when: hasWaveformKey('period_s') },
  { key: 'em.duty', label: '占空比', unit: '', rel: 'emission.waveform.duty', type: 'number', when: hasWaveformKey('duty') },
]

export const DEVICE_FIELDS: Readonly<Record<DeviceKind, readonly DeviceField[]>> = {
  site: SITE_DEVICE_FIELDS,
  emitter: EMITTER_DEVICE_FIELDS,
}

/** 这个实体这一版实际要显示的字段（滤掉波形对不上的那几个）。 */
export function fieldsFor(kind: DeviceKind, entity: Obj | undefined): DeviceField[] {
  return DEVICE_FIELDS[kind].filter((f) => !f.when || (entity ? f.when(entity) : false))
}

/**
 * 设备型号：分组键。站点直接取 `equipment_model`；辐射源缺它时回退 `platform_type`
 * （既有场景文件都没写型号，回退让它们仍按机型分得开，D-054）。都没有就归「未标型号」。
 */
export const NO_MODEL = '未标型号'

export function modelOf(kind: DeviceKind, entity: Obj | undefined): string {
  if (!entity) return NO_MODEL
  const m = entity.equipment_model
  if (typeof m === 'string' && m.length > 0) return m
  if (kind === 'emitter' && typeof entity.platform_type === 'string' && entity.platform_type.length > 0) {
    return entity.platform_type
  }
  return NO_MODEL
}
