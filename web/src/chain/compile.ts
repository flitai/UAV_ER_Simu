// 典型链路 ↔ 标准框图的编译与反解（06 备忘录 §9G C-7；10 号报告 §5、§6.2；决策 D-051）。
//
// `compile()` 把九个槽位的状态编译成一份满足 `docs/diagram-format.md` 的普通框图；
// `parse()` 反着来。引擎与服务端因此完全不需要知道「典型链路」这回事——它们看到的永远是
// 一张普通框图，校验、运行、产品、补取全部沿用 B 线（10 报告 §0 第 3 条）。
//
// 两个不变量，由单测守：
//   ① `compile(parse(doc)) === doc` 逐字节（对本模块自己产出的框图）；
//   ② 节点 id 固定，引擎报错的 `node_id` 因此能反查回槽位并高亮那张卡片。
//
// 编译时故意**不写与目录缺省相同的参数**：`serialize()` 会再剔一次，两处一致即可保证
// 「目录缺省值变了、既有框图自动跟随」（09 §6.10 的第二条硬要求）。

import type { Catalog } from '../api/catalog.js'
import { findComponent } from '../api/catalog.js'
import type { DiagramDoc, DiagramEdge, DiagramNode, ObservationPoint, ParamValue } from '../diagram/doc.js'
import { SCHEMA_VERSION } from '../diagram/doc.js'
import type { ScenarioDoc } from '../state/types.js'
import {
  SLOTS, SLOT_BY_ID, TAP_ANCHOR, TAP_ORDER, TEMPLATE_ID, TEMPLATE_VERSION,
  emptyChain, slotState, variantOf,
  type ChainMode, type ChainState, type SlotId, type TapId,
} from './model.js'
import { freqPlan } from './plan.js'

/** 编译结果里每个节点属于哪个槽位；界面据此把引擎报错反查回卡片。 */
export type NodeSlotMap = Record<string, SlotId | 'scn' | 'mix' | 'bg'>

export interface CompileResult {
  doc: DiagramDoc
  nodeSlot: NodeSlotMap
  /** 实际参与计算的槽位，按链路顺序 */
  activeSlots: SlotId[]
  /** 每个观测点最终挂在哪个节点的哪个口；不可用的观测点不在表里 */
  tapAt: Partial<Record<TapId, { node: string; port: string }>>
}

const SCN = 'scn'
const MIX = 'mix'
const BG = 'bg'

function round(v: number): number {
  return Math.round(v)
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

  const bindOf = (kind: 'emitter' | 'site' | undefined): DiagramNode['scene_binding'] => {
    if (!kind || !scenarioId) return undefined
    if (kind === 'site') return chain.siteId ? { scenario_id: scenarioId, site_id: chain.siteId } : undefined
    return chain.emitterId ? { scenario_id: scenarioId, entity_id: chain.emitterId } : undefined
  }

  const push = (
    id: string, type: string, params: Record<string, ParamValue>,
    slot: SlotId | 'scn' | 'mix' | 'bg', bind?: DiagramNode['scene_binding'],
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
      // 与目录缺省相同的不写：目录缺省变了，既有框图自动跟随
      const ps = spec?.params.find((p) => p.name === k)
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

  const hasScene = chain.mode !== 'replay' && !!scenarioId && !!chain.siteId && !!chain.emitterId

  // 隐含节点：场景参数源。它不是槽位，画面上不出现，但没有它天线与信道就拿不到帧。
  if (hasScene) {
    push(SCN, 'ScenarioSource', {
      sample_rate_Hz: plan.fs_rf,
      total_samples: total,
      update_rate_Hz: 20,
    }, 'scn', bindOf('site'))
  }
  const sceneOut = hasScene ? { node: SCN, port: `link:${chain.emitterId!}` } : null

  // ------------------------------------------------------------------ 主链
  let cursor: { node: string; port: string } | null = null
  const tapAt: Partial<Record<TapId, { node: string; port: string }>> = {}

  for (const def of SLOTS) {
    if (def.id === 'det') continue                         // 检测段单独接
    const st = slotState(chain, def.id, cat)
    if (st !== 'active') continue
    const v = variantOf(chain, def.id)
    const cfg = chain.slots[def.id]
    const params: Record<string, ParamValue> = { ...cfg.params, ...(v.fixed ?? {}) }

    // 派生参数：一处填、多处派生（10 报告 §2.4）
    if (def.id === 'tx' && v.type === 'SceneEmitterSource') {
      params.sample_rate_Hz = plan.fs_rf
      params.total_samples = total
      params.center_frequency_Hz = plan.f_rx
    }
    if (def.id === 'ch' && v.type === 'FreeSpaceChannel') {
      params.frequency_Hz = plan.f_tx
    }
    if (def.id === 'ddc') {
      params.f_shift_Hz = plan.f_shift
      params.decim = plan.decim
    }
    if (def.id === 'chan') {
      params.channels = plan.channels
    }
    if (chain.run.block_size !== undefined && 'block_samples' in params) delete params.block_samples

    push(v.node, v.type, params, def.id, bindOf(v.bind))
    activeSlots.push(def.id)
    if (cursor) link(cursor.node, cursor.port, v.node, 'in')
    // 天线与场景绑定信道吃参数帧
    if (sceneOut && (v.type === 'AntennaGain' || v.type === 'SceneBoundChannel')) {
      link(sceneOut.node, sceneOut.port, v.node, 'scene')
    }
    cursor = { node: v.node, port: 'out' }

    // 观测点锚在该槽位的输出口上
    for (const t of TAP_ORDER) {
      if (TAP_ANCHOR[t].slot === def.id) tapAt[t] = { node: v.node, port: 'out' }
    }
  }

  // 混合增强：背景回放在 S4 处与合成目标相加
  if (chain.mode === 'mixed' && chain.backgroundDataId && cursor) {
    push(BG, 'FileReplaySource', { data_id: chain.backgroundDataId }, 'bg')
    push(MIX, 'AddMixer', {}, 'mix')
    link(cursor.node, cursor.port, MIX, 'a')
    link(BG, 'out', MIX, 'b')
    cursor = { node: MIX, port: 'out' }
  }

  // S4 兜底：DDC 未启用（旁路或未实现）时，主产品就落在链尾（10 报告 §2.3）
  if (cursor) tapAt.s4 = { node: cursor.node, port: cursor.port }
  // 信道化启用时 S5 存在，且检测接在 S5 上
  const detAnchor = cursor

  // ------------------------------------------------------------------ 检测段
  if (detAnchor && slotState(chain, 'det', cat) === 'active') {
    const v = variantOf(chain, 'det')
    const cfg = chain.slots.det
    // 频段由 S4（或 S5）的采样率派生。算不出来时（回放模式没有场景）**不覆盖用户填的值**：
    // 拿 0 顶替会让引擎收到「频段上下限颠倒」，报错指向检测器而不是指向真正缺的那一项（铁律 15）。
    const half = plan.fs_s5 > 0 ? plan.fs_s5 : plan.fs_s4
    const band: Record<string, ParamValue> = half > 0 ? { band_lo_Hz: -0.45 * half, band_hi_Hz: 0.45 * half } : {}
    push(v.node, v.type, { ...cfg.params, ...band }, 'det')
    link(detAnchor.node, detAnchor.port, v.node, 'in')
    activeSlots.push('det')
  }

  // ------------------------------------------------------------------ 观测点
  const taps: ObservationPoint[] = []
  for (const t of TAP_ORDER) {
    const at = tapAt[t]
    if (!at || !chain.taps[t]) continue
    taps.push({ id: t, node: at.node, port: at.port, products: ['spectrum', 'envelope'], label: TAP_ANCHOR[t].label })
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
 * 反解。只有本模板生成的框图才解得开：`template_ref` 对得上、节点 id 与类型都在槽位表里。
 * 对不上就返回 null，由界面在自由画布打开并提示（10 报告 §5.5）——不猜、不勉强对应。
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

  // 节点 id 唯一且固定，所以直接按 id 找槽位
  const byNode = new Map<string, { slot: SlotId; variant: number }>()
  for (const def of SLOTS) {
    def.variants.forEach((v, i) => {
      const prev = byNode.get(v.node)
      // 同一 node 被多个变体共用（如 ch 的两种）：先记下，具体是哪个变体看 type
      if (!prev) byNode.set(v.node, { slot: def.id, variant: i })
    })
  }

  const seen = new Set<SlotId>()
  for (const n of doc.nodes) {
    if (n.id === SCN || n.id === MIX) continue
    if (n.id === BG) {
      const v = n.params.data_id
      chain.backgroundDataId = typeof v === 'string' ? v : null
      continue
    }
    const hit = byNode.get(n.id)
    if (!hit) return null                                   // 有模板之外的节点：不是本模板的框图
    const def = SLOT_BY_ID[hit.slot]
    const vi = def.variants.findIndex((v) => v.type === n.type && v.node === n.id)
    if (vi < 0) return null
    const fixed = def.variants[vi]!.fixed ?? {}
    const params: Record<string, ParamValue> = {}
    for (const [k, val] of Object.entries(n.params)) {
      if (k in fixed) continue                              // 恒定参数不回写用户状态
      params[k] = val
    }
    chain.slots[hit.slot] = { variant: vi, bypass: false, params }
    seen.add(hit.slot)
    if (n.scene_binding) {
      if (n.scene_binding.site_id) chain.siteId = n.scene_binding.site_id
      if (n.scene_binding.entity_id) chain.emitterId = n.scene_binding.entity_id
    }
  }
  // 场景参数源也带站点绑定；主链上可能没有绑站点的节点
  const scn = doc.nodes.find((n) => n.id === SCN)
  if (scn?.scene_binding?.site_id) chain.siteId = scn.scene_binding.site_id

  // 没出现的可旁路槽位记为旁路；不可旁路又没出现的（回放模式的前端环节）保持缺省
  for (const def of SLOTS) {
    if (seen.has(def.id)) continue
    if (def.bypassable) chain.slots[def.id].bypass = true
  }
  if (mode === 'replay') chain.slots.tx.variant = def_replay_variant()

  for (const t of TAP_ORDER) chain.taps[t] = false
  for (const op of doc.observation_points ?? []) {
    if ((TAP_ORDER as readonly string[]).includes(op.id)) chain.taps[op.id as TapId] = true
  }
  return chain
}

function def_replay_variant(): number {
  return SLOT_BY_ID.tx.variants.findIndex((v) => v.type === 'FileReplaySource')
}

/** 切模式时保留已填参数，只改变体与不适用状态（10 报告 §2.2 最后一句）。 */
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
