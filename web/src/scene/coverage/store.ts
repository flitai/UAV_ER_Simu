// 覆盖场的主线程侧（D-079）：从界面状态拼出计算输入、驱动后台线程、把结果留给图层与探针。
//
// 外部小 store（同 losProbe / cursorStore 范式），不进主 reducer：结果是几十万个浮点数，
// 进 reducer 会让整棵界面树跟着重渲染。
//
// 参数从哪来（只取场景与框图里已经有的，不编缺省值，铁律 15）：
//   - 目标：**焦点目标**（focus.ts，与右栏焦点卡同一条规则）的 emission.{tx_power_dBm, antenna_gain_dBi, center_Hz}；
//   - 高度：缺省取焦点目标此刻的离地高，**用户改过即固定住**（与视距探测同一口径，免得换焦点时图悄悄变了尺子）；
//   - 站：场景 antenna.gain_dBi、receiver.{nf_dB, fs_Hz, center_Hz}；
//   - 检测器：框图里绑定到这个站的 EnergyDetector 的 nfft / pfa / band_lo_Hz / band_hi_Hz；
//     框图里没有这个站的检测器时，nfft / pfa 取组件目录缺省（就是引擎自己的缺省），
//     频段按 compile.ts 的同式 ±0.45·fs 派生。组件目录没到手就报「无法确定检测器参数」，不猜。

import type { AppState, ScenarioDoc } from '../../state/types.js'
import { emitters, posOf, sites, type Obj } from '../editor/scenarioOps.js'
import { currentSituation } from '../situationView.js'
import { focusTargetId } from '../focus.js'
import type { CoverageSite, DetectorParams, FieldInput } from './field.js'
import type { ComputeMsg, WorkerReply } from './worker.js'
import { contourSegments, type Segment } from './contour.js'

/** 网格边长（m）。观测区域 20 × 20 km → 200 × 200 格。 */
export const COVERAGE_RES_M = 100
/** 等值线取的检测概率 */
export const COVERAGE_LEVEL = 0.9

export interface CoverageState {
  on: boolean
  /** 'off' 没开 | 'computing' 在算（含首次取建筑几何）| 'ready' 有结果 | 'error' 说得出缘由 */
  status: 'off' | 'computing' | 'ready' | 'error'
  progress: number
  /** 'all' = 各站合并；否则为站 id */
  site: string
  /** 用户固定的目标离地高度；null = 跟随焦点目标 */
  heightOverride: number | null
  error: string | null
  /** 最近一次结果的事实摘要（图例与探针用）；数组本身在模块变量里 */
  result: null | {
    targetId: string
    targetName: string
    height_agl_m: number
    nx: number
    ny: number
    bbox: [number, number, number, number]
    siteIds: string[]
    m_bins: Record<string, number>
    outOfBand: Record<string, boolean>
    blocked: Record<string, number>
    ms: number
    buildingsMs: number
  }
}

const INITIAL: CoverageState = { on: false, status: 'off', progress: 0, site: 'all', heightOverride: null, error: null, result: null }
let state: CoverageState = INITIAL
const subs = new Set<() => void>()
function emit(): void { for (const f of subs) f() }
function set(patch: Partial<CoverageState>): void { state = { ...state, ...patch }; emit() }

let arrays: { perSite: Record<string, Float32Array>; combined: Float32Array } | null = null
let worker: Worker | null = null
let seq = 0

export const coverageStore = {
  get: (): CoverageState => state,
  subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f) } },
  setOn(on: boolean): void { set(on ? { on, status: state.result ? 'ready' : 'off' } : { on, status: 'off', progress: 0 }) },
  setSite(site: string): void { set({ site }) },
  setHeight(h: number | null): void { set({ heightOverride: h }) },
  /** 换场景：旧结果属于上一份场景，清掉；开关与站选择的意图也回到缺省 */
  reset(): void { seq++; arrays = null; state = INITIAL; emit() },
}

/** 当前选择下要画的那一层 Pd（合并或某一站），没有结果时为 null。 */
export function coverageValues(): Float32Array | null {
  if (!arrays) return null
  return state.site === 'all' ? arrays.combined : arrays.perSite[state.site] ?? null
}

/** 当前选择下 Pd = COVERAGE_LEVEL 的等值线。 */
export function coverageContour(): Segment[] {
  const v = coverageValues()
  const r = state.result
  if (!v || !r) return []
  return contourSegments({ nx: r.nx, ny: r.ny, bbox: r.bbox, dLon: (r.bbox[2] - r.bbox[0]) / r.nx, dLat: (r.bbox[3] - r.bbox[1]) / r.ny }, v, COVERAGE_LEVEL)
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

/**
 * 框图里绑定到某站的 EnergyDetector 的参数（没有就返回 null）。
 * **框图必须属于当前场景**：站的 id（site-1…）在各份场景里重名，拿 golden-01 那条链的检测器
 * （500 kS/s、±225 kHz）去套 golden-02 的 site-1（10 MS/s），目标会整个落在频段外、全图 Pd = 虚警率
 * ——第一次在浏览器里跑就是这样。
 */
function diagramDetector(text: string, scenarioId: string | null, siteId: string): Record<string, unknown> | null {
  try {
    const doc = JSON.parse(text) as {
      scenario_ref?: { scenario_id?: string }
      nodes?: Array<{ type?: string; scene_binding?: { site_id?: string }; params?: Record<string, unknown> }>
    }
    if (!scenarioId || doc.scenario_ref?.scenario_id !== scenarioId) return null
    const nodes = (doc.nodes ?? []).filter((n) => n.type === 'EnergyDetector')
    const bound = nodes.find((n) => n.scene_binding?.site_id === siteId)
    // 单站链的检测器不带 site_id（绑定由装载器按唯一站补），此时它就是这个站的
    return (bound ?? (nodes.length === 1 && !nodes[0]!.scene_binding?.site_id ? nodes[0]! : null))?.params ?? null
  } catch {
    return null
  }
}

/** 从界面状态拼计算输入。拼不出来就说缘由，不拿缺省值顶替（铁律 15）。 */
export function coverageInputFrom(s: AppState, bbox: [number, number, number, number], heightOverride: number | null):
    { input: FieldInput; targetId: string; targetName: string } | { error: string } {
  const doc = s.scene.scenario.doc
  if (!doc) return { error: '未载入场景' }
  const terrain = terrainHeightM(doc)
  const focusId = focusTargetId(s)
  const em = emitters(doc).find((x) => String(x.id) === focusId) as Obj | undefined
  if (!em || !focusId) return { error: '场景中无辐射源' }
  const e = (em.emission ?? {}) as Record<string, unknown>
  const txPower = num(e.tx_power_dBm)
  const txGain = num(e.antenna_gain_dBi)
  const center = num(e.center_Hz)
  if (txPower === null || txGain === null || center === null) return { error: `辐射源 ${focusId} 缺发射功率、天线增益或中心频率` }
  const live = currentSituation(doc).entities.get(focusId)
  const defaultHeight = live ? live.alt_m - terrain : (num(posOf(em)?.alt_m) ?? 0) - terrain
  const defaults = catalogDetectorDefaults(s.components.catalog)

  const out: CoverageSite[] = []
  for (const site of sites(doc)) {
    const id = String(site.id)
    const p = posOf(site)
    const ant = (site.antenna ?? {}) as Record<string, unknown>
    const rx = (site.receiver ?? {}) as Record<string, unknown>
    const gain = num(ant.gain_dBi), nf = num(rx.nf_dB), fs = num(rx.fs_Hz), rxCenter = num(rx.center_Hz)
    if (!p || gain === null || nf === null || fs === null || rxCenter === null) return { error: `侦测站 ${id} 缺位置、天线增益、噪声系数、采样率或中心频率` }
    const dp = diagramDetector(s.diagram.text, s.scene.scenario.id, id)
    const nfft = num(dp?.nfft) ?? defaults?.nfft ?? null
    const pfa = num(dp?.pfa) ?? defaults?.pfa ?? null
    if (nfft === null || pfa === null) return { error: '组件目录未就绪，无法确定检测器参数' }
    const lo = num(dp?.band_lo_Hz) ?? -0.45 * fs
    const hi = num(dp?.band_hi_Hz) ?? 0.45 * fs
    const detector: DetectorParams = { nfft, pfa, band_lo_Hz: lo, band_hi_Hz: hi }
    out.push({ id, position: { lon: p.lon, lat: p.lat, alt_m: p.alt_m }, gain_dBi: gain, nf_dB: nf, fs_Hz: fs, center_Hz: rxCenter, detector })
  }
  if (!out.length) return { error: '场景中无侦测站' }
  return {
    targetId: focusId,
    targetName: String(em.name ?? focusId),
    input: {
      bbox, res_m: COVERAGE_RES_M, terrain_height_m: terrain, sites: out,
      target: { tx_power_dBm: txPower, tx_gain_dBi: txGain, center_Hz: center, height_agl_m: heightOverride ?? defaultHeight },
    },
  }
}

/** 发一次计算。结果按 seq 认领：晚到的旧结果直接丢。 */
export function requestCoverage(s: AppState, buildingsUrl: string, origin: [number, number], bbox: [number, number, number, number]): void {
  const built = coverageInputFrom(s, bbox, state.heightOverride)
  if ('error' in built) { set({ status: 'error', error: built.error, progress: 0 }); return }
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (ev: MessageEvent<WorkerReply>) => onReply(ev.data)
    worker.onerror = (ev) => set({ status: 'error', error: `后台计算出错：${ev.message}`, progress: 0 })
  }
  const my = ++seq
  pending = { seq: my, targetId: built.targetId, targetName: built.targetName, height: built.input.target.height_agl_m }
  set({ status: 'computing', progress: 0, error: null })
  const msg: ComputeMsg = { kind: 'compute', seq: my, buildingsUrl, origin, input: built.input }
  worker.postMessage(msg)
}

let pending: { seq: number; targetId: string; targetName: string; height: number } | null = null

function onReply(m: WorkerReply): void {
  if (!pending || m.seq !== pending.seq) return   // 过时的结果：已经有更新的请求了
  if (m.kind === 'progress') { set({ progress: m.done }); return }
  if (m.kind === 'error') { set({ status: 'error', error: m.message, progress: 0 }); return }
  arrays = { perSite: m.perSite, combined: m.combined }
  const siteIds = Object.keys(m.perSite)
  const site = state.site === 'all' || siteIds.includes(state.site) ? state.site : 'all'
  set({
    status: state.on ? 'ready' : 'off', progress: 1, site,
    result: {
      targetId: pending.targetId, targetName: pending.targetName, height_agl_m: pending.height,
      nx: m.nx, ny: m.ny, bbox: m.bbox, siteIds,
      m_bins: Object.fromEntries(siteIds.map((id) => [id, m.detector[id]!.m_bins])),
      outOfBand: m.outOfBand, blocked: m.blocked, ms: m.ms, buildingsMs: m.buildingsMs,
    },
  })
}

/** 探针用的摘要（只读，无副作用）。 */
export function coverageProbe(): {
  on: boolean; status: string; site: string; height_agl_m: number | null; cells: number
  pdMax: number | null; contourSegments: number; target: string | null; ms: number | null
} {
  const v = coverageValues()
  let pdMax: number | null = null
  if (v) { pdMax = 0; for (const x of v) if (x > pdMax) pdMax = x }
  const r = state.result
  return {
    on: state.on, status: state.status, site: state.site,
    height_agl_m: r?.height_agl_m ?? null, cells: v ? v.length : 0, pdMax,
    contourSegments: v ? coverageContour().length : 0, target: r?.targetId ?? null, ms: r?.ms ?? null,
  }
}
