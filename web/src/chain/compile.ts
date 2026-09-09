// 典型链路 ↔ 标准框图的编译与反解（06 备忘录 §9G C-7、§9H L-2；10 报告 §5、§6.2；11 报告 §2；决策 D-051、D-053）。
//
// `compile()` 把槽位状态编译成一份满足 `docs/diagram-format.md` 的普通框图；`parseChain()` 反着来。
// 引擎与服务端因此完全不需要知道「典型链路」这回事——它们看到的永远是一张普通框图，
// 校验、运行、产品、补取全部沿用 B 线（10 报告 §0 第 3 条）。
//
// 三个不变量，由单测守：
//   ① `compile(parseChain(doc)) === doc` 逐字节（对本模块自己产出的框图）；
//   ② 节点 id 固定，引擎报错的 `node_id` 因此能反查回槽位并高亮那张卡片；
//   ③ **N = K = 1 时不出现任何实例后缀、不出现叠加节点**，于是单源单站的框图逐字节不变（D-053 §2.4）。
//
// 编译时故意**不写与目录缺省相同的参数**：`serialize()` 会再剔一次，两处一致即可保证
// 「目录缺省值变了、既有框图自动跟随」（09 §6.10 的第二条硬要求）。

import type { Catalog } from '../api/catalog.js'
import { findComponent } from '../api/catalog.js'
import type { DiagramDoc, DiagramEdge, DiagramNode, ObservationPoint, ParamValue } from '../diagram/doc.js'
import { SCHEMA_VERSION } from '../diagram/doc.js'
import type { ScenarioDoc } from '../state/types.js'
import { emitters as sceneEmitters, sites as sceneSites } from '../scene/editor/scenarioOps.js'
import { readField } from '../scene/editor/deviceFields.js'
import {
  INST_SEP, SLOTS, SLOT_BY_ID, TAP_ANCHOR, TAP_ORDER, TEMPLATE_ID, TEMPLATE_VERSION,
  effectiveParams, emptyChain, fromSceneOf, ownerEntity, slotState, tapOpId, variantOf,
  type ChainMode, type ChainState, type SlotId, type SlotPer, type TapId,
} from './model.js'
import { freqPlan } from './plan.js'

/** 编译结果里每个节点属于哪个槽位；界面据此把引擎报错反查回卡片。 */
export type NodeSlotMap = Record<string, SlotId | 'scn' | 'sup' | 'toa' | 'mix' | 'bg'>

/** 观测点最终挂在哪个节点的哪个口；`inst` 是实例标识（S0 是源、其余是站），单实例时为空。 */
export interface TapPlacement { inst: string; node: string; port: string }

export interface CompileResult {
  doc: DiagramDoc
  nodeSlot: NodeSlotMap
  /** 实际参与计算的槽位，按链路顺序 */
  activeSlots: SlotId[]
  /** 每个观测点的全部实例；不可用的观测点不在表里 */
  tapAt: Partial<Record<TapId, TapPlacement[]>>
}

const SCN = 'scn'
const SUP = 'sup'
const TOA = 'toa'
const MIX = 'mix'
const BG = 'bg'

/** 隐含节点与槽位共用的 id 前缀表，`parseChain` 按它切分实例后缀。 */
const IMPLICIT_BASES = [SCN, SUP, TOA, MIX, BG] as const

function round(v: number): number {
  return Math.round(v)
}

/**
 * 实例化的节点 id：只有**取值多于一个**的维度才加后缀（D-053 §2.3）。
 * 链路维度的后缀顺序固定为「源在前、站在后」——按「先分源、再分站」读起来与图的形状一致。
 */
export function nodeId(base: string, ...parts: Array<{ id: string; many: boolean }>): string {
  let s = base
  for (const p of parts) if (p.many) s += INST_SEP + p.id
  return s
}

/** 把实例化的节点 id 切回基名。基名表由槽位表与隐含节点给出，因此不必猜实例部分怎么分段。 */
export function splitNodeId(id: string): { base: string; rest: string } | null {
  const bases = new Set<string>(IMPLICIT_BASES as readonly string[])
  for (const def of SLOTS) for (const v of def.variants) bases.add(v.node)
  // 长的基名优先：'tx_ant' 与 'tx' 都在表里，而 'tx_ant__x' 不以 'tx__' 开头，两者不会混
  const sorted = [...bases].sort((a, b) => b.length - a.length)
  for (const b of sorted) {
    if (id === b) return { base: b, rest: '' }
    if (id.startsWith(b + INST_SEP)) return { base: b, rest: id.slice(b.length + INST_SEP.length) }
  }
  return null
}

/**
 * 编译。`cat` 用来判断组件是否已实现（没实现的槽位跳过）与剔除缺省参数；
 * `scenario` 用来带出场景派生的参数。两者都可以为 null，此时按已填的值尽力编译。
 */
export function compile(chain: ChainState, cat: Catalog | null, scenario: ScenarioDoc | null): CompileResult {
  const plan = freqPlan(chain, scenario)
  const nodes: DiagramNode[] = []
  const edges: DiagramEdge[] = []
  const nodeSlot: NodeSlotMap = {}
  const activeSlots: SlotId[] = []
  const scenarioId = chain.scenario?.scenario_id ?? null
  const total = plan.fs_rf > 0 ? round(chain.run.duration_s * plan.fs_rf) : 0

  const hasScene = chain.mode !== 'replay' && !!scenarioId
    && chain.siteIds.length > 0 && chain.emitterIds.length > 0
  const sitesSel = hasScene ? chain.siteIds : ['']
  const emsSel = hasScene ? chain.emitterIds : ['']
  const manySites = sitesSel.length > 1
  const manyEms = emsSel.length > 1

  const push = (
    id: string, type: string, params: Record<string, ParamValue>,
    slot: SlotId | 'scn' | 'sup' | 'toa' | 'mix' | 'bg', bind?: DiagramNode['scene_binding'],
  ): void => {
    const spec = cat ? findComponent(cat, type) : null
    // 键序取**目录里的参数顺序**，目录之外的按名排在后面。
    // 不这样做的话，「新建的链」与「反解回来的链」写出的键序不同，往返就不是逐字节相同了
    // ——这条是被 compile(parseChain(doc)) === doc 的单测逼出来的。
    const order = new Map<string, number>()
    spec?.params.forEach((p, i) => order.set(p.name, i))
    const keys = Object.keys(params).sort((a, b) => {
      const ia = order.has(a) ? order.get(a)! : Number.MAX_SAFE_INTEGER
      const ib = order.has(b) ? order.get(b)! : Number.MAX_SAFE_INTEGER
      return ia === ib ? a.localeCompare(b) : ia - ib
    })
    const out: Record<string, ParamValue> = {}
    for (const k of keys) {
      const v = params[k]
      if (v === undefined || v === '') continue
      const ps = spec?.params.find((p) => p.name === k)
      // 这个组件不认识的参数一律不写。槽位的参数是**按槽位**存的，换了变体（辐射源由
      // 「场景辐射源」换成「实测片段回放」、信道由场景绑定换成自由空间）之后，上一个变体的
      // 参数还留在状态里；照原样写进去，引擎装载时报 `param 未知参数`，而报文指向的是
      // 用户刚选的那个组件，看不出问题出在换变体上（2026-09-09 用户实测撞到）。
      // 不写 ≠ 丢弃：它们仍留在链路状态里，换回原变体即恢复。目录还没到手（spec 为 null）时
      // 不做这个判断——那时候不知道谁认识谁，宁可原样写出去让引擎去判。
      if (spec && !ps) continue
      // 与目录缺省相同的不写：目录缺省变了，既有框图自动跟随
      if (ps && ps.default !== undefined && ps.default !== null && ps.default === v) continue
      out[k] = v
    }
    nodes.push(bind ? { id, type, params: out, scene_binding: bind } : { id, type, params: out })
    nodeSlot[id] = slot
  }

  let e = 0
  const link = (from: string, fromPort: string, to: string, toPort: string): void => {
    edges.push({ id: `e${++e}`, from: { node: from, port: fromPort }, to: { node: to, port: toPort } })
  }

  /**
   * 场景绑定的三态（D-053）：绑源、绑站、或两者都绑。
   * 两者都绑只用在 `SceneBoundChannel` 上——它既要知道是哪个源（发射功率、波形），
   * 又要知道是哪个站（接收天线增益）。装载器那边有一道闸：目录没同时声明两个内部参数就拒绝。
   */
  // 场景里到底有几个站——不是**选了**几个。信道要不要写 site_id 由它决定：
  // 场景只有一个站时组件自己取唯一站（旧行为），既有框图逐字节不变；
  // 场景有多个站时，哪怕这次只选了一个，也必须写清楚是哪一个，否则引擎报错。
  const sceneSiteCount = Array.isArray(scenario?.sites) ? scenario!.sites.length : 0
  const bindOf = (
    kind: 'emitter' | 'site' | 'link' | undefined, emitterId: string, siteId: string,
  ): DiagramNode['scene_binding'] => {
    if (!kind || !scenarioId || !hasScene) return undefined
    if (kind === 'site') return { scenario_id: scenarioId, site_id: siteId }
    if (kind === 'link' && sceneSiteCount > 1 && siteId) {
      return { scenario_id: scenarioId, entity_id: emitterId, site_id: siteId }
    }
    return { scenario_id: scenarioId, entity_id: emitterId }
  }

  /**
   * 某个槽位在某条 (源, 站) 链路上要写的参数（D-054）。
   * 按 `owner` 取实体，叠上该实体的单独设置；`shared` 槽位（传播信道、多站定位）取共用底值。
   */
  const slotParams = (id: SlotId, emitterId = '', siteId = ''): Record<string, ParamValue> => {
    const v = variantOf(chain, id)
    const params: Record<string, ParamValue> = {
      ...effectiveParams(chain, id, ownerEntity(id, emitterId, siteId)),
      ...(v.fixed ?? {}),
    }
    // 派生参数：一处填、多处派生（10 报告 §2.4）
    if (id === 'tx' && v.type === 'SceneEmitterSource') {
      params.sample_rate_Hz = plan.fs_rf
      params.total_samples = total
      params.center_frequency_Hz = plan.f_rx
    }
    // 由场景逐实体带出的参数（D-054）：真理源在场景文件，框图只是它的投影。
    // 取不到就**不写**，让它照常落进「待填」——拿默认值顶替会让链路预算悄悄用上一个假增益（铁律 15）。
    for (const f of fromSceneOf(id)) {
      const ent = f.from === 'emitter'
        ? sceneEmitters(scenario).find((x) => String(x.id) === emitterId)
        : sceneSites(scenario).find((x) => String(x.id) === siteId)
      const val = readField(ent, f.rel)
      if (typeof val === 'number' && Number.isFinite(val)) params[f.name] = val
    }
    if (id === 'ch' && v.type === 'FreeSpaceChannel') params.frequency_Hz = plan.f_tx
    if (id === 'ddc') { params.f_shift_Hz = plan.f_shift; params.decim = plan.decim }
    if (id === 'chan') params.channels = plan.channels
    if (chain.run.block_size !== undefined && 'block_samples' in params) delete params.block_samples
    return params
  }

  const active = (id: SlotId): boolean => slotState(chain, id, cat) === 'active'
  // 时差定位要到达时间量测；只做交叉定位时不插这个隐含节点
  const locMethod = String(chain.slots.loc.params.method ?? 'aoa')
  const needToa = active('loc') && locMethod !== 'aoa'
  const seen = new Set<SlotId>()
  const markActive = (id: SlotId): void => { if (!seen.has(id)) { seen.add(id); activeSlots.push(id) } }
  const tapAt: Partial<Record<TapId, TapPlacement[]>> = {}
  const addTap = (t: TapId, inst: string, node: string, port: string): void => {
    (tapAt[t] ??= []).push({ inst, node, port })
  }

  // ---------------------------------------------------------------- 隐含节点：场景参数源
  // 一站一个。`report_entities` 只在第一个上开，否则 K 份重复的实体事件会把 track.jsonl
  // 撑成 K 倍并让前端画 K 遍（11 报告 §2.2 第 4 条）。
  if (hasScene) {
    sitesSel.forEach((s, i) => {
      const params: Record<string, ParamValue> = {
        sample_rate_Hz: plan.fs_rf,
        total_samples: total,
        update_rate_Hz: 20,
      }
      if (i > 0) params.report_entities = false
      push(nodeId(SCN, { id: s, many: manySites }), 'ScenarioSource', params, 'scn',
           { scenario_id: scenarioId!, site_id: s })
    })
  }

  // ---------------------------------------------------------------- 辐射源：一源一份波形
  // 同一个源发出的是同一份波形，扇出到全部 K 个站；每条链路各生成一份会让时差定位失去物理意义。
  const txNodeOf = new Map<string, string>()
  if (active('tx')) {
    const v = variantOf(chain, 'tx')
    for (const em of emsSel) {
      const id = nodeId(v.node, { id: em, many: manyEms })
      push(id, v.type, slotParams('tx', em, sitesSel[0]!), 'tx', bindOf(v.bind, em, sitesSel[0]!))
      txNodeOf.set(em, id)
      markActive('tx')
      if (TAP_ANCHOR.s0.slot === 'tx') addTap('s0', manyEms ? em : '', id, 'out')
    }
  }

  // ---------------------------------------------------------------- 每站一条接收链
  const LINK_SLOTS: SlotId[] = ['tx_ant', 'ch', 'rx_ant']
  const SITE_SLOTS: SlotId[] = ['rx_fe', 'adc', 'ddc', 'chan']

  for (const site of sitesSel) {
    // 每源一条前段支路
    const branchEnds: Array<{ node: string; port: string }> = []
    for (const em of emsSel) {
      let cur = txNodeOf.get(em) ? { node: txNodeOf.get(em)!, port: 'out' } : null
      for (const id of LINK_SLOTS) {
        if (!active(id)) continue
        const v = variantOf(chain, id)
        const nid = nodeId(v.node, { id: em, many: manyEms }, { id: site, many: manySites })
        push(nid, v.type, slotParams(id, em, site), id, bindOf(v.bind, em, site))
        markActive(id)
        if (cur) link(cur.node, cur.port, nid, 'in')
        if (hasScene && (v.type === 'AntennaGain' || v.type === 'SceneBoundChannel')) {
          link(nodeId(SCN, { id: site, many: manySites }), `link:${em}`, nid, 'scene')
        }
        cur = { node: nid, port: 'out' }
      }
      if (cur) branchEnds.push(cur)
    }

    // 多源：在接收天线之后、前端之前叠加成一路（11 报告 §2.2 第 3 条）
    let cursor: { node: string; port: string } | null = branchEnds[0] ?? null
    if (branchEnds.length > 1) {
      const supId = nodeId(SUP, { id: site, many: manySites })
      push(supId, 'Superposition', {}, 'sup')
      branchEnds.forEach((b, i) => link(b.node, b.port, supId, `in${i + 1}`))
      cursor = { node: supId, port: 'out' }
    }
    // S1「接收天线端」是叠加之后的那一点：接收机看到的就是各源之和
    if (cursor && TAP_ANCHOR.s1.slot === 'rx_ant') {
      addTap('s1', manySites ? site : '', cursor.node, cursor.port)
    }

    for (const id of SITE_SLOTS) {
      if (!active(id)) continue
      const v = variantOf(chain, id)
      const nid = nodeId(v.node, { id: site, many: manySites })
      push(nid, v.type, slotParams(id, emsSel[0]!, site), id, bindOf(v.bind, emsSel[0]!, site))
      markActive(id)
      if (cursor) link(cursor.node, cursor.port, nid, 'in')
      cursor = { node: nid, port: 'out' }
      for (const t of TAP_ORDER) {
        if (t !== 's1' && TAP_ANCHOR[t].slot === id) addTap(t, manySites ? site : '', nid, 'out')
      }
    }

    // 混合增强：背景回放在 S4 处与合成目标相加（只在单站下允许，见 plan.ts 的 stations 检查）
    if (chain.mode === 'mixed' && chain.backgroundDataId && cursor) {
      push(BG, 'FileReplaySource', { data_id: chain.backgroundDataId }, 'bg')
      push(MIX, 'AddMixer', {}, 'mix')
      link(cursor.node, cursor.port, MIX, 'a')
      link(BG, 'out', MIX, 'b')
      cursor = { node: MIX, port: 'out' }
    }

    // S4 兜底：DDC 未启用（旁路或未实现）时，主产品就落在链尾（10 报告 §2.3）
    if (cursor) {
      tapAt.s4 = (tapAt.s4 ?? []).filter((x) => x.inst !== (manySites ? site : ''))
      addTap('s4', manySites ? site : '', cursor.node, cursor.port)
    }

    if (cursor && active('det')) {
      const v = variantOf(chain, 'det')
      const nid = nodeId(v.node, { id: site, many: manySites })
      // 频段由 S4（或 S5）的采样率派生。算不出来时（回放模式没有场景）**不覆盖用户填的值**：
      // 拿 0 顶替会让引擎收到「频段上下限颠倒」，报错指向检测器而不是指向真正缺的那一项（铁律 15）。
      const half = plan.fs_s5 > 0 ? plan.fs_s5 : plan.fs_s4
      const band: Record<string, ParamValue> = half > 0
        ? { band_lo_Hz: -0.45 * half, band_hi_Hz: 0.45 * half } : {}
      push(nid, v.type, { ...slotParams('det', emsSel[0]!, site), ...band }, 'det')
      link(cursor.node, cursor.port, nid, 'in')
      markActive('det')
    }

    // 测向不在 IQ 主链上：它吃的是本站对每个源的链路参数帧（D-053 §2.2）。
    // 一个源一个 scene 口，顺序与 emitterIds 一致；身份靠帧自带的 site_id / emitter_id，
    // 不靠端口序号，所以端口顺序变了也不会算错。
    if (hasScene && active('df')) {
      const v = variantOf(chain, 'df')
      const nid = nodeId(v.node, { id: site, many: manySites })
      push(nid, v.type, slotParams('df', emsSel[0]!, site), 'df', bindOf(v.bind, emsSel[0]!, site))
      markActive('df')
      emsSel.forEach((em, i) => {
        link(nodeId(SCN, { id: site, many: manySites }), `link:${em}`, nid, `scene${i + 1}`)
      })
    }

    // 到达时间是**隐含节点**：只在多站定位启用且方法含时差时出现，用户不选也不配参数
    // ——时差定位的到达时间只应该有一种口径（D-053 §3.3）。
    if (hasScene && needToa) {
      const nid = nodeId(TOA, { id: site, many: manySites })
      push(nid, 'ToaEstimator', {}, 'toa',
           { scenario_id: scenarioId!, site_id: site })
      emsSel.forEach((em, i) => {
        link(nodeId(SCN, { id: site, many: manySites }), `link:${em}`, nid, `scene${i + 1}`)
      })
    }
  }

  // ---------------------------------------------------------------- 多站定位
  // 全图唯一的融合节点：吃 K 路测向报告出一个位置解（D-053 §2.2）。
  // 它不绑场景——站址随测向报告走，所以这里只连线不给绑定。
  if (hasScene && active('loc')) {
    const v = variantOf(chain, 'loc')
    push(v.node, v.type, slotParams('loc'), 'loc')
    markActive('loc')
    sitesSel.forEach((site, i) => {
      if (active('df')) {
        const df = variantOf(chain, 'df')
        link(nodeId(df.node, { id: site, many: manySites }), 'out', v.node, `b${i + 1}`)
      }
      if (needToa) link(nodeId(TOA, { id: site, many: manySites }), 'out', v.node, `t${i + 1}`)
    })
  }

  // ---------------------------------------------------------------- 观测点
  const taps: ObservationPoint[] = []
  for (const t of TAP_ORDER) {
    if (!chain.taps[t]) continue
    for (const at of tapAt[t] ?? []) {
      taps.push({
        id: tapOpId(t, at.inst, at.inst ? 2 : 1),
        node: at.node, port: at.port,
        products: ['spectrum', 'envelope'],
        label: TAP_ANCHOR[t].label + (at.inst ? ` · ${at.inst}` : ''),
      })
    }
  }

  const doc: DiagramDoc = {
    schema_version: SCHEMA_VERSION,
    diagram_id: chain.diagram_id,
    name: chain.name,
    nodes,
    edges,
    run: {
      seed: chain.run.seed,
      duration_s: chain.run.duration_s,
      time_basis: 'LogicalSim',
      ...(chain.run.block_size !== undefined ? { block_size: chain.run.block_size } : {}),
    },
    template_ref: { template_id: TEMPLATE_ID, mode: chain.mode, version: TEMPLATE_VERSION },
  }
  if (taps.length) doc.observation_points = taps
  if (chain.scenario && chain.mode !== 'replay') doc.scenario_ref = { ...chain.scenario }
  return { doc, nodeSlot, activeSlots, tapAt }
}

/**
 * 从实例化的节点 id 里还原出这个节点属于哪条 (源, 站)（D-054）。
 *
 * 不能靠 `scene_binding`：天线组件根本不绑场景（`AntennaGain` 的变体没有 `bind`），
 * 身份只写在 id 的后缀里。后缀按 `nodeId()` 的规则生成——只有取值多于一个的维度才出现——
 * 所以要用已经收集到的站与源清单反推是哪一维，与编译时的 `manyEms` / `manySites` 同一判据。
 */
function instanceOf(
  per: SlotPer, rest: string, emitterIds: readonly string[], siteIds: readonly string[],
): { emitterId: string; siteId: string } {
  const manyEms = emitterIds.length > 1
  const manySites = siteIds.length > 1
  const em0 = emitterIds[0] ?? ''
  const site0 = siteIds[0] ?? ''
  const parts = rest ? rest.split(INST_SEP) : []
  switch (per) {
    case 'emitter': return { emitterId: parts[0] ?? em0, siteId: site0 }
    case 'link': {
      if (manyEms && manySites) return { emitterId: parts[0] ?? em0, siteId: parts[1] ?? site0 }
      if (manyEms) return { emitterId: parts[0] ?? em0, siteId: site0 }
      if (manySites) return { emitterId: em0, siteId: parts[0] ?? site0 }
      return { emitterId: em0, siteId: site0 }
    }
    case 'single': return { emitterId: '', siteId: '' }
    default: return { emitterId: em0, siteId: parts[0] ?? site0 }
  }
}

/** 参数集合的规范串，用来比「两个实例的参数是不是一模一样」。 */
function paramKey(params: Record<string, ParamValue>): string {
  return JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]))
}

/**
 * 把「逐实体的有效参数」归约成「共用底值 + 逐实体覆盖」两层（D-054）。
 *
 * 逐参数做，**确定性**：全体一致就全进共用底值；不一致取众数作底值，并列时取实体 id
 * 字典序最小者的值，其余实体进覆盖。这样划分唯一，且每个实体的有效值一字不变——
 * 重编译出来的节点参数因此与原文逐字节相同（`compile(parseChain(doc)) === doc`）。
 */
function reduceParams(
  byEnt: Map<string, Record<string, ParamValue>>,
): { params: Record<string, ParamValue>; byEntity?: Record<string, Record<string, ParamValue>> } {
  const ents = [...byEnt.keys()].sort()
  if (ents.length === 0) return { params: {} }
  if (ents.length === 1) return { params: { ...byEnt.get(ents[0]!)! } }

  const names = new Set<string>()
  for (const e of ents) for (const k of Object.keys(byEnt.get(e)!)) names.add(k)

  const params: Record<string, ParamValue> = {}
  const over: Record<string, Record<string, ParamValue>> = {}
  for (const name of [...names].sort()) {
    // 统计每个取值出现的次数；缺席也是一种「取值」，用哨兵表示
    const tally = new Map<string, { v: ParamValue | undefined; n: number; first: string }>()
    for (const e of ents) {
      const has = name in byEnt.get(e)!
      const v = has ? byEnt.get(e)![name] : undefined
      const k = has ? JSON.stringify(v) : '\u0000absent'
      const hit = tally.get(k)
      if (hit) hit.n += 1
      else tally.set(k, { v, n: 1, first: e })
    }
    if (tally.size === 1) {
      const only = [...tally.values()][0]!
      if (only.v !== undefined) params[name] = only.v
      continue
    }
    // 众数；票数并列时取实体 id 字典序最小者（ents 已排序，first 即最小者）
    let best = [...tally.values()][0]!
    for (const c of tally.values()) if (c.n > best.n || (c.n === best.n && c.first < best.first)) best = c
    if (best.v !== undefined) params[name] = best.v
    for (const e of ents) {
      const has = name in byEnt.get(e)!
      const v = has ? byEnt.get(e)![name] : undefined
      if (v === best.v) continue
      if (v !== undefined) (over[e] ??= {})[name] = v
      // 底值有该参数而这个实体没有：编译时它会被底值补上，与原文不符。
      // 这种情形只可能来自手改过的框图，交由调用方的逐实例核对拦下。
    }
  }
  return Object.keys(over).length > 0 ? { params, byEntity: over } : { params }
}

/**
 * 反解。只有本模板生成的框图才解得开：`template_ref` 对得上、节点 id 的基名与类型都在槽位表里。
 * 对不上就返回 null，由界面在自由画布打开并提示（10 报告 §5.5）——不猜、不勉强对应。
 *
 * 同一**实体**的多个实例参数必须完全一致（例如 `rx_ant__uav-1__site-1` 与
 * `rx_ant__uav-2__site-1` 都是 site-1 的那副接收天线）；不一致说明这份框图被手改过，
 * 返回 null 而不是取第一个了事。不同实体之间允许不同——那正是 D-054 的逐实体设置。
 */
export function parseChain(doc: DiagramDoc): ChainState | null {
  const t = doc.template_ref
  if (!t || t.template_id !== TEMPLATE_ID || t.version !== TEMPLATE_VERSION) return null
  const mode = t.mode
  if (mode !== 'synthetic' && mode !== 'replay' && mode !== 'mixed') return null

  const chain = emptyChain(mode, doc.diagram_id)
  chain.name = doc.name
  chain.run = {
    duration_s: typeof doc.run.duration_s === 'number' ? doc.run.duration_s : 1,
    seed: typeof doc.run.seed === 'number' ? doc.run.seed : 0,
    ...(typeof doc.run.block_size === 'number' ? { block_size: doc.run.block_size } : {}),
  }
  if (doc.scenario_ref) chain.scenario = { ...doc.scenario_ref }

  // 基名 → 槽位。同一 node 被多个变体共用（如 ch 的两种）：先记下，具体哪个变体看 type
  const byNode = new Map<string, SlotId>()
  for (const def of SLOTS) for (const v of def.variants) if (!byNode.has(v.node)) byNode.set(v.node, def.id)

  const siteIds: string[] = []
  const emitterIds: string[] = []
  const seen = new Set<SlotId>()
  // 槽位 → 实体 → 该实体的有效参数。归约成两层要等站与源的清单齐了才能做，故分两趟。
  const bucket = new Map<SlotId, { variant: number; byEnt: Map<string, Record<string, ParamValue>> }>()
  type Pending = { slot: SlotId; per: SlotPer; rest: string; params: Record<string, ParamValue> }
  const pending: Pending[] = []

  for (const n of doc.nodes) {
    const split = splitNodeId(n.id)
    if (!split) return null                                 // 有模板之外的节点：不是本模板的框图
    const { base, rest } = split
    if (base === SCN) {
      const s = n.scene_binding?.site_id
      if (s && !siteIds.includes(s)) siteIds.push(s)
      continue
    }
    if (base === SUP || base === TOA || base === MIX) continue   // 隐含节点，不占槽位
    if (base === BG) {
      const v = n.params.data_id
      chain.backgroundDataId = typeof v === 'string' ? v : null
      continue
    }
    const slot = byNode.get(base)
    if (slot === undefined) return null
    const def = SLOT_BY_ID[slot]
    const vi = def.variants.findIndex((v) => v.type === n.type && v.node === base)
    if (vi < 0) return null
    const fixed = def.variants[vi]!.fixed ?? {}
    // 由场景带出的参数同样不回写用户状态（D-054）：它们的真理源是场景文件，
    // 回写进链路状态就又成了第二份，改场景反而改不动链路了
    const fromScene = new Set(fromSceneOf(slot).map((f) => f.name))
    const params: Record<string, ParamValue> = {}
    for (const [k, val] of Object.entries(n.params)) {
      if (k in fixed) continue                              // 恒定参数不回写用户状态
      if (fromScene.has(k)) continue
      if (k === 'report_entities') continue
      params[k] = val
    }
    const b = bucket.get(slot) ?? { variant: vi, byEnt: new Map<string, Record<string, ParamValue>>() }
    b.variant = vi
    bucket.set(slot, b)
    pending.push({ slot, per: def.per ?? 'site', rest, params })
    seen.add(slot)
    if (n.scene_binding?.site_id && !siteIds.includes(n.scene_binding.site_id)) {
      siteIds.push(n.scene_binding.site_id)
    }
    if (def.per === 'emitter' && n.scene_binding?.entity_id
        && !emitterIds.includes(n.scene_binding.entity_id)) {
      emitterIds.push(n.scene_binding.entity_id)
    }
  }
  chain.siteIds = siteIds
  chain.emitterIds = emitterIds

  // 第二趟：站与源的清单已经齐了，可以从节点 id 的后缀反推每个节点属于哪个实体
  for (const q of pending) {
    const { emitterId, siteId } = instanceOf(q.per, q.rest, emitterIds, siteIds)
    const key = ownerEntity(q.slot, emitterId, siteId)
    const byEnt = bucket.get(q.slot)!.byEnt
    const prev = byEnt.get(key)
    // 同一实体的多个实例（如一个站对 N 个源的接收天线）必须一模一样，不一致即被手改过
    if (prev !== undefined && paramKey(prev) !== paramKey(q.params)) return null
    byEnt.set(key, q.params)
  }
  for (const [slot, b] of bucket) {
    const r = reduceParams(b.byEnt)
    chain.slots[slot] = {
      variant: b.variant, bypass: false, params: r.params,
      ...(r.byEntity ? { byEntity: r.byEntity } : {}),
    }
  }
  // 辐射源不绑场景（回放模式）时，源维度只有一个匿名实例
  if (chain.emitterIds.length === 0 && mode !== 'replay' && siteIds.length > 0) {
    // 绑源的槽位都不在（例如整条前段被跳过）：留空，由界面提示重选
  }

  // 没出现的可旁路槽位记为旁路；不可旁路又没出现的（回放模式的前端环节）保持缺省
  for (const def of SLOTS) {
    if (seen.has(def.id)) continue
    if (def.bypassable) chain.slots[def.id].bypass = true
  }
  if (mode === 'replay') chain.slots.tx.variant = def_replay_variant()

  for (const t2 of TAP_ORDER) chain.taps[t2] = false
  for (const op of doc.observation_points ?? []) {
    const i = op.id.indexOf(INST_SEP)
    const base = i < 0 ? op.id : op.id.slice(0, i)
    if ((TAP_ORDER as readonly string[]).includes(base)) chain.taps[base as TapId] = true
  }
  return chain
}

function def_replay_variant(): number {
  return SLOT_BY_ID.tx.variants.findIndex((v) => v.type === 'FileReplaySource')
}

/** 切模式时保留已填参数，只改变体与不适用状态（10 报告 §2.2 最后一句）。 */
/**
 * 辐射源变体与信号源模式是**同一件事**（10 报告 §2.2「一条链、三种信号源模式」）：
 * 「场景辐射源」= 全合成或混合增强，「实测片段回放」= 实测回放。
 *
 * 卡片上的变体下拉与试验设置栏的模式下拉因此是同一个设置的两个入口，必须联动。
 * 不联动的后果是造出一个设计里没有的状态——模式说「全合成」而辐射源是回放源：
 * 回放源不绑场景，`emitterIds` 反解出来是空的，于是 `hasScene` 为假，
 * 整条链的场景绑定连同 `scn` 节点一起**静默消失**，界面上只看到「无人机（先选场景）」
 * （2026-09-09 用户实测撞到）。
 *
 * 由「实测回放」换回「场景辐射源」时落到**全合成**：混合增强也用变体 0，从回放态分不出
 * 用户想要哪一个，取更基础的那个。
 */
export function switchTxVariant(chain: ChainState, variant: number): ChainState {
  const wantReplay = variant === def_replay_variant()
  if (wantReplay && chain.mode !== 'replay') return switchMode(chain, 'replay')
  if (!wantReplay && chain.mode === 'replay') return switchMode(chain, 'synthetic')
  return { ...chain, slots: { ...chain.slots, tx: { ...chain.slots.tx, variant } } }
}

export function switchMode(chain: ChainState, mode: ChainMode): ChainState {
  const next: ChainState = { ...chain, mode, slots: { ...chain.slots } }
  const txVariant = mode === 'replay' ? def_replay_variant() : 0
  next.slots.tx = { ...chain.slots.tx, variant: txVariant }
  next.name = `典型链路 · ${mode === 'synthetic' ? '全合成' : mode === 'replay' ? '实测回放' : '混合增强'}`
  if (mode === 'replay') next.scenario = null
  // 混合模式下背景片段自带接收机噪声，再注入即重复计入（10 报告 §2.2）
  next.slots.rx_fe = {
    ...chain.slots.rx_fe,
    params: { ...chain.slots.rx_fe.params, noise_mode: mode === 'mixed' ? 'none' : 'thermal' },
  }
  return next
}
