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

import { getLinks, getTrack } from '../api/client.js'
import { useAppState } from '../state/store.js'
import { sceneStore, type EntitySample, type LinkSample } from './sceneStore.js'
import {
  addSituationLayers, loadSituationIcons,
  setLinks, setPlannedRoute, setSites, setTargets, setTrails,
} from './layers/situation.js'
import { emitters, posOf, routeOf, sites, waypointsOf } from './editor/scenarioOps.js'
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
  }, [map, ready, doc, selectedEmitter, selectedWaypoint])
}

/** 运行态与回看：目标、航迹、链路线。 */
export function useLiveSituation(map: MLMap | null, ready: boolean, doc: ScenarioDoc | null): void {
  const s = useAppState()
  const taskId = s.task.id
  const runState = s.task.runState
  const docRef = useRef(doc)
  docRef.current = doc

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
      } catch {
        /* 端点 404（无场景绑定的任务）属正常，保持 WS 收到的内容 */
      }
    })()
    return () => { alive = false }
  }, [taskId, runState])

  // 定频取值画图
  useEffect(() => {
    if (!map || !ready) return
    let rev = -1
    const timer = window.setInterval(() => {
      const st = sceneStore.get()
      if (st.rev === rev) return
      rev = st.rev
      const targets: Array<EntitySample> = []
      st.entities.forEach((e) => targets.push(e))
      setTargets(map, targets)
      setTrails(map, st.trails)

      // 链路线：站点位置来自场景文件，目标位置来自实时状态
      const d = docRef.current
      const lines: Array<{ link_id: string; from: [number, number]; to: [number, number]; line_of_sight: boolean; distance_m: number }> = []
      st.links.forEach((l) => {
        const dash = l.link_id.lastIndexOf('-')
        const siteId = dash > 0 ? l.link_id.slice(0, dash) : ''
        const emId = dash > 0 ? l.link_id.slice(dash + 1) : ''
        const site = sites(d).find((x) => x.id === siteId)
        const sp = posOf(site)
        const tgt = st.entities.get(emId)
        if (!sp || !tgt) return
        lines.push({
          link_id: l.link_id,
          from: [sp.lon, sp.lat],
          to: [tgt.lon, tgt.lat],
          line_of_sight: l.line_of_sight,
          distance_m: l.distance_m,
        })
      })
      setLinks(map, lines)
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [map, ready])
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
