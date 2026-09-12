// 地理场景视图：离线底图 + 山体阴影 + 观测区域建筑的三维拉伸 + 区域边界 + 态势与场景编辑。
//
// 数据全部来自本地服务，运行时不联网（铁律 6）。底图经 HTTP Range 按需取瓦片（铁律 7）。
// 地图只建一次：视图切换只是隐藏容器（visibility），本组件不卸载；显示时 map.resize() 一次（09 §4.2）。
//
// 切片 ② 起：左栏是场景对象树，右栏是对象表单与链路读数，工具条上四个工具（09 §5）。
// 切片 ⑧ 起（D-061）：右栏常驻目标与站点卡片栈，选中对象时表单叠在栈顶（RightColumn）。
// 地图上的交互（点选、布站、画航点、拖动、测量）都在这里绑，画图在 useSituation，
// 改文档在 editor/scenarioOps——三者分开，免得一个 useEffect 里既算几何又改状态。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Map as MLMap, MapMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { protomapsStyle } from './style/protomaps.js'
import { registerProtocols, newMap } from './init.js'
import { addHillshade, removeHillshade } from './layers/hillshade.js'
import { addBuildings3d, setBuildingsColorBySrc } from './layers/buildings3d.js'
import { addAoiBoundary, bboxContains } from './layers/aoiBoundary.js'
import { installProbe } from './probe.js'
import { ScenePackagePanel } from './ScenePackagePanel.js'
import { MapToolbar } from './MapToolbar.js'
import { ObjectTree } from './ObjectTree.js'
import { RightColumn } from './RightColumn.js'
import { ColumnLayout } from '../shell/ColumnLayout.js'
import { cursorStore } from '../shell/cursorStore.js'
import { useAppState, useStore } from '../state/store.js'
import { saveScenario } from '../shell/actions.js'
import { mountSituation, useLiveSituation, useScenarioLayers } from './useSituation.js'
import { clearSituation, setLayersVisible } from './layers/situation.js'
import { addEmitter, addSite, addWaypoint, addZone, emitters, moveSite, moveWaypoint } from './editor/scenarioOps.js'

export function SceneView({ active }: { active: boolean }) {
  const s = useAppState()
  const store = useStore()
  const scene = s.scene.summary
  const dev = s.ui.devMode
  const box = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const [hill, setHill] = useState(true)
  const [bySrc, setBySrc] = useState(false)
  const [flat, setFlat] = useState(false)
  const [situation, setSituation] = useState(true)
  const [fix, setFix] = useState(true)
  const [zonesOn, setZonesOn] = useState(true)
  const [poles, setPoles] = useState(true)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)

  // 交互回调要读最新的 store，但地图事件只绑一次：用 ref 传当前值，不把 store 塞进依赖。
  const live = useRef({ state: s, store })
  live.current = { state: s, store }

  // 建图：只在场景摘要就绪且尚无地图时建一次
  useEffect(() => {
    if (!scene || !box.current || mapRef.current) return
    registerProtocols()
    const map = newMap({
      container: box.current,
      style: protomapsStyle({ url: scene.basemapUrl, maxzoom: 15 }),
      center: scene.center,
      zoom: 14.2,
    })
    mapRef.current = map
    const uninstall = installProbe(map)
    const mount = () => {
      if (!map.isStyleLoaded()) return
      addBuildings3d(map, { data: scene.buildingsUrl })
      if (hill) addHillshade(map, { tiles: scene.demTiles })
      addAoiBoundary(map, scene.bbox)
      mountSituation(map)
      setReady(true)
    }
    map.on('style.load', mount)
    map.on('idle', mount)

    // 鼠标经纬度：节流 100 ms 进独立的小 store，不经主 store
    let last = 0
    let pending: { lng: number; lat: number } | null = null
    let timer: number | null = null
    const flush = () => {
      timer = null
      if (pending) { cursorStore.set({ lng: pending.lng, lat: pending.lat, insideAoi: bboxContains(scene.bbox, pending.lng, pending.lat) }); pending = null }
      last = performance.now()
    }
    const onMove = (e: { lngLat: { lng: number; lat: number } }) => {
      pending = { lng: e.lngLat.lng, lat: e.lngLat.lat }
      const wait = 100 - (performance.now() - last)
      if (timer === null) timer = window.setTimeout(flush, Math.max(0, wait))
    }
    const onOut = () => { pending = null; cursorStore.set(null) }
    map.on('mousemove', onMove)
    map.on('mouseout', onOut)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      map.off('mousemove', onMove)
      map.off('mouseout', onOut)
      map.off('style.load', mount)
      map.off('idle', mount)
      uninstall()
      map.remove()
      mapRef.current = null
      setReady(false)
    }
    // hill 的初值只在建图时用一次，后续切换由下一个 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene])

  // ---- 地图交互：四个工具（09 §5.2）。只绑一次，通过 live.current 读最新状态。 ----
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const currentEmitter = (): string | null => {
      const st = live.current.state
      const sel = st.scene.editor.selection
      if (sel && (sel.kind === 'emitter' || sel.kind === 'waypoint')) return sel.id
      const first = emitters(st.scene.scenario.doc)[0]
      return first ? String(first.id) : null
    }

    const onClick = (e: MapMouseEvent) => {
      const { state, store: st } = live.current
      const doc = state.scene.scenario.doc
      const tool = state.scene.editor.tool
      const { lng, lat } = e.lngLat

      if (tool === 'measure') {
        const pts = state.scene.editor.measure
        const next = pts.length >= 2 ? [{ lon: lng, lat }] : [...pts, { lon: lng, lat }]
        st.dispatch({ type: 'scene/measure', points: next })
        return
      }
      if (!doc) return
      if (tool === 'site') {
        if (scene && !bboxContains(scene.bbox, lng, lat)) {
          st.dispatch({ type: 'ui/toast', kind: 'warn', text: '站点放在了观测区域之外：那里没有建筑数据，视距判定不可信' })
        }
        const r = addSite(doc, lng, lat)
        st.dispatch({ type: 'scene/edit', doc: r.doc })
        st.dispatch({ type: 'scene/select', selection: { kind: 'site', id: r.id } })
        st.dispatch({ type: 'scene/tool', tool: 'select' })   // 放完回到选择（09 §5.2）
        return
      }
      if (tool === 'emitter') {
        if (scene && !bboxContains(scene.bbox, lng, lat)) {
          st.dispatch({ type: 'ui/toast', kind: 'warn', text: '目标放在了观测区域之外：那里没有建筑数据，视距判定不可信' })
        }
        const r = addEmitter(doc, lng, lat)
        st.dispatch({ type: 'scene/edit', doc: r.doc })
        st.dispatch({ type: 'scene/select', selection: { kind: 'emitter', id: r.id } })
        st.dispatch({ type: 'scene/tool', tool: 'select' })
        return
      }
      if (tool === 'waypoint') {
        const em = currentEmitter()
        if (!em) return
        const next = addWaypoint(doc, em, lng, lat)
        st.dispatch({ type: 'scene/edit', doc: next })
        return
      }
      if (tool === 'zone') {
        const r = addZone(doc, lng, lat)
        st.dispatch({ type: 'scene/edit', doc: r.doc })
        st.dispatch({ type: 'scene/select', selection: { kind: 'zone', id: r.id } })
        st.dispatch({ type: 'scene/tool', tool: 'select' })
        return
      }
      // 选择工具：点中站点、航点、目标或告警区即选中（点要素压在面要素之上，先命中点）
      const hits = map.queryRenderedFeatures(e.point, {
        layers: ['cuav-site-dot', 'cuav-waypoint-dot', 'cuav-target-icon', 'cuav-zone-fill'],
      })
      const f = hits[0]
      if (!f) { st.dispatch({ type: 'scene/select', selection: null }); return }
      if (f.layer.id === 'cuav-zone-fill') {
        st.dispatch({ type: 'scene/select', selection: { kind: 'zone', id: String(f.properties?.id) } })
      } else if (f.layer.id === 'cuav-site-dot') {
        st.dispatch({ type: 'scene/select', selection: { kind: 'site', id: String(f.properties?.id) } })
      } else if (f.layer.id === 'cuav-waypoint-dot') {
        const em = currentEmitter()
        if (em) st.dispatch({ type: 'scene/select', selection: { kind: 'waypoint', id: em, index: Number(f.properties?.index ?? 0) } })
      } else {
        // 点目标就选中那个辐射源（D-053 §5.3）。原来这里硬接 sites[0] 拼出一条链路，
        // 多站之后「第一个站」不再有意义，而用户点的本来就是目标不是链路。
        st.dispatch({ type: 'scene/select', selection: { kind: 'emitter', id: String(f.properties?.id) } })
      }
    }

    const onDblClick = () => {
      const { state, store: st } = live.current
      if (state.scene.editor.tool === 'waypoint') st.dispatch({ type: 'scene/tool', tool: 'select' })
    }

    // 拖动：一次拖动一步撤销——按下时记住对象，松开时才写一次 scene/edit（09 §5.2）
    let drag: { kind: 'site' | 'waypoint'; id: string; index: number } | null = null
    const onDown = (e: MapMouseEvent) => {
      const { state } = live.current
      if (state.scene.editor.tool !== 'select' || !state.scene.scenario.doc) return
      const hits = map.queryRenderedFeatures(e.point, { layers: ['cuav-site-dot', 'cuav-waypoint-dot'] })
      const f = hits[0]
      if (!f) return
      if (f.layer.id === 'cuav-site-dot') drag = { kind: 'site', id: String(f.properties?.id), index: -1 }
      else {
        const sel = state.scene.editor.selection
        const em = sel && (sel.kind === 'emitter' || sel.kind === 'waypoint') ? sel.id
          : String(emitters(state.scene.scenario.doc)[0]?.id ?? '')
        if (!em) return
        drag = { kind: 'waypoint', id: em, index: Number(f.properties?.index ?? 0) }
      }
      map.dragPan.disable()
      e.preventDefault()
    }
    const onUp = (e: MapMouseEvent) => {
      if (!drag) return
      const { state, store: st } = live.current
      const doc = state.scene.scenario.doc
      if (doc) {
        const next = drag.kind === 'site'
          ? moveSite(doc, drag.id, e.lngLat.lng, e.lngLat.lat)
          : moveWaypoint(doc, drag.id, drag.index, e.lngLat.lng, e.lngLat.lat)
        st.dispatch({ type: 'scene/edit', doc: next })
      }
      drag = null
      map.dragPan.enable()
    }

    map.on('click', onClick)
    map.on('dblclick', onDblClick)
    map.on('mousedown', onDown)
    map.on('mouseup', onUp)
    return () => {
      map.off('click', onClick)
      map.off('dblclick', onDblClick)
      map.off('mousedown', onDown)
      map.off('mouseup', onUp)
    }
  }, [ready, scene])

  // Esc 结束连续画航点 / 退出测量
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const st = live.current
      if (st.state.scene.editor.tool !== 'select') st.store.dispatch({ type: 'scene/tool', tool: 'select' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const selEmitter = s.scene.editor.selection && 'id' in s.scene.editor.selection ? s.scene.editor.selection.id : null
  const selWp = s.scene.editor.selection?.kind === 'waypoint' ? s.scene.editor.selection.index : -1
  const selTarget = s.scene.editor.selection?.kind === 'emitter' ? s.scene.editor.selection.id : null
  useScenarioLayers(situation ? mapRef.current : null, ready, s.scene.scenario.doc, selEmitter, selWp)
  useLiveSituation(situation ? mapRef.current : null, ready, s.scene.scenario.doc, fix, selTarget)

  // 告警区与高度立柱的显隐（D-061）
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    setLayersVisible(map, ['cuav-zone-fill', 'cuav-zone-line'], zonesOn)
  }, [zonesOn, ready])
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    setLayersVisible(map, ['cuav-target-pole'], poles)
  }, [poles, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    if (!situation) clearSituation(map)
  }, [situation, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !scene || !map.isStyleLoaded()) return
    if (hill) addHillshade(map, { tiles: scene.demTiles })
    else removeHillshade(map)
  }, [hill, scene])

  useEffect(() => {
    if (mapRef.current) setBuildingsColorBySrc(mapRef.current, bySrc)
  }, [bySrc])

  useEffect(() => {
    if (active && mapRef.current) mapRef.current.resize()
  }, [active])

  const onFlat = () => {
    const map = mapRef.current
    if (!map) return
    const next = !flat
    setFlat(next)
    map.easeTo({ pitch: next ? 0 : 55, duration: 400 })
  }

  const onFlyTo = useCallback((lon: number, lat: number) => {
    mapRef.current?.easeTo({ center: [lon, lat], duration: 500 })
  }, [])

  // 保存的实现搬到 `shell/actions.ts` 了（D-054）：框图页也要保存场景，两处得是同一条路径
  const onSave = useCallback(async () => {
    setSaving(true)
    try {
      if (await saveScenario(live.current.store)) {
        live.current.store.dispatch({ type: 'ui/toast', kind: 'info', text: '场景已保存' })
      }
    } finally {
      setSaving(false)
    }
  }, [])

  return (
    <ColumnLayout
      left={<>
        <ScenePackagePanel scene={scene} error={s.scene.error} dev={dev} />
        <ObjectTree onFlyTo={onFlyTo} />
      </>}
      center={
        <div className="scene">
          <div ref={box} className="scene-map" />
          <MapToolbar hill={hill} onHill={setHill} bySrc={bySrc} onBySrc={setBySrc} flat={flat} onFlat={onFlat}
                      situation={situation} onSituation={setSituation} fix={fix} onFix={setFix}
                      zonesOn={zonesOn} onZones={setZonesOn} poles={poles} onPoles={setPoles}
                      onSave={() => void onSave()} saving={saving} />
        </div>
      }
      right={<RightColumn />}
    />
  )
}
