// 「现在该显示哪一帧」（13 报告 §5.3，D-061）：地图 tick、卡片栈与探针都从这里取，三处才不会各说各话。
//
// live：sceneStore 里每键最新一帧（今天的行为）；replay：按时间轴的 t 从历史里二分取最后一条 ≤ t 的样点。
// 没跑过任务（历史为空）时回放走浏览器航迹预览（RoutePreview / ActivityPreview，与 C++ 同式、逐点对拍过），
// 这样运行前也能拖着看航线；此时只有实体，没有链路 / 测向 / 定位（前端不做物理，docs/scenario-format.md §1）。

import type { ScenarioDoc } from '../state/types.js'
import { timeStore } from '../shell/timeStore.js'
import { sceneStore, type BearingSample, type EntitySample, type LinkSample, type PositionSample } from './sceneStore.js'
import { activities, emitters, posOf, routeOf, waypointsOf } from './editor/scenarioOps.js'
import { ActivityPreview, RoutePreview } from './editor/preview.js'

export interface SituationView {
  entities: Map<string, EntitySample>
  links: Map<string, LinkSample>
  bearings: Map<string, BearingSample>
  positions: Map<string, PositionSample>
  trails: Map<string, Array<[number, number]>>
  /** live = 每键最新；replay = 历史快照；preview = 无历史时的浏览器航迹预览 */
  source: 'live' | 'replay' | 'preview'
  t: number | null
}

interface PreviewSet { routes: Map<string, RoutePreview>; acts: Map<string, ActivityPreview>; center: Map<string, number> }
const previewCache = new WeakMap<object, PreviewSet>()

function previewsOf(doc: ScenarioDoc): PreviewSet {
  const hit = previewCache.get(doc)
  if (hit) return hit
  const routes = new Map<string, RoutePreview>()
  const acts = new Map<string, ActivityPreview>()
  const center = new Map<string, number>()
  const actList = activities(doc)
  for (const e of emitters(doc)) {
    const id = String(e.id)
    const r = routeOf(doc, id)
    const wps = waypointsOf(doc, id)
    const p = posOf(e)
    const pts = wps.length ? wps : p ? [{ position: p, speed_mps: 0 }] : []
    routes.set(id, new RoutePreview(pts, r?.loop === true))
    const f = (e.emission as Record<string, unknown> | undefined)?.center_Hz
    center.set(id, typeof f === 'number' ? f : 0)
    acts.set(id, new ActivityPreview(actList, id, typeof f === 'number' ? f : 0))
  }
  const set = { routes, acts, center }
  previewCache.set(doc, set)
  return set
}

/** 浏览器预览：把航线状态机在 t 处的值装成实体样点。 */
export function previewEntities(doc: ScenarioDoc | null, t: number): Map<string, EntitySample> {
  const out = new Map<string, EntitySample>()
  if (!doc) return out
  const pv = previewsOf(doc)
  pv.routes.forEach((route, id) => {
    const m = route.stateAt(t)
    const act = pv.acts.get(id)
    out.set(id, {
      t_s: t, id, lon: m.position.lon, lat: m.position.lat, alt_m: m.position.alt_m,
      heading_deg: m.heading_deg, speed_mps: m.speed_mps,
      tx_on: act ? act.txOnAt(t) : true, center_Hz: act ? act.centerHzAt(t) : (pv.center.get(id) ?? 0),
    })
  })
  return out
}

export function currentSituation(doc: ScenarioDoc | null): SituationView {
  const ts = timeStore.get()
  const st = sceneStore.get()
  if (ts.mode === 'replay' && ts.t !== null) {
    if (sceneStore.hasHistory()) {
      const snap = sceneStore.snapshotAt(ts.t)
      return { ...snap, source: 'replay', t: ts.t }
    }
    return { entities: previewEntities(doc, ts.t), links: new Map(), bearings: new Map(), positions: new Map(), trails: new Map(), source: 'preview', t: ts.t }
  }
  return { entities: st.entities, links: st.links, bearings: st.bearings, positions: st.positions, trails: st.trails, source: 'live', t: null }
}

/** 一个数，变了就说明画面该重算：sceneStore 的版本号 + 时间轴的 t 与模式。 */
export function situationRev(): string {
  const ts = timeStore.get()
  return `${sceneStore.get().rev}|${ts.mode}|${ts.t ?? ''}`
}
