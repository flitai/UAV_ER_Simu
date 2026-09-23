// 视距探测（D3-7，D-074；07 报告 §2.4、§9.3）：点地图任一点，对焦点站算视距与刀口绕射损耗。
//
// **为什么它值得单独做一个交互**：切片 ⑤ 的验收里有一条「点选建筑两侧一致」——楼后那一侧必须
// 非视距、楼前那一侧必须视距。遮挡落点选了「浏览器也算一份」（D-074 ①）之后，这条从「布两次目标
// 各跑一次任务」变成一次点击就能验的事，D4「渲染—物理同源」也因此第一次能在同一个进程里验。
//
// **不新造物理**：视距与刀口损耗全部来自 `occlusion/`，那份与 C++ 同守 `tests/golden/occlusion.json`
// 的 148 例与真实建筑集五条射线（D3-6）。这里只做三件事：把场景里的量取出来、投到平面帧、把结果摆出来。
// 自由空间路损**有意不算**——浏览器里没有第二份 `fspl_dB`，为了一行读数新造一份无人守着的物理不划算。
//
// 与 C++ `link_geometry()`（geo/src/link_budget.cpp）逐句对应的三处：
//   · 端点的 z 取**离地高差** `alt_m − terrainHeight_m`，不是 ENU 的 up（铁律 2）；
//   · `line_of_sight = !blocked`，**与损耗大小无关**（掠射只损几分贝也算非视距，07 §5.1）；
//   · 刀口损耗**单程 ×1**，不乘 2。

import type { AppState, ScenarioDoc } from '../state/types.js'
import { lookAngles, type Lla } from './editor/preview.js'
import { emitters, posOf, sites, type Obj } from './editor/scenarioOps.js'
import { currentSituation } from './situationView.js'
import { focusSiteId, focusTargetId } from './focus.js'
import { ensureOcclusion, occlusionFrame, occlusionMap } from './occlusion/store.js'
import { segmentOcclusion } from './occlusion/occlusion.js'
import type { SceneFrame } from './occlusion/frame.js'
import type { LocalSceneAdapter } from './occlusion/adapter.js'

export interface LosProbeInput {
  site_id: string
  site_name: string
  /** 站址与站的离地高（m，AGL） */
  site: Lla
  /** 被点的那一点，经纬度 */
  lon: number
  lat: number
  /** 假设目标在这一点上的离地高（m，AGL）。地面点的视距与 100 m 处的视距是两回事，所以它必须写出来 */
  height_agl_m: number
  /** 算刀口损耗要波长；取焦点目标的发射中心频率，没有就取站的接收中心频率 */
  frequency_Hz: number
}

export interface LosProbeResult extends LosProbeInput {
  distance_m: number
  azimuth_deg: number
  elevation_deg: number
  line_of_sight: boolean
  /** 单程刀口绕射损耗（dB）；视距时为 0 */
  diffraction_dB: number
  /** 视线侵入建筑的竖直深度（m），仅信息性 */
  intrusion_m: number
}

/** 纯函数：两个端点投到平面帧，调同一份遮挡复算。单测直接对着它跑。 */
export function computeLosProbe(map: LocalSceneAdapter, frame: SceneFrame,
                                input: LosProbeInput): LosProbeResult {
  const target: Lla = { lon: input.lon, lat: input.lat, alt_m: input.height_agl_m }
  const g = lookAngles(input.site, target)
  const tx = frame.point(input.lon, input.lat, input.height_agl_m)
  const rx = frame.point(input.site.lon, input.site.lat, input.site.alt_m)
  const r = segmentOcclusion(map, tx, rx, input.frequency_Hz)
  return {
    ...input,
    distance_m: g.distance_m,
    azimuth_deg: g.azimuth_deg,
    elevation_deg: g.elevation_deg,
    line_of_sight: !r.blocked,
    diffraction_dB: r.obstructionLossDb,
    intrusion_m: r.intrusionM,
  }
}

function num(v: unknown, def = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : def
}

/** 显式平地假设的参考平面（铁律 2）：站与目标的离地高都由 `alt_m` 减掉它得出。 */
function terrainHeightM(doc: ScenarioDoc | null): number {
  const c = doc?.coordinate as Record<string, unknown> | undefined
  return num(c?.terrainHeight_m, 0)
}

function centerHzOf(e: Obj | undefined): number {
  return num((e?.emission as Record<string, unknown> | undefined)?.center_Hz, 0)
}

/**
 * 把「点了地图哪一点」变成一次可算的探测输入。取不到站、取不到频率都返回说明，不编缺省值（铁律 15）。
 *
 * 假设高度缺省取**焦点目标此刻的离地高**——探测回答的是「把这架无人机挪到这儿会怎样」，
 * 贴地和 120 米是两个完全不同的答案。用户可以在卡片上改它。
 */
export function probeInputAt(s: AppState, lon: number, lat: number, heightOverride?: number):
    { input: LosProbeInput } | { error: string } {
  const doc = s.scene.scenario.doc
  if (!doc) return { error: '未载入场景' }
  const siteId = focusSiteId(s)
  const site = sites(doc).find((x) => String(x.id) === siteId)
  const p = posOf(site)
  if (!site || !p) return { error: '场景中无侦测站，无法计算视距' }

  const terrain = terrainHeightM(doc)
  const focusId = focusTargetId(s)
  const em = emitters(doc).find((x) => String(x.id) === focusId)
  const live = currentSituation(doc).entities.get(focusId ?? '')
  const defaultHeight = live ? live.alt_m - terrain : num(posOf(em)?.alt_m, 0) - terrain
  const frequency = centerHzOf(em) || num((site.receiver as Record<string, unknown> | undefined)?.center_Hz, 0)
  if (!(frequency > 0)) return { error: '无法确定工作频率：焦点目标与侦测站均未设置中心频率' }

  return {
    input: {
      site_id: String(site.id),
      site_name: String(site.name ?? site.id),
      site: { lon: p.lon, lat: p.lat, alt_m: p.alt_m - terrain },
      lon,
      lat,
      height_agl_m: heightOverride !== undefined ? heightOverride : defaultHeight,
      frequency_Hz: frequency,
    },
  }
}

// ------------------------------------------------------------------ 外部小 store

export interface LosProbeState {
  /** 'idle' 没探测过 | 'loading' 正在取建筑几何 | 'ready' 有结果 | 'error' 说得出缘由 */
  status: 'idle' | 'loading' | 'ready' | 'error'
  result: LosProbeResult | null
  error: string | null
  /**
   * 用户在卡片上固定下来的假设高度；`null` = 跟随焦点目标此刻的离地高。
   *
   * **它必须是黏的**：楼两侧各点一次是这个交互的主要用法，若每点一次高度就跳回焦点目标那一档，
   * 第二次点出来的答案与第一次不可比，而画面上还看不出来变过。
   */
  heightOverride: number | null
}

const IDLE: LosProbeState = { status: 'idle', result: null, error: null, heightOverride: null }
let state: LosProbeState = IDLE
const subs = new Set<() => void>()
function emit(): void { for (const f of subs) f() }

export const losProbeStore = {
  get: (): LosProbeState => state,
  subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f) } },
  clear(): void { state = IDLE; emit() },
  setHeight(h: number | null): void { state = { ...state, heightOverride: h }; emit() },
  /** 只给单测用 */
  setForTest(next: LosProbeState): void { state = next; emit() },
}

/**
 * 跑一次探测。第一次会把 15.9 MB 的建筑几何取下来（懒加载，D3-6），所以是异步的；
 * 之后每次点击都是本地算，几微秒（07 §11 实测单次射线 0.6–6.7 µs）。
 */
export async function runLosProbe(buildingsUrl: string, originLon: number, originLat: number,
                                  input: LosProbeInput): Promise<LosProbeResult | null> {
  if (!occlusionMap()) {
    state = { ...state, status: 'loading', error: null }
    emit()
  }
  await ensureOcclusion(buildingsUrl, originLon, originLat)
  const map = occlusionMap()
  const frame = occlusionFrame()
  if (!map || !frame) {
    // 取不到就说取不到，**不退回「一律视距」**（铁律 15；07 §2.3 最后一行）
    state = { ...state, status: 'error', result: null, error: '建筑几何未加载，无法计算视距' }
    emit()
    return null
  }
  const result = computeLosProbe(map, frame, input)
  state = { ...state, status: 'ready', result, error: null }
  emit()
  return result
}
