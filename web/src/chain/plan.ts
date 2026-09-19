// 采样率与频率计划（10 号报告 §2.4；04 §9.3「宽带 IQ 基本约束」）。
//
// 典型链路里采样率只填一处、频率只填两处，其余全部派生。这个模块算派生量，
// 并做 04 §9.3 要求的六项检查：**「系统在连线和运行前应自动检查」**。
//
// 它是纯函数：不碰 React、不碰网络，因此能被单测直接对着算例表跑。
// 前端这一层是**预检**；引擎在各组件的 configure() 里复查自己能知道的那一部分
// （08 报告 §8 口径三：铁律 4 的检查置于封装层）。两侧的口径写在同一份表里，
// 避免出现前端放行、引擎拒绝的情况。

import type { SceneSummaryLite, ScenarioDoc } from '../state/types.js'
import { emitterCenters, emitters, sites, type Obj } from '../scene/editor/scenarioOps.js'
import { slotState, type ChainState } from './model.js'
import type { Catalog } from '../api/catalog.js'
import { propConflict, propView } from './effects.js'
import { gridText, onGrid, passbandEdgeHz } from './firSpecs.js'

export interface FreqPlan {
  /** 宽带采样率，站点接收机给 */
  fs_rf: number
  /** 站点中心频率 */
  f_rx: number
  /** 辐射源中心频率 */
  f_tx: number
  /** 辐射源占用带宽 */
  bw_tx: number
  /**
   * 最坏中心频点相对站点的频偏 |Δf|（G-6，D-069）：跳频源要看序列里每一个频点，
   * 只看 `f_tx` 会放过跳出奈奎斯特的那几跳。无 hop 时它恒等于 |f_tx − f_rx|，
   * 于是既有框图的检查文案逐字不变。
   */
  df_max: number
  /** df_max 取自哪个频点（等于 f_tx 时为空串），只用在报错文案里 */
  df_max_where: string
  /** DDC 抽取比与频移；DDC 旁路时 decim = 1、f_shift = 0 */
  decim: number
  f_shift: number
  /** S4 采样率与中心频率 */
  fs_s4: number
  f_s4: number
  /** 信道化路数与 S5 采样率；旁路时 channels = 1 */
  channels: number
  fs_s5: number
  /** 输出的是哪一路（界面编号，`channels/2` 是零频那一路）与它的中心频率 */
  select: number
  f_s5: number
  /**
   * 辐射源的**全部**中心频点（含跳频序列），未去重、按场景里的次序。
   * 检查项要按不同的参照点各算一次「最坏频偏」——对 S4 参照 f_rx，对 S5 参照本路中心 ——
   * 只留一个 `df_max` 就没法换参照点了（C-10）。
   */
  centers: number[]
  /**
   * 接收滤波的通带（Hz，复基带双边占用）；该槽位没参与计算时为 0。
   * 真理源是场景的 `sites[].receiver.bw_Hz`（FROM_SCENE，D-054），用户在卡片上改的是那个字段。
   */
  bw_rx: number
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
 * 保护带占采样率的比例。取 5% 而不是 10%：`golden-01` 的窄带观测配置是 400 kHz 带宽落在
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
 * **跳频源按序列里最远的那个频点算**（G-6，D-069）：基频过闸不代表每一跳都过得了。
 */
function worstEmitter(list: readonly Obj[], site: Obj | undefined,
                      doc: ScenarioDoc | null): Obj | undefined {
  if (list.length <= 1) return list[0]
  const fRx = num(((site?.receiver ?? {}) as Record<string, unknown>).center_Hz)
  let best = list[0]
  let bestCost = -Infinity
  for (const e of list) {
    const em = (e.emission ?? {}) as Record<string, unknown>
    const cost = worstOffset(doc, String(e.id), num(em.center_Hz, fRx), fRx).df + num(em.bw_Hz) / 2
    if (cost > bestCost) { bestCost = cost; best = e }
  }
  return best
}

/** 该源相对站点最远的中心频点（含全部跳频点）与它的出处。 */
function worstOffset(doc: ScenarioDoc | null, emitterId: string, fTx: number, fRx: number):
    { df: number; where: string } {
  let df = Math.abs(fTx - fRx)
  let where = ''
  for (const f of emitterCenters(doc, emitterId)) {
    const d = Math.abs(f - fRx)
    if (d > df) { df = d; where = `${(f / 1e6).toFixed(3)} MHz` }
  }
  return { df, where }
}

/** 辐射源的全部中心频点（基频 + 跳频序列）。顺序照场景，不去重——文案里要按下标指认。 */
function centerSet(doc: ScenarioDoc | null, emitterId: string, fTx: number): number[] {
  const hops = emitterCenters(doc, emitterId)
  return hops.length ? hops.slice() : [fTx]
}

/**
 * 某个槽位实际生效的 `fir_version`：用户填过就用它，否则取组件目录里的缺省。
 * **目录取不到就返回 undefined**，让调用方说「算不出」而不是拿一个写死的版本号顶替（铁律 15）。
 */
function firVersionOf(chain: ChainState, slot: 'ddc' | 'chan', cat: Catalog | null): string | undefined {
  const own = chain.slots[slot].params.fir_version
  if (own !== undefined && own !== '') return String(own)
  const type = slot === 'ddc' ? 'DDC' : 'Channelizer'
  const c = cat?.components.find((x) => x.type === type)
  const spec = c?.params.find((x) => x.name === 'fir_version')
  return typeof spec?.default === 'string' ? spec.default : undefined
}

/**
 * 从链路状态与场景算出频率计划。场景缺失（回放模式）时用槽位里已填的值，
 * 算不出的项留 0 并由检查项报出来，不拿默认值顶替（铁律 15）。
 */
export function freqPlan(chain: ChainState, scenario: ScenarioDoc | null,
                        cat: Catalog | null = null): FreqPlan {
  // 回放模式不看场景：数据自带采样率与中心频率，场景与它无关（防线二、三）。
  // 采样率此时只能由用户在检测段给出频段，或等 U-4 的数据中心把它带出来。
  const doc = chain.mode === 'replay' ? null : scenario
  // 多站多源（D-053）：参数按槽位共享，频率计划取**最差**的那一个实例——
  // 带宽与边缘检查必须对每个选中的源都成立，取第一个源会放过其它源的越界配置。
  const selSites = sites(doc).filter((x) => chain.siteIds.includes(String(x.id)))
  const selEms = emitters(doc).filter((x) => chain.emitterIds.includes(String(x.id)))
  const site = selSites[0] ?? sites(doc)[0]
  const emitter = worstEmitter(selEms.length ? selEms : emitters(doc).slice(0, 1), site, doc)
  const rx = (site?.receiver ?? {}) as Record<string, unknown>
  const em = (emitter?.emission ?? {}) as Record<string, unknown>

  const fs_rf = num(rx.fs_Hz, num(chain.slots.tx.params.sample_rate_Hz))
  const f_rx = num(rx.center_Hz, num(chain.slots.tx.params.center_frequency_Hz))
  const f_tx = num(em.center_Hz, f_rx)
  const bw_tx = num(em.bw_Hz)
  // f_tx 保持为 emission.center_Hz 不变（DDC 的缺省 f_shift 与显示都在用它）；
  // 跳频只影响「最坏频偏」这一个派生量
  const worst = worstOffset(doc, String(emitter?.id ?? ''), f_tx, f_rx)

  // 判据与 compile.ts 的 active() 同源：只看 bypass 会在「组件不在目录里」与「回放模式下不适用」
  // 这两种情形下算出一个根本不存在的 fs_s4，而 compile 又拿它派生检测器频段（±0.45·fs_s4）。
  // cat 为 null 时 slotState 本来就跳过可用性那一支，行为与只看 bypass 完全一致。
  const ddcOn = slotState(chain, 'ddc', cat) === 'active'
  const decim = ddcOn ? Math.max(1, Math.round(num(chain.slots.ddc.params.decim, 1))) : 1
  // 缺省把目标搬到 S4 零频附近；用户可改成任意值以演示「目标不在观测中心」
  const f_shift = ddcOn
    ? (chain.slots.ddc.params.f_shift_Hz !== undefined ? num(chain.slots.ddc.params.f_shift_Hz) : f_tx - f_rx)
    : 0
  const fs_s4 = decim > 0 ? fs_rf / decim : 0
  const rxFltOn = slotState(chain, 'rx_flt', cat) === 'active'
  const chanOn = slotState(chain, 'chan', cat) === 'active'
  const channels = chanOn ? Math.max(1, Math.round(num(chain.slots.chan.params.channels, 8))) : 1
  // 缺省是零频那一路（`channels/2`，与 S4 中心重合）。这是 M-3 对 10 §3.7 的修正：
  // 按低→高编号 j = 0 指的是带边那一路，合法但作缺省最差（D-071 ⑧）。
  const select = chanOn
    ? (chain.slots.chan.params.select_channel !== undefined
        ? Math.round(num(chain.slots.chan.params.select_channel))
        : Math.floor(channels / 2))
    : 0
  const fs_s5 = channels > 0 ? fs_s4 / channels : 0
  const f_s4 = f_rx + f_shift

  return {
    fs_rf, f_rx, f_tx, bw_tx,
    df_max: worst.df, df_max_where: worst.where,
    decim, f_shift,
    fs_s4, f_s4,
    channels, fs_s5,
    select,
    f_s5: chanOn ? f_s4 + (select - channels / 2) * fs_s5 : f_s4,
    centers: centerSet(doc, String(emitter?.id ?? ''), f_tx),
    bw_rx: rxFltOn
      ? (chain.slots.rx_flt.params.bw_Hz !== undefined
          ? num(chain.slots.rx_flt.params.bw_Hz)
          : num(((site?.receiver ?? {}) as Record<string, unknown>).bw_Hz))
      : 0,
    guard: GUARD_FRACTION * fs_rf,
  }
}

/**
 * 全部中心频点相对某个参照点的**最坏**偏移。参照点是 S4 中心时它退化成原来那条
 * `max(|f_tx − f_rx − f_shift|, df_max − |f_shift|)`；参照 S5 本路中心时也是同一个式子，
 * 只是换了参照 —— 这正是 `centers` 要留在计划里的理由（C-10）。
 */
function worstOffsetTo(plan: FreqPlan, ref: number): number {
  let d = 0
  for (const c of plan.centers) d = Math.max(d, Math.abs(c - ref))
  return d
}

/** 回放模式不看场景（防线二、三），与 freqPlan 同一口径。 */
/** 场景文件的 `aoi.id`——E3 要的建筑几何就放在这个观测区域的数据包里（docs/scene-package.md §3.1）。 */
function aoiIdOf(doc: ScenarioDoc | null): string {
  const aoi = doc?.aoi as Record<string, unknown> | undefined
  return typeof aoi?.id === 'string' ? aoi.id : ''
}

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
export function planChecks(chain: ChainState, plan: FreqPlan, scenario: ScenarioDoc | null = null,
                          cat: Catalog | null = null, scene: SceneSummaryLite | null = null): PlanCheck[] {
  // 与 freqPlan 同一判据：旁路、未实现、回放不适用三种情形都算「没参与计算」
  const ddcActive = slotState(chain, 'ddc', cat) === 'active'
  const chanActive = slotState(chain, 'chan', cat) === 'active'
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

    const need = plan.df_max + plan.bw_tx / 2 + plan.guard
    out.push({
      id: 'edge',
      label: '目标不跨频带边缘',
      ok: plan.fs_rf > 0 && need < plan.fs_rf / 2,
      detail: plan.df_max_where
        ? `最坏跳频点 ${plan.df_max_where}：|Δf| + B/2 + 保护带 = ${fmt(need)}，须小于 Fs/2 = ${fmt(plan.fs_rf / 2)}`
        : `|Δf| + B/2 + 保护带 = ${fmt(need)}，须小于 Fs/2 = ${fmt(plan.fs_rf / 2)}`,
    })

    // 两件事：能整除（引擎的 configure 也查这一条），以及**取值在冻结抽头表的档位里**
    // ——表外的 decim 没有系数可用，引擎会拒整次运行，前端先说清楚（C-10）。
    const ddcVer = firVersionOf(chain, 'ddc', cat)
    const divides = plan.decim >= 1 && plan.fs_rf > 0 && Math.abs(plan.fs_rf % plan.decim) < 1e-9
    const decimOnGrid = onGrid(ddcVer, plan.decim)
    const decimOk = divides && decimOnGrid
    out.push({
      id: 'decim',
      label: '抽取比例合法',
      ok: !ddcActive || decimOk,
      detail: !ddcActive
        ? 'DDC 未参与计算，S4 与宽带同采样率'
        : `抽取 ${plan.decim} 倍后 S4 = ${fmt(plan.fs_s4)}`
          + (divides ? '' : '；采样率须能被抽取比整除')
          + (decimOnGrid ? '' : `；抽取比须取 ${gridText(ddcVer)}`),
    })

    // 过渡带：|Δf − f_shift| + B/2 ≤ 通带边缘，跳频时抽取后的通带必须装得下**全部**跳频点，
    // 否则跳到带外的那几跳会被抗混叠滤波器吃掉。
    // **通带边缘按 `fir_version` 从冻结表的规格来**（C-10），不再是写死的 0.4 ——
    // 换一版抽头就换一个数，写死会让检查与实际用的滤波器脱节（`firSpecs.ts` 有对拍闸）。
    const edgeS4 = passbandEdgeHz(ddcVer, plan.fs_s4)
    const inband = worstOffsetTo(plan, plan.f_s4) + plan.bw_tx / 2
    out.push({
      id: 'transition',
      label: '滤波器过渡带足够',
      ok: !ddcActive || (edgeS4 !== null && inband <= edgeS4),
      detail: !ddcActive
        ? 'DDC 未参与计算，不涉及抗混叠滤波'
        : edgeS4 === null
          ? `抽头版本 ${ddcVer ?? '（未选）'} 的通带边缘取不到，算不出`
          : `目标落在 S4 的 ±${fmt(inband)}，通带边缘 ${fmt(edgeS4)}`,
    })

    // 接收滤波（C-10）：`bw_rel = bw_Hz / fs_in` 必须落在冻结抽头表的档位里。
    // **引擎要到第一块才查得了表**（采样率在块元数据里），那时任务已经跑起来了、失败在半路；
    // 前端知道站点的采样率，所以能在提交之前就说清楚（08 §8 口径三的两侧分工）。
    const rxActive = slotState(chain, 'rx_flt', cat) === 'active'
    const bwRel = plan.fs_rf > 0 ? plan.bw_rx / plan.fs_rf : 0
    const rxOnGrid = onGrid('rx_v1', bwRel)
    out.push({
      id: 'rx_filter',
      label: '接收滤波通带可查表',
      ok: !rxActive || (plan.bw_rx > 0 && rxOnGrid),
      detail: !rxActive
        ? '接收滤波未参与计算，通道不做滤波'
        : plan.bw_rx > 0
          ? `通带 ${fmt(plan.bw_rx)} / 采样率 ${fmt(plan.fs_rf)} = ${bwRel.toFixed(3)}`
            + (rxOnGrid ? '，在抽头表内' : `；该比值须取 ${gridText('rx_v1')}，改站点的接收带宽`)
          : '站点没写接收带宽（sites[].receiver.bw_Hz），算不出',
    })

    // 信道化（M-3，D-071）：四件事一起看——档位、整除、路号范围、目标装不装得进本路。
    // **可用子带是 ±0.4·fs_s5 不是 ±0.5·fs_s5**：临界抽取下相邻子信道的过渡带折进本路外侧 20%
    // （模型卡 `models/channelizer/README.md` §8 第 1 条）。
    const chanVer = firVersionOf(chain, 'chan', cat)
    const edgeS5 = passbandEdgeHz(chanVer, plan.fs_s5)
    const chGrid = onGrid(chanVer, plan.channels)
    const chDiv = plan.channels >= 1 && plan.fs_s4 > 0 && Math.abs(plan.fs_s4 % plan.channels) < 1e-9
    const selOk = Number.isInteger(plan.select) && plan.select >= 0 && plan.select < plan.channels
    const why: string[] = []
    if (!chGrid) why.push(`子信道数须取 ${gridText(chanVer)}`)
    if (!chDiv) why.push('S4 采样率须能被子信道数整除')
    if (!selOk) why.push(`输出子信道须是 [0, ${plan.channels}) 内的整数，${Math.floor(plan.channels / 2)} 是零频那一路`)
    // **这三条是硬错（引擎的 configure 会拒整次运行），「目标装不装得进本路」不是。**
    // 选一路子信道本来就是一次有意的取舍——演示夹具 `chain-golden-02-chan` 选的正是
    // 「图传落进相邻子信道被压掉、跳频留在本路」那种配置。把「装不下」判成红叉，
    // 等于让界面替用户否掉一个合法而且正是要演示的配置（D-039：只摆事实，不替用户下结论）。
    // 所以装不装得下写在说明里当事实，不进 ok。
    const inbandS5 = worstOffsetTo(plan, plan.f_s5) + plan.bw_tx / 2
    const fits = edgeS5 !== null && inbandS5 <= edgeS5
    out.push({
      id: 'channelization',
      label: '信道化配置可行',
      ok: !chanActive || why.length === 0,
      detail: !chanActive
        ? '信道化未参与计算，S5 与 S4 同采样率'
        : why.length
          ? why.join('；')
          : `S5 = ${fmt(plan.fs_s5)} @ ${fmt(plan.f_s5)}，可用子带 ±${fmt(edgeS5 ?? 0)}`
            + `；目标占用落在本路的 ±${fmt(inbandS5)}`
            + (fits ? '，都在子带内' : '，超出的部分会被信道化滤掉'),
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

    // E3 要逐建筑几何（D3-7，07 §5.4 那张分工表的第一行）。前端查得到的是
    // 「场景引用的观测区域，与当前载入的数据包是不是同一个、里面有没有建筑」；
    // 引擎那一侧查 `<scene_root>/<aoi_id>/manifest.json` 的字节哈希，比这严。
    // 数据包还没载进来时不假装通过，也不假装失败——照实说在等（铁律 15）。
    if (pv.level === 'E3') {
      const aoiId = aoiIdOf(scenarioOf(chain, scenario))
      const feats = scene?.buildings.features ?? 0
      const ok = !!scene && !!aoiId && scene.id === aoiId && feats > 0
      out.push({
        id: 'prop_scene',
        label: 'E3 有观测区域建筑几何',
        ok,
        detail: !scene
          ? '观测区域数据包还没载入，E3 的建筑遮挡算不了'
          : !aoiId
          ? '场景文件里没有 aoi 段，指不出该用哪个观测区域的建筑几何'
          : scene.id !== aoiId
          ? `场景要的是观测区域 ${aoiId}，当前载入的是 ${scene.id}`
          : feats > 0
          ? `${scene.name}：${feats} 栋建筑`
          : `观测区域 ${scene.id} 的清单里没有建筑`,
      })
    }
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
