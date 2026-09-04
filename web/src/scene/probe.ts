// 调试与端到端测试用的只读探针。
//
// **无副作用**：只读地图状态，不改相机、不增删图层、不触发请求。里程碑 D4 的验收条件之一
// 就是"探针无副作用"，所以这里不提供任何写操作。

import type { Map as MLMap } from 'maplibre-gl'

export interface ProbeState {
  ready: boolean
  loaded: boolean
  tilesLoaded: boolean
  center: [number, number]
  zoom: number
  pitch: number
  bearing: number
  layers: string[]
  sources: string[]
  canvas: [number, number]
  webgl2: boolean
  renderedFeatures: number
  errors: string[]
}

declare global {
  interface Window {
    __probe?: () => ProbeState
    __map?: MLMap
  }
}

export function installProbe(map: MLMap): () => void {
  const errors: string[] = []
  const onError = (e: unknown) => {
    const msg = (e as { error?: { message?: string } })?.error?.message ?? String(e)
    if (errors.length < 20) errors.push(msg)
  }
  map.on('error', onError)
  window.__map = map
  window.__probe = () => {
    const c = map.getCenter()
    const st = map.getStyle()
    const cv = map.getCanvas()
    return {
      ready: true,
      loaded: map.loaded(),
      tilesLoaded: map.areTilesLoaded(),
      center: [+c.lng.toFixed(6), +c.lat.toFixed(6)],
      zoom: +map.getZoom().toFixed(3),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      layers: (st?.layers ?? []).map((l) => l.id),
      sources: Object.keys(st?.sources ?? {}),
      canvas: [cv.width, cv.height],
      webgl2: !!document.createElement('canvas').getContext('webgl2'),
      renderedFeatures: map.queryRenderedFeatures().length,
      errors: errors.slice(),
    }
  }
  return () => {
    map.off('error', onError)
    delete window.__probe
    delete window.__map
  }
}
