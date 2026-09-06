// 地理场景视图：离线底图 + 山体阴影 + 观测区域建筑的三维拉伸。
//
// 数据全部来自本地服务，运行时不联网（铁律 6）。底图经 HTTP Range 按需取瓦片（铁律 7）。

import { useEffect, useRef, useState } from 'react'
import type { Map as MLMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { protomapsStyle } from './style/protomaps.js'
import { registerProtocols, newMap } from './init.js'
import { addHillshade, removeHillshade } from './layers/hillshade.js'
import { addBuildings3d, setBuildingsColorBySrc } from './layers/buildings3d.js'
import { installProbe } from './probe.js'
import { listScenes, loadScene, type SceneSummary } from './scenePackage.js'

export function SceneView() {
  const box = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const [scene, setScene] = useState<SceneSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hill, setHill] = useState(true)
  const [bySrc, setBySrc] = useState(false)
  // 开发者模式（?dev=1，D-039 修正）：只有内部诊断才显示高度来源分色与来源占比。
  // 正常界面不解释建筑高度从哪来——演示系统只要求高度合理可算，标记留在数据字段与文档里（D-042b）。
  const dev = new URLSearchParams(location.search).has('dev')

  // 载入场景数据包
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const want = new URLSearchParams(location.search).get('aoi')
        const ids = await listScenes()
        if (ids.length === 0) throw new Error('服务端没有任何场景数据包，先跑 scene/ 下的建库脚本')
        const id = want && ids.includes(want) ? want : ids[0]
        const s = await loadScene(id)
        if (alive) setScene(s)
      } catch (e) {
        if (alive) setError(String(e))
      }
    })()
    return () => { alive = false }
  }, [])

  // 建图
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
    }
    map.on('style.load', mount)
    map.on('idle', mount)
    return () => {
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

  return (
    <div className="scene">
      <div ref={box} className="scene-map" />
      <div className="scene-panel">
        {error && <div className="scene-error">{error}</div>}
        {scene && (
          <>
            <h1>{scene.name}</h1>
            <div className="scene-sub">
              {scene.extentKm[0]} × {scene.extentKm[1]} km · 中心 {scene.center[0]}, {scene.center[1]}
            </div>
            <label><input type="checkbox" checked={hill} onChange={(e) => setHill(e.target.checked)} /> 山体阴影</label>
            {dev && (
              <label><input type="checkbox" checked={bySrc} onChange={(e) => setBySrc(e.target.checked)} /> 按高度来源分色（DEV）</label>
            )}
            <table className="scene-stats">
              <tbody>
                <tr><td>建筑</td><td>{scene.buildings.features.toLocaleString()} 栋</td></tr>
                <tr><td>高度中位</td><td>{scene.buildings.heightQ50 ?? '—'} m</td></tr>
                <tr><td>最高</td><td>{scene.buildings.heightMax ?? '—'} m</td></tr>
              </tbody>
            </table>
            {dev && (
              <div className="scene-src" data-dev="height-sources">
                {Object.entries(scene.buildings.srcPct).map(([k, v]) => (
                  <span key={k}>{k} {v}%</span>
                ))}
              </div>
            )}
            {scene.osmSnapshot && <div className="scene-attrib">底图数据 {scene.osmSnapshot.slice(0, 10)}</div>}
            <div className="scene-attrib" dangerouslySetInnerHTML={{ __html: scene.attribution ?? '' }} />
          </>
        )}
      </div>
    </div>
  )
}
