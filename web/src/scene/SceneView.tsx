// 地理场景视图：离线底图 + 山体阴影 + 观测区域建筑的三维拉伸 + 区域边界。
//
// 数据全部来自本地服务，运行时不联网（铁律 6）。底图经 HTTP Range 按需取瓦片（铁律 7）。
// 地图只建一次：视图切换只是隐藏容器（visibility），本组件不卸载；显示时 map.resize() 一次（09 §4.2）。
// 场景数据包与开发者模式都来自 store，这里不再读 location.search。

import { useEffect, useRef, useState } from 'react'
import type { Map as MLMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { protomapsStyle } from './style/protomaps.js'
import { registerProtocols, newMap } from './init.js'
import { addHillshade, removeHillshade } from './layers/hillshade.js'
import { addBuildings3d, setBuildingsColorBySrc } from './layers/buildings3d.js'
import { addAoiBoundary, bboxContains } from './layers/aoiBoundary.js'
import { installProbe } from './probe.js'
import { ScenePackagePanel } from './ScenePackagePanel.js'
import { MapToolbar } from './MapToolbar.js'
import { ColumnLayout } from '../shell/ColumnLayout.js'
import { cursorStore } from '../shell/cursorStore.js'
import { useAppState } from '../state/store.js'

export function SceneView({ active }: { active: boolean }) {
  const s = useAppState()
  const scene = s.scene.summary
  const dev = s.ui.devMode
  const box = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const [hill, setHill] = useState(true)
  const [bySrc, setBySrc] = useState(false)
  const [flat, setFlat] = useState(false)

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
      // 只在真正卸载或换场景时走到这里；视图切换不会触发（09 §4.2）
      if (timer !== null) window.clearTimeout(timer)
      map.off('mousemove', onMove)
      map.off('mouseout', onOut)
      uninstall()
      map.remove()
      mapRef.current = null
    }
    // hill 的初值只在建图时用一次，后续切换由下一个 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !scene || !map.isStyleLoaded()) return
    if (hill) addHillshade(map, { tiles: scene.demTiles })
    else removeHillshade(map)
  }, [hill, scene])

  useEffect(() => {
    if (mapRef.current) setBuildingsColorBySrc(mapRef.current, bySrc)
  }, [bySrc])

  // 显示时补一次尺寸：隐藏期间栏宽可能变了
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

  return (
    <ColumnLayout
      left={<>
        <ScenePackagePanel scene={scene} error={s.scene.error} dev={dev} />
        <div className="group placeholder">场景对象树（切片 ② 启用）</div>
      </>}
      center={
        <div className="scene">
          <div ref={box} className="scene-map" />
          <MapToolbar hill={hill} onHill={setHill} bySrc={bySrc} onBySrc={setBySrc} flat={flat} onFlat={onFlat} />
        </div>
      }
      right={<div className="group placeholder">链路读数（切片 ② 启用）</div>}
    />
  )
}
