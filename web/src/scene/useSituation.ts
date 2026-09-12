// 态势图层的驱动（06 备忘录 §9C G-5）。
//
// 三个数据来源，同一套图层：
//   ① 场景文件 → 站点、辐射源、规划航线、航点（编辑器改一下就重画，低频）；
//   ② 运行中 → WS 的 entity / link 事件进 sceneStore，本 hook 按 20 Hz 定频取值画（高频）；
//   ③ 结束后 → GET /results/{task}/{track,links} 整批取回，按时间游标回放。
//
// 20 Hz 定频而不是每条事件画一次：参数帧最高 100 Hz，一条一画就是每秒一百次 setData。
// 定频 tick 是 docs/display-route.md 第 3 节已冻结的做法（em-demo 同法）。

import { useEffect, useRef } from 'react'
import type { Map as MLMap } from 'maplibre-gl'

import { getBearings, getLinks, getPositions, getTrack } from '../api/client.js'
import { useAppState } from '../state/store.js'
import {
  bearingFromPayload, positionFromPayload, sceneStore,
  type BearingSample, type EntitySample, type LinkSample, type PositionSample,
} from './sceneStore.js'
import { attachFixOverlay } from './layers/fixOverlay.js'
import {
  addSituationLayers, loadSituationIcons,
  setLinks, setPlannedRoute, setSites, setTargets, setTrails, setZones,
} from './layers/situation.js'
import { emitters, posOf, routeOf, sites, splitLinkId, waypointsOf, zoneOf, zones } from './editor/scenarioOps.js'
import { currentSituation, situationRev } from './situationView.js'
import type { ScenarioDoc } from '../state/types.js'

const TICK_MS = 50   // 20 Hz

/** 场景里的静态对象：站点与规划航线。低频，随文档变化重画。 */
export function useScenarioLayers(
  map: MLMap | null,
  ready: boolean,
  doc: ScenarioDoc | null,
  selectedEmitter: string | null,
  selectedWaypoint: number,
): void {
  useEffect(() => {
    if (!map || !ready) return
    setSites(
      map,
      sites(doc).map((s) => {
        const p = posOf(s)!
        return { id: String(s.id), name: String(s.name ?? s.id), lon: p.lon, lat: p.lat }
      }).filter((x) => Number.isFinite(x.lon)),
    )
    const emId = selectedEmitter ?? (emitters(doc)[0] ? String(emitters(doc)[0].id) : null)
    const wps = emId ? waypointsOf(doc, emId) : []
    setPlannedRoute(
      map,
      wps.map((w) => ({ lon: w.position.lon, lat: w.position.lat, alt_m: w.position.alt_m })),
      selectedWaypoint,
    )
    // 告警区（D-061）：圆的多边形近似，随文档变化重画
    setZones(
      map,
      zones(doc).map((z) => {
        const c = z.center as Record<string, number>
        return { id: String(z.id), name: String(z.name ?? z.id), kind: String(z.kind), lon: c.lon, lat: c.lat, radius_m: Number(z.radius_m) }
      }).filter((z) => Number.isFinite(z.lon) && Number.isFinite(z.lat) && z.radius_m > 0),
    )
  }, [map, ready, doc, selectedEmitter, selectedWaypoint])
}

/** 运行态与回看：目标、航迹、链路线。 */
export function useLiveSituation(
  map: MLMap | null, ready: boolean, doc: ScenarioDoc | null, showFix = true, selectedEmitter: string | null = null,
  focusEmitter: string | null = null, allOverlays = false,
): void {
  const s = useAppState()
  const taskId = s.task.id
  const runState = s.task.runState
  const docRef = useRef(doc)
  docRef.current = doc
  // 图层开关与选中都用 ref 传进定频 tick：挂到 useEffect 依赖上会在每次切换时重建叠加层
  const fixRef = useRef(showFix)
  fixRef.current = showFix
  const selRef = useRef(selectedEmitter)
  selRef.current = selectedEmitter
  // 焦点目标与「全部目标叠加」（D-062）：焦点画全套，其余只画图标、航迹与细链路线
  const focusRef = useRef(focusEmitter)
  focusRef.current = focusEmitter
  const allRef = useRef(allOverlays)
  allRef.current = allOverlays

  // 换任务即清空实时数据：上一个任务的航迹不该留在图上。
  // **只挂 taskId**：挂上 map / ready 会在地图就绪那一刻把已经取回的航迹又清掉——
  // 瓦片要两秒，取航迹只要几十毫秒，顺序必然是「先取到、后清掉」，画面上什么都没有。
  // 地图那边不必显式清：清空后 rev 会变，下一次定频 tick 自然画成空。
  useEffect(() => {
    sceneStore.reset()
  }, [taskId])

  // 任务结束后从产品文件整批取回：突发下 WS 会丢帧，只有文件才是完整的（与 U-3 的结束即收口同理）
  useEffect(() => {
    if (!taskId || runState !== 'finished') return
    let alive = true
    void (async () => {
      try {
        const [track, links] = await Promise.all([
          getTrack(taskId, 0, 1e9, 1),
          getLinks(taskId, 0, 1e9, 1),
        ])
        if (!alive || !track.length) return
        sceneStore.replaceFromTrack(track as unknown as EntitySample[], links as unknown as LinkSample[])
        // 测向与定位同样从文件补齐（D-053）：突发下 WS 会丢帧，只有文件才完整。
        // 两个端点在没有测向节点的任务上 404，getJsonlWindow 会返回空数组，不当错误。
        const [bs, ps] = await Promise.all([
          getBearings(taskId, 0, 1e9, 1),
          getPositions(taskId, 0, 1e9, 1),
        ])
        if (!alive) return
        const bearings: BearingSample[] = []
        for (const r of bs) {
          const b = bearingFromPayload(typeof r.t_s === 'number' ? r.t_s : 0, r)
          if (b) bearings.push(b)
        }
        const positions: PositionSample[] = []
        for (const r of ps) {
          const q = positionFromPayload(typeof r.t_s === 'number' ? r.t_s : 0, r)
          if (q) positions.push(q)
        }
        if (bearings.length || positions.length) sceneStore.replaceFromReports(bearings, positions)
      } catch {
        /* 端点 404（无场景绑定的任务）属正常，保持 WS 收到的内容 */
      }
    })()
    return () => { alive = false }
  }, [taskId, runState])

  // 定频取值画图
  useEffect(() => {
    if (!map || !ready) return
    const overlay = attachFixOverlay(map)
    let rev = ''
    let fixShown = fixRef.current
    let selShown = selRef.current
    let docShown = docRef.current
    let focusShown = focusRef.current
    let allShown = allRef.current
    const timer = window.setInterval(() => {
      // 数据、时间轴（回放时刻 / 模式）、图层开关、选中、焦点或场景文档（告警区）任一变了才重画
      const now = situationRev()
      if (now === rev && fixShown === fixRef.current && selShown === selRef.current && docShown === docRef.current
          && focusShown === focusRef.current && allShown === allRef.current) return
      rev = now
      fixShown = fixRef.current
      selShown = selRef.current
      docShown = docRef.current
      focusShown = focusRef.current
      allShown = allRef.current
      const all = allRef.current
      const focus = focusRef.current
      const d = docRef.current
      // live 取每键最新；回放按时间轴的 t 取历史快照；没历史时走航迹预览（13 §5.3）
      const st = currentSituation(d)
      // 入圈判定（D-061，13 §4.3）：纯几何，每 tick 对每个实体算一次；选中环跟着选中走
      const targets = [] as Array<EntitySample & { alert: boolean; selected: boolean; focus: boolean }>
      st.entities.forEach((e) => targets.push({
        ...e, alert: zoneOf(d, e.lon, e.lat, e.alt_m) !== null, selected: e.id === selRef.current, focus: all || e.id === focus,
      }))
      setTargets(map, targets)
      setTrails(map, st.trails, all ? null : focus)

      // 链路线：站点位置来自场景文件，目标位置来自实时状态
      const lines: Array<{ link_id: string; from: [number, number]; to: [number, number]; line_of_sight: boolean; distance_m: number; focus: boolean }> = []
      st.links.forEach((l) => {
        // 按已知的站与源精确匹配，不按连字符拆（D-061）
        const ids = splitLinkId(d, l.link_id)
        if (!ids) return
        const sp = posOf(sites(d).find((x) => x.id === ids.site))
        const tgt = st.entities.get(ids.emitter)
        if (!sp || !tgt) return
        lines.push({
          link_id: l.link_id,
          from: [sp.lon, sp.lat],
          to: [tgt.lon, tgt.lat],
          line_of_sight: l.line_of_sight,
          distance_m: l.distance_m,
          focus: all || ids.emitter === focus,
        })
      })
      setLinks(map, lines)

      // 测向线与定位椭圆走 Canvas 叠加层，与上面同一次 tick 重画（D-053 §5.4）
      if (overlay && fixRef.current) {
        const sitePos = new Map<string, { lon: number; lat: number }>()
        for (const x of sites(d)) {
          const q = posOf(x)
          if (q) sitePos.set(String(x.id), { lon: q.lon, lat: q.lat })
        }
        const bs: BearingSample[] = []
        st.bearings.forEach((b) => bs.push(b))
        const ps: PositionSample[] = []
        st.positions.forEach((q) => ps.push(q))
        overlay.draw({ sites: sitePos, bearings: bs, positions: ps, dev: devMode(), focusId: all ? null : focus })
      } else if (overlay) {
        // 关掉图层要真的清空，不是留着上一帧
        overlay.draw({ sites: new Map(), bearings: [], positions: [], dev: false })
      }
    }, TICK_MS)
    return () => {
      window.clearInterval(timer)
      if (overlay) overlay.destroy()
    }
  }, [map, ready])
}

/** 开发者模式：地址栏带 ?dev=1 时才画标签（D-039，界面不主动解释）。 */
function devMode(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('dev') === '1'
  } catch {
    return false
  }
}

/** 图层与图标的一次性挂载。style.load 与 idle 都会调，内部去重。 */
export function mountSituation(map: MLMap): void {
  addSituationLayers(map)
  void loadSituationIcons(map)
}

/** 没有航线时，辐射源自身的位置也要画出来（否则编辑器里看不见它）。 */
export function emitterFallbackPoints(doc: ScenarioDoc | null): Array<{ id: string; lon: number; lat: number }> {
  const out: Array<{ id: string; lon: number; lat: number }> = []
  for (const e of emitters(doc)) {
    if (routeOf(doc, String(e.id))) continue
    const p = posOf(e)
    if (p) out.push({ id: String(e.id), lon: p.lon, lat: p.lat })
  }
  return out
}
