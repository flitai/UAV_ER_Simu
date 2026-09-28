// 覆盖场（探测范围）的浏览器侧：拼请求、调引擎、把结果留给图层与探针（D-080）。
//
// **物理全在引擎**（`cuav_run --field`，经 POST /api/v1/coverage，D-080）：每一格走的是链路帧同一条
// link_geometry + link_budget。**传播一律按 E3（自由空间 + 建筑遮挡）**，不随框图的传播档位变（D-081，
// 用户 2026-09-27：「作为可视化不做与 E1 和 E2 的对比」）。浏览器只做三件事：拼请求、画网格、画等值线。
//
// 外部小 store（同 losProbe / cursorStore 范式），不进主 reducer：结果是几十万个浮点数。
//
// 请求里放什么（只取场景与框图里已经有的，不编缺省值，铁律 15）：
//   - scenario_id / emitter_id：当前场景与**焦点目标**（focus.ts，与右栏焦点卡同一条规则）；
//     发射功率、天线增益、频率、站的参数都由引擎从**已保存的**场景文件读——浏览器里没保存的改动不进这张图；
//   - height_agl_m：缺省取焦点目标此刻的离地高，用户改过即固定（与视距探测同口径）；
//   - propagation：恒为 E3（D-081）；
//   - detectors：框图里绑到各站的 EnergyDetector 的 nfft / pfa / 频段（这是检测器的事，不是传播的事，仍跟框图）。
//   框图必须属于当前场景（各场景的站 id 重名：拿 golden-01 那条链去套 golden-02 的 site-1，
//   目标会整个落在频段外）；框图不属于当前场景时检测器按组件目录缺省与 ±0.45·fs。

import type { AppState, ScenarioDoc } from '../../state/types.js'
import { postCoverage, type FieldMeta } from '../../api/client.js'
import { emitters, posOf, sites, type Obj } from '../editor/scenarioOps.js'
import { currentSituation } from '../situationView.js'
import { focusTargetId } from '../focus.js'
import { contourSegments, gridGeom, type Segment } from './contour.js'

/** 网格边长（m）。观测区域 20 × 20 km → 200 × 200 格。 */
export const COVERAGE_RES_M = 100
/** 等值线取的检测概率 */
export const COVERAGE_LEVEL = 0.9

/**
 * 探测范围的传播配置：**恒为 E3**（自由空间 + 建筑遮挡），不随框图的传播档位变（D-081）。
 * 只给档位、不带别的效应——E3 与统计阴影、城市经验互斥（闸三闸四），双径与天气不在这张图的口径里。
 */
export const COVERAGE_PROPAGATION = { prop_level: 'E3' } as const

export interface CoverageState {
  on: boolean
  /** 'off' 没开 | 'computing' 引擎在算 | 'ready' 有结果 | 'error' 说得出缘由 */
  status: 'off' | 'computing' | 'ready' | 'error'
  /** 'all' = 各站合并；否则为站 id */
  site: string
  /** 用户固定的目标离地高度；null = 跟随焦点目标 */
  heightOverride: number | null
  /** 显示 Pd 分界线（等值线与它的晕）；缺省开（2026-09-28 用户：「给 Pd 分界线设一个开关」） */
  showContour: boolean
  error: string | null
  /** 最近一次结果的事实摘要（图例与探针用）；网格在模块变量里 */
  result: null | (FieldMeta & { targetName: string; wallMs: number })
}

const INITIAL: CoverageState = { on: false, status: 'off', site: 'all', heightOverride: null, showContour: true, error: null, result: null }
let state: CoverageState = INITIAL
const subs = new Set<() => void>()
function emit(): void { for (const f of subs) f() }
function set(patch: Partial<CoverageState>): void { state = { ...state, ...patch }; emit() }

let layers: Record<string, Float32Array> | null = null
let inflight: AbortController | null = null

export const coverageStore = {
  get: (): CoverageState => state,
  subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f) } },
  setOn(on: boolean): void {
    if (!on) inflight?.abort()
    set(on ? { on, status: state.result ? 'ready' : 'off' } : { on, status: 'off' })
  },
  setSite(site: string): void { set({ site }) },
  setHeight(h: number | null): void { set({ heightOverride: h }) },
  setShowContour(v: boolean): void { set({ showContour: v }) },
  /** 换场景：旧结果属于上一份场景，清掉；分界线开关是浏览者的显示偏好，留着 */
  reset(): void { inflight?.abort(); layers = null; state = { ...INITIAL, showContour: state.showContour }; emit() },
}

/** 当前选择下要画的那一层 Pd（合并或某一站），没有结果时为 null。 */
export function coverageValues(): Float32Array | null {
  if (!layers) return null
  return layers[state.site === 'all' ? 'combined' : state.site] ?? null
}

/** 当前选择下 Pd = COVERAGE_LEVEL 的等值线。 */
export function coverageContour(): Segment[] {
  const v = coverageValues()
  const r = state.result
  if (!v || !r) return []
  return contourSegments(gridGeom(r.nx, r.ny, r.bbox), v, COVERAGE_LEVEL)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function terrainHeightM(doc: ScenarioDoc): number {
  return num((doc.coordinate as Record<string, unknown> | undefined)?.terrainHeight_m) ?? 0
}

/** 组件目录里 EnergyDetector 的缺省（引擎自己的缺省）。 */
function catalogDetectorDefaults(catalog: unknown): { nfft: number; pfa: number } | null {
  const comps = (catalog as { components?: Array<{ type?: string; params?: Array<{ name?: string; default?: unknown }> }> } | null)?.components
  const det = comps?.find((c) => c.type === 'EnergyDetector')
  const nfft = num(det?.params?.find((p) => p.name === 'nfft')?.default)
  const pfa = num(det?.params?.find((p) => p.name === 'pfa')?.default)
  return nfft !== null && pfa !== null ? { nfft, pfa } : null
}

type DiagramNode = { type?: string; scene_binding?: { site_id?: string }; params?: Record<string, unknown> }

/** 当前框图——**必须属于当前场景**，否则返回 null（站 id 各场景重名）。 */
function diagramOfScenario(text: string, scenarioId: string | null): DiagramNode[] | null {
  try {
    const doc = JSON.parse(text) as { scenario_ref?: { scenario_id?: string }; nodes?: DiagramNode[] }
    if (!scenarioId || doc.scenario_ref?.scenario_id !== scenarioId) return null
    return doc.nodes ?? []
  } catch {
    return null
  }
}

/** 框图里绑到某站的检测器参数。单站链的检测器不带 site_id（装载器按唯一站补），此时它就是这个站的。 */
function detectorOf(nodes: DiagramNode[] | null, siteId: string): Record<string, unknown> | null {
  if (!nodes) return null
  const dets = nodes.filter((n) => n.type === 'EnergyDetector')
  const bound = dets.find((n) => n.scene_binding?.site_id === siteId)
  return (bound ?? (dets.length === 1 && !dets[0]!.scene_binding?.site_id ? dets[0]! : null))?.params ?? null
}

/** 从界面状态拼引擎请求。拼不出来就说缘由，不拿缺省值顶替（铁律 15）。 */
export function coverageRequestFrom(s: AppState, heightOverride: number | null):
    { body: Record<string, unknown>; targetName: string } | { error: string } {
  const doc = s.scene.scenario.doc
  const scenarioId = s.scene.scenario.id
  if (!doc || !scenarioId) return { error: '未载入场景' }
  const terrain = terrainHeightM(doc)
  const focusId = focusTargetId(s)
  const em = emitters(doc).find((x) => String(x.id) === focusId) as Obj | undefined
  if (!em || !focusId) return { error: '场景中无辐射源' }
  const live = currentSituation(doc).entities.get(focusId)
  const defaultHeight = live ? live.alt_m - terrain : (num(posOf(em)?.alt_m) ?? 0) - terrain
  const defaults = catalogDetectorDefaults(s.components.catalog)
  const nodes = diagramOfScenario(s.diagram.text, scenarioId)

  const detectors: Record<string, unknown> = {}
  for (const site of sites(doc)) {
    const id = String(site.id)
    const fs = num((site.receiver as Record<string, unknown> | undefined)?.fs_Hz)
    const dp = detectorOf(nodes, id)
    const nfft = num(dp?.nfft) ?? defaults?.nfft ?? null
    const pfa = num(dp?.pfa) ?? defaults?.pfa ?? null
    if (nfft === null || pfa === null) return { error: '组件目录未就绪，无法确定检测器参数' }
    if (fs === null && (num(dp?.band_lo_Hz) === null || num(dp?.band_hi_Hz) === null)) return { error: `侦测站 ${id} 缺采样率` }
    detectors[id] = {
      nfft, pfa,
      band_lo_Hz: num(dp?.band_lo_Hz) ?? -0.45 * fs!,
      band_hi_Hz: num(dp?.band_hi_Hz) ?? 0.45 * fs!,
    }
  }
  if (!Object.keys(detectors).length) return { error: '场景中无侦测站' }
  return {
    targetName: String(em.name ?? focusId),
    body: {
      schema_version: 'cuav-field-request/1',
      scenario_id: scenarioId,
      emitter_id: focusId,
      height_agl_m: Math.max(0, heightOverride ?? defaultHeight),
      res_m: COVERAGE_RES_M,
      propagation: COVERAGE_PROPAGATION,
      detectors,
    },
  }
}

/** 发一次计算；新请求一来就中止在飞的旧请求，晚到的旧结果不会覆盖新结果。 */
export async function requestCoverage(s: AppState): Promise<void> {
  const built = coverageRequestFrom(s, state.heightOverride)
  if ('error' in built) { set({ status: 'error', error: built.error }); return }
  inflight?.abort()
  const ctl = new AbortController()
  inflight = ctl
  set({ status: 'computing', error: null })
  const t0 = performance.now()
  try {
    const r = await postCoverage(built.body, ctl.signal)
    if (ctl.signal.aborted) return
    if (!r.ok) { set({ status: 'error', error: r.message }); return }
    layers = r.layers
    const site = state.site === 'all' || r.layers[state.site] ? state.site : 'all'
    set({
      status: state.on ? 'ready' : 'off', site, error: null,
      result: { ...r.meta, targetName: built.targetName, wallMs: Math.round(performance.now() - t0) },
    })
  } catch (e) {
    if (ctl.signal.aborted) return
    set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
  } finally {
    if (inflight === ctl) inflight = null
  }
}

/** 探针用的摘要（只读，无副作用）。 */
export function coverageProbe(): {
  on: boolean; status: string; site: string; height_agl_m: number | null; cells: number; showContour: boolean
  pdMax: number | null; contourSegments: number; target: string | null; ms: number | null
  propLevel: string | null; terms: string[]
} {
  const v = coverageValues()
  let pdMax: number | null = null
  if (v) { pdMax = 0; for (const x of v) if (x > pdMax) pdMax = x }
  const r = state.result
  return {
    on: state.on, status: state.status, site: state.site, showContour: state.showContour,
    height_agl_m: r?.height_agl_m ?? null, cells: v ? v.length : 0, pdMax,
    contourSegments: v ? coverageContour().length : 0, target: r?.emitter_id ?? null, ms: r?.ms ?? null,
    propLevel: r?.prop_level ?? null, terms: r?.included_loss_terms ?? [],
  }
}
