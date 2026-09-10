// 采样率与频率计划（10 号报告 §2.4；04 §9.3「宽带 IQ 基本约束」）。
//
// 典型链路里采样率只填一处、频率只填两处，其余全部派生。这个模块算派生量，
// 并做 04 §9.3 要求的六项检查：**「系统在连线和运行前应自动检查」**。
//
// 它是纯函数：不碰 React、不碰网络，因此能被单测直接对着算例表跑。
// 前端这一层是**预检**；引擎在各组件的 configure() 里复查自己能知道的那一部分
// （08 报告 §8 口径三：铁律 4 的检查置于封装层）。两侧的口径写在同一份表里，
// 避免出现前端放行、引擎拒绝的情况。

import type { ScenarioDoc } from '../state/types.js'
import { emitters, sites, type Obj } from '../scene/editor/scenarioOps.js'
import type { ChainState } from './model.js'
import { propConflict, propView } from './effects.js'

export interface FreqPlan {
  /** 宽带采样率，站点接收机给 */
  fs_rf: number
  /** 站点中心频率 */
  f_rx: number
  /** 辐射源中心频率 */
  f_tx: number
  /** 辐射源占用带宽 */
  bw_tx: number
  /** DDC 抽取比与频移；DDC 旁路时 decim = 1、f_shift = 0 */
  decim: number
  f_shift: number
  /** S4 采样率与中心频率 */
  fs_s4: number
  f_s4: number
  /** 信道化路数与 S5 采样率；旁路时 channels = 1 */
  channels: number
  fs_s5: number
  /** 保护带，缺省取采样率的 5%（见 GUARD_FRACTION 的说明） */
  guard: number
}

export interface PlanCheck {
  id: string
  label: string
  ok: boolean
  /** 不通过时给一句可操作的说明；通过时给读数 */
  detail: string
}

/**
 * 保护带占采样率的比例。取 5% 而不是 10%：`demo-01` 的窄带观测配置是 400 kHz 带宽落在
 * 500 kS/s 采样率里，两侧各剩 50 kHz，恰好等于 10% 的保护带——按 10% 算，
 * 本项目自己的演示场景就会卡在 04 §9.3 的严格不等号上。5% 让这条检查仍然拦得住真正贴边的配置，
 * 又给既有窄带场景留出两倍余量。它是**工程取值**，不是 04 规定的常数。
 */
export const GUARD_FRACTION = 0.05

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * 多源时挑出「最难放进接收带」的那个源：按 |Δf| + B/2 排序取最大者。
 * 频率计划的带宽与边缘两项检查因此对全部选中的源都成立（D-053 §4 的 `plan.ts` 一条）。
 */
function worstEmitter(list: readonly Obj[], site: Obj | undefined): Obj | undefined {
  if (list.length <= 1) return list[0]
  const fRx = num(((site?.receiver ?? {}) as Record<string, unknown>).center_Hz)
  let best = list[0]
  let bestCost = -Infinity
  for (const e of list) {
    const em = (e.emission ?? {}) as Record<string, unknown>
    const cost = Math.abs(num(em.center_Hz, fRx) - fRx) + num(em.bw_Hz) / 2
    if (cost > bestCost) { bestCost = cost; best = e }
  }
  return best
}

/**
 * 从链路状态与场景算出频率计划。场景缺失（回放模式）时用槽位里已填的值，
 * 算不出的项留 0 并由检查项报出来，不拿默认值顶替（铁律 15）。
 */
export function freqPlan(chain: ChainState, scenario: ScenarioDoc | null): FreqPlan {
  // 回放模式不看场景：数据自带采样率与中心频率，场景与它无关（防线二、三）。
  // 采样率此时只能由用户在检测段给出频段，或等 U-4 的数据中心把它带出来。
  const doc = chain.mode === 'replay' ? null : scenario
  // 多站多源（D-053）：参数按槽位共享，频率计划取**最差**的那一个实例——
  // 带宽与边缘检查必须对每个选中的源都成立，取第一个源会放过其它源的越界配置。
  const selSites = sites(doc).filter((x) => chain.siteIds.includes(String(x.id)))
  const selEms = emitters(doc).filter((x) => chain.emitterIds.includes(String(x.id)))
  const site = selSites[0] ?? sites(doc)[0]
  const emitter = worstEmitter(selEms.length ? selEms : emitters(doc).slice(0, 1), site)
  const rx = (site?.receiver ?? {}) as Record<string, unknown>
  const em = (emitter?.emission ?? {}) as Record<string, unknown>

  const fs_rf = num(rx.fs_Hz, num(chain.slots.tx.params.sample_rate_Hz))
  const f_rx = num(rx.center_Hz, num(chain.slots.tx.params.center_frequency_Hz))
  const f_tx = num(em.center_Hz, f_rx)
  const bw_tx = num(em.bw_Hz)

  const ddcOn = !chain.slots.ddc.bypass
  const decim = ddcOn ? Math.max(1, Math.round(num(chain.slots.ddc.params.decim, 1))) : 1
  // 缺省把目标搬到 S4 零频附近；用户可改成任意值以演示「目标不在观测中心」
  const f_shift = ddcOn
    ? (chain.slots.ddc.params.f_shift_Hz !== undefined ? num(chain.slots.ddc.params.f_shift_Hz) : f_tx - f_rx)
    : 0
  const fs_s4 = decim > 0 ? fs_rf / decim : 0
  const chanOn = !chain.slots.chan.bypass
  const channels = chanOn ? Math.max(1, Math.round(num(chain.slots.chan.params.channels, 8))) : 1

  return {
    fs_rf, f_rx, f_tx, bw_tx,
    decim, f_shift,
    fs_s4, f_s4: f_rx + f_shift,
    channels, fs_s5: channels > 0 ? fs_s4 / channels : 0,
    guard: GUARD_FRACTION * fs_rf,
  }
}

/** 回放模式不看场景（防线二、三），与 freqPlan 同一口径。 */
function scenarioOf(chain: ChainState, scenario: ScenarioDoc | null): ScenarioDoc | null {
  return chain.mode === 'replay' ? null : scenario
}

function fmt(hz: number): string {
  const a = Math.abs(hz)
  if (a >= 1e9) return `${(hz / 1e9).toFixed(4)} GHz`
  if (a >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`
  if (a >= 1e3) return `${(hz / 1e3).toFixed(3)} kHz`
  return `${hz.toFixed(1)} Hz`
}

/**
 * 04 §9.3 的六项检查。回放模式下前四项不适用（数据自带采样率与中心频率），
 * 此时只保留标度一致性那一项。
 */
export function planChecks(chain: ChainState, plan: FreqPlan, scenario: ScenarioDoc | null = null): PlanCheck[] {
  const out: PlanCheck[] = []
  const replay = chain.mode === 'replay'

  if (!replay) {
    out.push({
      id: 'bandwidth',
      label: '有效带宽不超采样率',
      ok: plan.fs_rf > 0 && plan.bw_tx + plan.guard <= plan.fs_rf,
      detail: plan.fs_rf > 0
        ? `占用 ${fmt(plan.bw_tx)} + 保护带 ${fmt(plan.guard)} ≤ 采样率 ${fmt(plan.fs_rf)}`
        : '站点接收机没有采样率，先选场景与站点',
    })

    const df = plan.f_tx - plan.f_rx
    const need = Math.abs(df) + plan.bw_tx / 2 + plan.guard
    out.push({
      id: 'edge',
      label: '目标不跨频带边缘',
      ok: plan.fs_rf > 0 && need < plan.fs_rf / 2,
      detail: `|Δf| + B/2 + 保护带 = ${fmt(need)}，须小于 Fs/2 = ${fmt(plan.fs_rf / 2)}`,
    })

    const decimOk = plan.decim >= 1 && plan.fs_rf > 0 && Math.abs(plan.fs_rf % plan.decim) < 1e-9
    out.push({
      id: 'decim',
      label: '抽取比例合法',
      ok: decimOk,
      detail: chain.slots.ddc.bypass
        ? 'DDC 旁路，S4 与宽带同采样率'
        : `抽取 ${plan.decim} 倍后 S4 = ${fmt(plan.fs_s4)}${decimOk ? '' : '；采样率须能被抽取比整除'}`,
    })

    // 过渡带：|Δf − f_shift| + B/2 ≤ 0.4·fs_s4，与 fir_version 的通带边缘一致（08 §8）
    const inband = Math.abs(plan.f_tx - plan.f_rx - plan.f_shift) + plan.bw_tx / 2
    out.push({
      id: 'transition',
      label: '滤波器过渡带足够',
      ok: chain.slots.ddc.bypass || (plan.fs_s4 > 0 && inband <= 0.4 * plan.fs_s4),
      detail: chain.slots.ddc.bypass
        ? 'DDC 旁路，不涉及抗混叠滤波'
        : `目标落在 S4 的 ±${fmt(inband)}，通带边缘 ${fmt(0.4 * plan.fs_s4)}`,
    })
  }

  // ADC 的量化噪声不得淹没热噪声。这一条是实测逼出来的：接收机前端不给增益时，
  // −111 dBm 的热噪声落在 −20 dBm 满量程、14 位 ADC 的最低有效位之下，
  // 整条链的输出就只剩量化噪声，谱上看不出任何物理量。
  //
  // **回放模式不做这条检查**：那时 ADC 与接收机前端都是「回放数据已含」、根本不参与计算，
  // 噪声系数又自 D-054 起由场景逐站带出而回放模式没有场景，于是它永远落到「算不出」那一支，
  // 界面上挂着一个用户怎么也消不掉的红叉（2026-09-09 用户实测截图）。
  // 原注释说它「不需要几何、在没有场景的模式下同样有效」，那是 D-054 之前的事了。
  if (!replay) {
  const fsDbm = chain.slots.adc.params.full_scale_dBm
  const bits = Number(chain.slots.adc.params.bits ?? 14)
  // 噪声系数自 D-054 起由场景逐站带出，不再存在槽位参数里。多站时取**最差**的那一个：
  // 这条检查要对每个站都成立，取第一个会放过噪声系数更高的那些站。
  const nfDoc = scenarioOf(chain, scenario)
  const nfSites = sites(nfDoc).filter((x) => chain.siteIds.includes(String(x.id)))
  const nfs = (nfSites.length ? nfSites : sites(nfDoc).slice(0, 1))
    .map((x) => num((x.receiver as Record<string, unknown> | undefined)?.nf_dB))
  const nf = nfs.length ? Math.max(...nfs) : 0
  const gain = Number(chain.slots.rx_fe.params.gain_dB ?? 0)
  if (typeof fsDbm === 'number' && plan.fs_rf > 0 && Number.isFinite(bits)) {
    // 量化噪声总功率 q²/6，q = 2·10^(fs/20)/2^bits
    const q = 2 * Math.pow(10, fsDbm / 20) / Math.pow(2, bits)
    const qNoise_dBm = 10 * Math.log10((q * q) / 6)
    const thermal_dBm = -174 + nf + 10 * Math.log10(plan.fs_rf) + gain
    const margin = thermal_dBm - qNoise_dBm
    out.push({
      id: 'adc_floor',
      label: 'ADC 量化噪声不淹没热噪声',
      ok: margin >= 6,
      detail: `热噪声 ${thermal_dBm.toFixed(1)} dBm，量化噪声 ${qNoise_dBm.toFixed(1)} dBm，`
        + `余量 ${margin.toFixed(1)} dB${margin >= 6 ? '' : '；请加大接收机增益或减小满量程'}`,
    })
  } else {
    out.push({ id: 'adc_floor', label: 'ADC 量化噪声不淹没热噪声', ok: false, detail: '缺满量程或采样率，算不出' })
  }
  }

  // 多源多站的可行性（D-053 §2.5、§4）。这两项算不出几何也成立，因此不受模式限制。
  const N = chain.emitterIds.length
  const K = chain.siteIds.length
  {
    let ok = true
    let detail = `${N} 个目标 × ${K} 个站，共 ${N * K} 条链路`
    if (replay && (N > 1 || K > 1)) {
      ok = false
      detail = '实测回放的片段是已经过完整接收链的 S4 数据，它对应一个录制时的站位；'
        + '把它复制到多个站等于假装同一份录音在几个地方同时被收到。多源多站请用全合成或混合模式'
    } else if (chain.mode === 'mixed' && K > 1) {
      ok = false
      detail = '混合增强的背景片段同样只对应一个站，K 必须为 1；合成目标那一支可以有多个源'
    } else if (!replay && (N === 0 || K === 0)) {
      ok = false
      detail = '站点与目标各至少选一个，否则没有链路可算'
    } else if (N > 8 || K > 8) {
      ok = false
      detail = `固定可选口上限为 8（源 ${N}、站 ${K}）；再多要改端口表，本期不做`
    }
    out.push({ id: 'stations', label: '多源多站可行', ok, detail })
  }

  if (!replay && K > 1) {
    const sel = sites(scenarioOf(chain, scenario)).filter((x) => chain.siteIds.includes(String(x.id)))
    const key = (x: Obj): string => {
      const rx = (x.receiver ?? {}) as Record<string, unknown>
      return `${num(rx.fs_Hz)}/${num(rx.center_Hz)}`
    }
    const keys = new Set(sel.map(key))
    out.push({
      id: 'sites_consistent',
      label: '各站采样率与中心频率一致',
      ok: keys.size <= 1,
      detail: keys.size <= 1
        ? `${K} 个站同为 ${fmt(plan.fs_rf)} @ ${fmt(plan.f_rx)}`
        : `选中的站有 ${keys.size} 种配置（${[...keys].join('、')}）；`
          + '同一框图里各站必须同采样率同中心频率，否则参数帧与 IQ 块的样点窗口对不上',
    })
  }

  // 传播档位自洽（D-058，12 §4.4 / §2.2）：与引擎 `PropagationConfig::validate()` 同一份表。
  // 回放模式没有场景也没有 scn 节点，传播配置不参与计算，这条不适用（同 adc_floor 的处置）。
  if (!replay) {
    const pv = propView(chain.slots.ch.params)
    const why = propConflict(pv)
    out.push({
      id: 'propagation',
      label: '传播档位自洽',
      ok: why === null,
      detail: why ?? `${pv.text}（${pv.terms.length} 项）`,
    })
  }

  out.push({
    id: 'scale',
    label: '标度与单位一致',
    ok: chain.mode !== 'mixed' || !!chain.backgroundDataId,
    detail: chain.mode === 'mixed'
      ? (chain.backgroundDataId ? '背景与合成目标都按 dBm 标定后相加' : '混合模式要先选背景数据')
      : '合成链内部一律 mW（D-047）',
  })

  return out
}

export function planOk(checks: PlanCheck[]): boolean {
  return checks.every((c) => c.ok)
}
