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

/** 十一个槽位，顺序即链路顺序（04 §5.1 的端到端对象加 D-053 的测向与定位）。 */
export type SlotId =
  | 'tx' | 'tx_ant' | 'ch' | 'rx_ant' | 'rx_fe' | 'adc' | 'ddc' | 'chan' | 'det'
  // D-053：尾部两个槽位。`df` 一站一个测向机，`loc` 全图唯一的融合节点
  | 'df' | 'loc'
  // C-4：挂在「检测识别评价」卡片里的两个槽位（10 报告 §2.1「固定三节点」）。它们不单独成卡，
  // 编译与反解照常按槽位走——这样 parse / compile / 参数归属 / 待填一件不用改，只有画法不同
  | 'feat' | 'rec'
  // C-10：接收滤波挂在「接收机前端」卡片里。它在链上排在前端**之前**（见 SLOTS 里的说明），
  // 但属于接收机这一环，所以不另立一张卡
  | 'rx_flt'
  // C-5：卡片里的第三个子环节——真值与评价（10 报告 §4.5）
  | 'eval'

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
  /**
   * 绑定到场景的哪种对象；不绑定为 null。
   * `link` 表示**同时**绑源与站（D-053）：`SceneBoundChannel` 既要知道是哪个源（发射功率、波形），
   * 又要知道是哪个站（接收天线增益）。只在场景确实有多个站时才写 `site_id`——
   * 单站场景里组件自己取唯一站，既有框图因此逐字节不变。
   */
  bind?: 'emitter' | 'site' | 'link'
  /** 恒定参数：由模板决定、用户不可改 */
  fixed?: Record<string, ParamValue>
  /** 卡片正文显示哪几个参数 */
  summary: string[]
}

/**
 * 槽位在哪个维度上实例化（D-053，11 报告 §2.1）。
 * `emitter` 一源一份、`link` 一条 (源, 站) 链路一份、`site` 一站一份、`single` 全图唯一。
 * 辐射源按**源**而不是按链路实例化：同一个源发出的是同一份波形，若每条链路各生成一份，
 * 同一源在不同站的载波相位与突发时刻会各自独立，时差定位就失去物理意义。
 */
export type SlotPer = 'emitter' | 'link' | 'site' | 'single'

/**
 * 参数归谁（D-054）。**与 `per` 是两件事**：`per` 说编译出几个节点，`owner` 说这些节点的参数从哪取。
 *
 * `tx_ant` 与 `rx_ant` 正是两者分离的地方：节点按链路展开 N×K 份，但发射天线长在无人机上
 * （同一架机对 K 个站是同一副天线）、接收天线长在站上（同一个站对 N 个源是同一副天线）。
 * 按 `per` 取参数会让「改一架机的天线增益」变成「改一条链路的天线增益」，物理上讲不通。
 *
 * `shared` 是全图一套：传播信道（用户 2026-09-09 明确要求它不随实体选择变化）与多站定位。
 */
export type SlotOwner = 'emitter' | 'site' | 'shared'

/**
 * 代理参数（D-058，12 §5.3）。有些参数**用在别的节点上、却应该在这张卡片上配**。
 *
 * 传播效应就是这么一件事：用户要在「传播信道」卡片上选档位与效应，而计算落在帧生产端
 * （`ScenarioSource`，隐含节点 `scn`）——EM-P-01/02/05/08 属 M1/M2 参数供给层，
 * 「M3 不得绕过 M1/M2 自行硬编码传播参数」，`SceneBoundChannel` 只是 M3 的施加器。
 * 而且链路面板的「路损」读数取自帧生产端产出的 `link` 事件，算在信道里读数就名不副实。
 *
 * 参数因此**只声明一次**（在真正用它的组件上），这张表只说「显示在哪张卡片、编译到哪个节点」。
 */
export interface SlotProxy {
  /** 参数声明在哪个组件的目录条目里 */
  type: string
  /** 编译时写到哪个（隐含）节点的基名 */
  node: string
  /** 哪几个参数走代理 */
  params: readonly string[]
}

/**
 * 传播效应的代理参数集合（D-058）。**与 `ScenarioSource` 的 `ParamSpec` 逐名对应**，
 * 顺序即面板上的顺序（面板另按当前档位决定显隐）。
 */
export const PROPAGATION_PARAMS: readonly string[] = [
  'prop_level', 'prop_primary', 'prop_shadow', 'prop_weather', 'env_class',
  'ground_type', 'ground_roughness_m', 'coherence_rho', 'max_fade_depth_dB',
  'path_loss_exponent', 'ref_distance_m', 'urban_loss_mode',
  'shadow_sigma_dB', 'shadow_corr_distance_m', 'rain_rate_mmh',
]

export interface SlotDef {
  id: SlotId
  /** 环节名 */
  label: string
  /** 实例化维度；缺省 `site`（接收侧一站一份） */
  per?: SlotPer
  /** 参数归属维度（D-054）；缺省 `site` */
  owner?: SlotOwner
  /**
   * 变体由谁决定（D-057）。`'mode'` 表示它就是试验设置栏的**信号源模式**，
   * 卡片上因此**不给**变体下拉——同一件事两个入口，只会多一个操作口、把逻辑弄复杂
   * （用户 2026-09-09 指示）。卡片仍把当前变体的名字写出来，只是不可点。
   */
  variantFrom?: 'mode'
  /** 04 §5.1 里对应的环节措辞，鼠标悬停时显示 */
  hint: string
  variants: SlotVariant[]
  /** 可否旁路（只有 DDC 与信道化可以，10 报告 §2.5） */
  bypassable?: boolean
  /** 缺省是否旁路 */
  defaultBypass?: boolean
  /** 回放模式下不适用的槽位 */
  replayNotApplicable?: boolean
  /** 参数显示在本卡片、编译到别的节点（D-058） */
  proxy?: SlotProxy
  /**
   * 挂在哪个槽位的卡片里（C-4）。有它的槽位不在链条上单独成卡，而是作为宿主卡片里的一行子环节；
   * 点那一行选中的是本槽位，右栏照常给它的参数面板。编译、反解、参数归属都不看这个字段。
   */
  group?: SlotId
}

/** 槽位表。改这里就改了整条链，编译、反解与界面同时跟随。 */
export const SLOTS: readonly SlotDef[] = [
  {
    id: 'tx', label: '辐射源', hint: '辐射源复基带信号', per: 'emitter', owner: 'emitter',
    // 「场景辐射源」= 全合成 / 混合增强，「实测片段回放」= 实测回放：变体与模式本来就是同一件事
    variantFrom: 'mode',
    variants: [
      { type: 'SceneEmitterSource', node: 'tx', label: '场景辐射源', bind: 'emitter',
        fixed: { emit_at_tx_power: true }, summary: ['center_frequency_Hz', 'sample_rate_Hz'] },
      { type: 'FileReplaySource', node: 'tx', label: '实测片段回放', summary: ['data_id'] },
    ],
  },
  {
    id: 'tx_ant', label: '发射天线', hint: '发射特征与天线等效作用', per: 'link', owner: 'emitter',
    replayNotApplicable: true,
    variants: [
      { type: 'AntennaGain', node: 'tx_ant', label: '天线增益', fixed: { role: 'tx' },
        summary: ['pattern', 'gain_dBi', 'polarization'] },
    ],
  },
  {
    id: 'ch', label: '传播信道', hint: '传播损耗、时延、多径、多普勒', per: 'link', owner: 'shared',
    replayNotApplicable: true,
    // 传播效应档位与逐项开关配在这张卡片上，编译到隐含节点 scn（D-058）
    proxy: { type: 'ScenarioSource', node: 'scn', params: PROPAGATION_PARAMS },
    // **只有一个变体**（D-059）。`FreeSpaceChannel`（定参自由空间）本来是第二个，2026-09-10 撤掉：
    // 它要用户手填一个固定距离，而这个页面上**能跑起来的配置一定有场景**——回放模式下本环节整个
    // 不适用，全合成与混合增强都必须选中场景、站点与目标才通得过频率计划检查。也就是说它在这里
    // 永远是错的选择，摆着就是个陷阱（用户 2026-09-10：「手填一个固定值完全没有必要」）。
    // 组件本身保留：它是标准算例与解析锚点的对拍件，在自由画布与手写框图里照常可用。
    variants: [
      { type: 'SceneBoundChannel', node: 'ch', label: '场景绑定信道', bind: 'link',
        fixed: { gain_mode: 'path_loss_only' }, summary: ['delay_mode', 'apply_doppler'] },
    ],
  },
  {
    id: 'rx_ant', label: '接收天线', hint: '接收天线与馈线', per: 'link', owner: 'site',
    replayNotApplicable: true,
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
    // 接收滤波（C-10；组件 M-3 落地，D-071）。挂在前端卡片里，但**链上排在前端之前** ——
    // 前端注入的等效热噪声因此不被它整形，S2 的底噪仍是 −174 + nf + 10·log10(fs)，
    // 而那个等式有三处别的地方在依赖（频率计划的 adc_floor、模型卡、slice4 的 S2 断言）。
    // 缺省旁路：接上它会改变每一条既有链路的产品，而本期没有场景需要它（零基准变更）。
    // `bw_Hz` 由场景的 `sites[].receiver.bw_Hz` 逐站带出（FROM_SCENE，D-054）——
    // 那个字段自 G-2 起就被解析、校验，然后一直没有任何模型用它。
    id: 'rx_flt', label: '接收滤波', hint: '接收通道滤波（04 §7.5 与附录 A 的「滤波」）',
    group: 'rx_fe', bypassable: true, defaultBypass: true, replayNotApplicable: true,
    variants: [
      { type: 'RxFilter', node: 'rx_flt', label: '接收滤波', summary: ['bw_Hz', 'fir_version'] },
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
    // 缺省旁路（M-2，D-070）：组件已经落地，但把它接进缺省链会改变 demo-01 的产品、检测与
    // 评价基准，而 demo-01 是 500 kS/s、decim 只能取 1，抽取本来也无从谈起。缺省接线留给 C-10。
    id: 'ddc', label: 'DDC', hint: '数字下变频', bypassable: true, replayNotApplicable: true,
    defaultBypass: true,
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
      // 典型链路里的检测器永远跑滑动噪声估计（D-026：交付形态不得是静态门限；D-063），
      // 模板固定、卡片上写出来但不给改；probe 只在手写框图与黄金基准里出现。
      // 绑站只为把 site_id 注入检测行——多站下每站一个检测器，行里不带站就分不清是谁检出的（D-053）。
      { type: 'EnergyDetector', node: 'det', label: '能量检测', bind: 'site',
        fixed: { noise_mode: 'sliding' }, summary: ['nfft', 'pfa', 'noise_mode'] },
    ],
  },
  {
    // 特征提取（C-4，10 报告 §4.3）：挂在检测识别评价卡片里，一站一份，吃 S4 尾的 IQ 与本站检测器的行。
    // nfft 与 merge_gap_frames 由检测器**派生**（必须相等，装载器再核对一遍），用户只在检测器那一行填。
    id: 'feat', label: '特征提取', hint: '按突发提取特征（EM-S-03）', group: 'det',
    variants: [
      { type: 'FeatureExtractor', node: 'feat', label: '特征提取', bind: 'site',
        summary: ['bandwidth_method', 'noise_gate', 'window_frames'] },
    ],
  },
  {
    // 模板匹配识别（C-4，10 报告 §4.4）：吃本站的特征行，出 signal_role 层的标签。
    // 模板库版本是用户参数，库文件位置由装载器注入（D-037 同法）。
    id: 'rec', label: '模板识别', hint: '模板加权匹配识别（EM-S-04 E2）', group: 'det',
    variants: [
      { type: 'TemplateClassifier', node: 'rec', label: '模板匹配识别', bind: 'site',
        summary: ['library_version', 'accept_threshold', 'min_quality'] },
    ],
  },
  {
    // 真值与评价（C-5，10 报告 §4.5）：挂在检测识别评价卡片里的第三个子环节，一站一份，吃本站检测行 + 识别行 + 全部链路帧。
    // 真值来源由信号源模式派生（全合成 / 混合 → 场景参数帧，回放 → 清单类别），nfft 随检测器，
    // data_id 随信号源（回放）或背景片段（混合）——都不让用户再填一遍（DERIVED_PARAMS）。
    id: 'eval', label: '评价', hint: '真值与评价：帧级 / 突发级检出、ROC、混淆矩阵', group: 'det',
    variants: [
      { type: 'Evaluator', node: 'eval', label: '真值与评价', bind: 'site',
        summary: ['truth_source', 'match_overlap', 'roc_points'] },
    ],
  },
  {
    // 测向不在 IQ 主链上：它吃的是链路参数帧，一站一个（D-053）。
    // 缺省旁路——单站演示里它没有增量，勾上多站才有意义。
    id: 'df', label: '测向', hint: '单站测向（EM-S-05 的 E2 效应模型，取真值按误差预算给量测）',
    per: 'site', bypassable: true, defaultBypass: true, replayNotApplicable: true,
    variants: [
      { type: 'DirectionFinder', node: 'df', label: '单站测向', bind: 'site',
        summary: ['method', 'sigma_method_deg', 'min_snr_dB'] },
    ],
  },
  {
    // 全图唯一的融合节点：吃 K 路测向报告（与到达时间报告）出一个位置解。
    // 缺省旁路——它至少要两个站，单站演示里没有意义。
    id: 'loc', label: '多站定位', hint: '多站交叉定位与时差定位（EM-S-06 / EM-S-07）',
    per: 'single', owner: 'shared', bypassable: true, defaultBypass: true, replayNotApplicable: true,
    variants: [
      { type: 'MultiSiteLocator', node: 'loc', label: '多站定位',
        summary: ['method', 'min_crossing_angle_deg', 'weighting'] },
    ],
  },
]

export const SLOT_BY_ID: Readonly<Record<SlotId, SlotDef>> =
  Object.fromEntries(SLOTS.map((s) => [s.id, s])) as Record<SlotId, SlotDef>

/**
 * 观测点在链上的锚点：优先挂第一个存在的槽位输出口。`s4` 另有兜底，见 compile。
 * `label` 是完整称呼，观测点一行、结果页页签、信号页头三处共用同一套名字。
 */
export const TAP_ANCHOR: Readonly<Record<TapId, { slot: SlotId; label: string }>> = {
  s0: { slot: 'tx', label: 'S0 辐射源输出' },
  s1: { slot: 'rx_ant', label: 'S1 接收天线端' },
  s2: { slot: 'rx_fe', label: 'S2 前端输出' },
  s3: { slot: 'adc', label: 'S3 量化后' },
  s4: { slot: 'ddc', label: 'S4 主产品' },
  s5: { slot: 'chan', label: 'S5 子信道' },
}

export const TAP_ORDER: readonly TapId[] = ['s0', 's1', 's2', 's3', 's4', 's5']

/** 实例后缀分隔符（D-053）。节点 id 正则是 `[a-z0-9_-]`，`@` 与 `:` 都不合法；
 *  既有槽位 id 只用单下划线（`tx_ant` / `rx_fe`），双下划线因此可无歧义地切分。 */
export const INST_SEP = '__'

/**
 * 观测点的产品目录名。只有一个实例时不加后缀，于是单源单站的框图逐字节不变。
 * S0 挂在辐射源上（按源实例化），其余挂在接收侧（按站）。
 */
export function tapOpId(tap: TapId, inst: string, count: number): string {
  return count > 1 && inst ? `${tap}${INST_SEP}${inst}` : tap
}

/** 三处共用的显示名：`s4` → `S4 主产品`，`s4__site-2` → `S4 主产品 · site-2`；不是 S 点的照原样返回。 */
export function tapLabel(opId: string): string {
  const i = opId.indexOf(INST_SEP)
  const base = i < 0 ? opId : opId.slice(0, i)
  if (!(TAP_ORDER as readonly string[]).includes(base)) return opId
  const name = TAP_ANCHOR[base as TapId].label
  return i < 0 ? name : `${name} · ${opId.slice(i + INST_SEP.length)}`
}

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
  /** 共用底值：没有单独设置的实体都用它 */
  params: Record<string, ParamValue>
  /**
   * 逐实体覆盖（D-054）。键是站点 id 或辐射源 id，按 `SlotDef.owner` 决定是哪一种。
   * 空或缺席时整个槽位退回「一套参数」，编译结果与 D-053 时代逐字节相同。
   *
   * 这里**只有两层**。用户看到的「同型号共用」是第三层，但它不进状态：型号要查场景文档，
   * 而 `parseChain()` 只拿得到框图（自由画布那条路径上根本没有场景），把型号写进状态会让
   * 反解结果随「场景载没载入」变化，`compile(parseChain(doc)) === doc` 当场失效。
   * 型号因此是**编辑范围**——改一次写进同型号每个实体的覆盖里，见 `ChainView` 的范围选择器。
   */
  byEntity?: Record<string, Record<string, ParamValue>>
}

/** 链路视图的完整状态。它由 `parse()` 从框图解出，由 `compile()` 编译回框图。 */
export interface ChainState {
  diagram_id: string
  name: string
  mode: ChainMode
  /** 场景引用；回放模式为 null */
  scenario: { scenario_id: string; sha256: string } | null
  /**
   * 选中的站点与目标（D-053）。两者都是数组：K 个站各跑一条接收链，N 个源在接收天线后叠加。
   * N = K = 1 时编译出的框图与单源单站时代逐字节相同（节点不带后缀、无叠加节点）。
   */
  siteIds: string[]
  emitterIds: string[]
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

/** 槽位的参数归属维度（D-054）。缺省 `site`，与 `per` 的缺省一致。 */
export function ownerOf(id: SlotId): SlotOwner {
  return SLOT_BY_ID[id].owner ?? 'site'
}

/**
 * 这个槽位在某条 (源, 站) 链路上取谁的参数。`shared` 返回空串——全图一份，没有实体维度。
 * 编译与反解共用它，两处不会对不上。
 */
export function ownerEntity(id: SlotId, emitterId: string, siteId: string): string {
  switch (ownerOf(id)) {
    case 'emitter': return emitterId
    case 'site': return siteId
    default: return ''
  }
}

/** 这个槽位当前有哪些实体做过单独设置（按 id 排好序，便于确定性地遍历与显示）。 */
export function overriddenEntities(chain: ChainState, id: SlotId): string[] {
  return Object.keys(chain.slots[id].byEntity ?? {}).sort()
}

/**
 * 某个实体在这个槽位上的**有效参数** = 共用底值叠上它自己的覆盖。
 * `entityId` 为空（`shared` 槽位）时就是共用底值。
 */
export function effectiveParams(
  chain: ChainState, id: SlotId, entityId: string,
): Record<string, ParamValue> {
  const cfg = chain.slots[id]
  const over = entityId ? cfg.byEntity?.[entityId] : undefined
  return over ? { ...cfg.params, ...over } : { ...cfg.params }
}

/**
 * 一个参数当前的**设置范围**（D-054）：全部实体一致是 `shared`；按型号分组后组内一致、
 * 组间不同是 `model`；再不齐就是 `entity`。
 *
 * 它是**当场派生**的，不存状态。`modelOf` 由调用方传进来（要查场景文档），
 * 这个模块因此不依赖场景。
 */
export type ParamScope = 'shared' | 'model' | 'entity'

export function paramScope(
  chain: ChainState, id: SlotId, name: string,
  entities: readonly string[], modelOf: (entityId: string) => string,
): ParamScope {
  const byEnt = chain.slots[id].byEntity ?? {}
  const val = (e: string) => (name in (byEnt[e] ?? {}) ? byEnt[e]![name] : chain.slots[id].params[name])
  if (entities.length <= 1) return 'shared'
  const first = val(entities[0]!)
  if (entities.every((e) => val(e) === first)) return 'shared'
  const byModel = new Map<string, ParamValue | undefined>()
  for (const e of entities) {
    const m = modelOf(e)
    if (!byModel.has(m)) byModel.set(m, val(e))
    else if (byModel.get(m) !== val(e)) return 'entity'
  }
  return 'model'
}

/**
 * 把一个参数写到指定范围里，返回新的槽位配置（纯函数，D-054）。
 *
 * - `shared`：写共用底值，并把**所有**实体对该参数的覆盖清掉——否则改了共用值却看不出变化。
 * - `model` / `entity`：写进目标实体的覆盖。
 *
 * 清理后如果某个实体的覆盖空了，把它整条删掉；全空则删掉 `byEntity`。
 * 不这么收拾的话，框图里会留下 `"byEntity": {}` 这种空壳，往返就不逐字节了。
 */
export function writeParam(
  chain: ChainState, id: SlotId, name: string, v: ParamValue | undefined,
  scope: ParamScope, targets: readonly string[],
): SlotConfig {
  const cfg = chain.slots[id]
  const params = { ...cfg.params }
  const byEntity: Record<string, Record<string, ParamValue>> = {}
  for (const [k, o] of Object.entries(cfg.byEntity ?? {})) byEntity[k] = { ...o }

  if (scope === 'shared') {
    if (v === undefined) delete params[name]
    else params[name] = v
    for (const k of Object.keys(byEntity)) delete byEntity[k]![name]
  } else {
    for (const t of targets) {
      const o = (byEntity[t] ??= {})
      if (v === undefined) delete o[name]
      else o[name] = v
    }
  }
  for (const k of Object.keys(byEntity)) if (Object.keys(byEntity[k]!).length === 0) delete byEntity[k]
  const next: SlotConfig = { variant: cfg.variant, bypass: cfg.bypass, params }
  if (Object.keys(byEntity).length > 0) next.byEntity = byEntity
  return next
}

/**
 * 组件还没实现时给的理由，写在卡片上（不隐藏，隐藏会让人以为链路只有七段）。
 * 表里没有的组件走 `unavailableReason()` 的兜底——那多半不是「本期未实现」，
 * 而是应用服务的目录旧了（引擎重建过但服务没重启），说成「未实现」会把人引到错路上。
 */
// 只写事实（本期旁路、信号从哪里取），不写工具链与步骤号：界面上不出现 MATLAB（D-036），
// 也不向用户解释「还没做」（D-039 ②，用户 2026-09-13 要求去掉「未实现」标记）。
//
// 表眼下是空的：`Channelizer` 自 M-3（D-071）起进了组件目录，那一条随之删掉，不留死条目
// （同 D-057 的处置）。留着表本身是因为兜底那一支还在用，且下一个未实现的组件上来时有地方写。
export const UNAVAILABLE_REASON: Readonly<Record<string, string>> = {}

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
    siteIds: [],
    emitterIds: [],
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
  /** 场景当前能不能给出这个由场景带出的参数（D-054）；不传即一律按「给不出」看待 */
  sceneHas: (f: FromSceneParam) => boolean = () => false,
  /** 按哪个实体的有效参数判（D-064）：卡片与面板显示的是中栏下拉选中的那一条链，待填也按它算 */
  entityId = '',
): string[] {
  if (!cat) return []
  const v = variantOf(chain, id)
  const spec = findComponent(cat, v.type)
  if (!spec) return []
  const fixed = v.fixed ?? {}
  const derived = (DERIVED_PARAMS[id] ?? []).filter((n) => derivable.includes(n))
    // 由场景带出的那些同样不必用户填——**但只在场景真的给得出值时**（D-054）。
    // 无条件放行等于把「场景里没写天线增益」这件事咽掉，引擎那边才报「缺必填参数」，
    // 报错还指向组件而不是指向场景（铁律 15）。缺省判据是「给不出」，最保守的那一侧。
    .concat(fromSceneOf(id).filter(sceneHas).map((f) => f.name))
  const eff = effectiveParams(chain, id, entityId)
  const out: string[] = []
  for (const p of spec.params as ParamSpec[]) {
    if (!p.required || p.internal) continue
    if (p.name in fixed) continue
    if (derived.includes(p.name)) continue
    const val = eff[p.name]
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
  // 特征提取的分帧必须与检测器相同（10 §4.3）：从检测器派生，不在这里另填一份
  feat: ['nfft', 'merge_gap_frames'],
  // 评价器（C-5）：真值来源随信号源模式、nfft 随检测器、录音标识随信号源（回放）或背景（混合）
  eval: ['truth_source', 'nfft', 'data_id'],
}

/**
 * 由场景**逐实体**带出的组件参数（D-054）。
 *
 * 与 `DERIVED_PARAMS` 的区别有两点：那些由频率计划算出、全局一个值、只读；这些逐实体不同，
 * 而且**可以在框图页反向编辑**——编辑写的是场景文件，不是框图。
 *
 * 这么改是为了消掉两处真理源。在此之前 `ReceiverFrontEnd.nf_dB` 与站点的 `receiver.nf_dB`、
 * `AntennaGain.gain_dBi` 与站点／无人机的天线增益各存各的，只是碰巧填了相同的值；
 * demo-03 的 `uav-3` 就没碰巧——场景里它是 0 dBi 而链路里被迫跟着别人用 2 dBi。
 *
 * `rel` 是 `deviceFields.ts` 里的相对路径，两边指的是同一个字段。
 */
export interface FromSceneParam {
  /** 组件参数名 */
  name: string
  /** 取场景里的哪个实体：`emitter` 或 `site`，与槽位的 `owner` 一致 */
  from: 'emitter' | 'site'
  /** 相对实体根的点路径 */
  rel: string
}

export const FROM_SCENE: Partial<Record<SlotId, FromSceneParam[]>> = {
  tx_ant: [{ name: 'gain_dBi', from: 'emitter', rel: 'emission.antenna_gain_dBi' }],
  rx_ant: [{ name: 'gain_dBi', from: 'site', rel: 'antenna.gain_dBi' }],
  rx_fe: [{ name: 'nf_dB', from: 'site', rel: 'receiver.nf_dB' }],
  // C-10：接收滤波的通带由场景逐站带出。`sites[].receiver.bw_Hz` 自 G-2 起就在格式里、
  // 被引擎解析与校验，`RxFilter` 是它的第一个消费者（D-071 ⑩）
  rx_flt: [{ name: 'bw_Hz', from: 'site', rel: 'receiver.bw_Hz' }],
}

/** 这个槽位有没有由场景带出的参数；有的话是哪几个。 */
export function fromSceneOf(id: SlotId): FromSceneParam[] {
  return FROM_SCENE[id] ?? []
}

/**
 * 撤掉的变体（D-059）。框图页不再提供它们，但**手写框图与自由画布里仍然合法**，
 * 所以 `parseChain()` 解到这类节点时会返回 null、界面落到「不是典型链路」那条路上。
 * 光说「不是典型链路」用户会以为自己的框图坏了，所以这里记下缘由，由界面照实说明。
 */
export const RETIRED_VARIANTS: Readonly<Record<string, string>> = {
  FreeSpaceChannel: '「自由空间（定参）」信道要手填固定距离，而框图页上能跑的配置一定有场景'
    + '（距离由航迹每秒重算 20 次），它在这里永远是错的选择，2026-09-10 撤掉（D-059）。'
    + '这份框图在自由画布里照常打开与运行',
}

/** 这份框图里有没有已撤掉的变体；有的话给出说明。 */
export function retiredNote(types: readonly string[]): string | null {
  for (const t of types) if (RETIRED_VARIANTS[t]) return RETIRED_VARIANTS[t]!
  return null
}

/** 这个槽位有没有代理参数（D-058）。 */
export function proxyOf(id: SlotId): SlotProxy | undefined {
  return SLOT_BY_ID[id].proxy
}

/** 挂在这个槽位卡片里的子环节（C-4），按链路顺序。 */
export function groupMembers(id: SlotId): SlotDef[] {
  return SLOTS.filter((d) => d.group === id)
}

/** 链条上单独成卡的槽位（有 `group` 的挂在宿主卡片里）。 */
export const GRID_SLOTS: readonly SlotDef[] = SLOTS.filter((d) => !d.group)

/** 把一份参数按代理集合切成两半：`proxy` 走代理节点，`own` 留在本槽位的节点上。 */
export function splitProxy(
  id: SlotId, params: Record<string, ParamValue>,
): { own: Record<string, ParamValue>; proxy: Record<string, ParamValue> } {
  const px = proxyOf(id)
  if (!px) return { own: { ...params }, proxy: {} }
  const set = new Set(px.params)
  const own: Record<string, ParamValue> = {}
  const proxy: Record<string, ParamValue> = {}
  for (const [k, v] of Object.entries(params)) {
    if (set.has(k)) proxy[k] = v
    else own[k] = v
  }
  return { own, proxy }
}

const ALL_DERIVED: readonly string[] = Object.values(DERIVED_PARAMS).flat()
