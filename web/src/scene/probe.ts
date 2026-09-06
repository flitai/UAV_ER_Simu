// 调试与端到端测试用的只读探针。
//
// **无副作用**：只读地图与应用状态，不改相机、不增删图层、不触发请求。里程碑 D4 的验收条件之一
// 就是"探针无副作用"，所以这里不提供任何写操作。
//
// 模块级注册表：地图实例与应用状态各自注册，window.__probe() 把两者合成一份。原有 12 个顶层字段
// 一个不少（tests/e2e/scene-smoke.mjs 依赖它们），新增 app 子对象（09 §10）。mapInstanceId 每建一次
// 地图加一，三视图切换不得让它变化（09 §4.2）。

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
  app?: unknown
}

declare global {
  interface Window {
    __probe?: () => ProbeState
    __map?: MLMap
  }
}

const reg: { map: MLMap | null; errors: string[]; onError: ((e: unknown) => void) | null; appFn: (() => unknown) | null; mapInstanceId: number } = {
  map: null, errors: [], onError: null, appFn: null, mapInstanceId: 0,
}

function ensureWindowProbe(): void {
  if (window.__probe) return
  window.__probe = () => {
    const map = reg.map
    let state: ProbeState | null = null
    if (map) {
      // 地图正在拆除或样式尚未装上时 MapLibre 的查询会抛；探针不能抛，退回「未就绪」
      try { state = mapState(map) } catch (e) { if (reg.errors.length < 20) reg.errors.push(`probe: ${String(e)}`) }
    }
    const base: ProbeState = state ?? {
      ready: false, loaded: false, tilesLoaded: false, center: [0, 0], zoom: 0, pitch: 0, bearing: 0,
      layers: [], sources: [], canvas: [0, 0], webgl2: !!document.createElement('canvas').getContext('webgl2'),
      renderedFeatures: 0, errors: reg.errors.slice(),
    }
    if (reg.appFn) base.app = reg.appFn()
    return base
  }
}

function mapState(map: MLMap): ProbeState {
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
    errors: reg.errors.slice(),
  }
}

export function installProbe(map: MLMap): () => void {
  reg.errors = []
  const onError = (e: unknown) => {
    const msg = (e as { error?: { message?: string } })?.error?.message ?? String(e)
    if (reg.errors.length < 20) reg.errors.push(msg)
  }
  map.on('error', onError)
  reg.map = map
  reg.onError = onError
  reg.mapInstanceId += 1
  window.__map = map
  ensureWindowProbe()
  return () => {
    map.off('error', onError)
    if (reg.map === map) { reg.map = null; reg.onError = null; delete window.__map }
  }
}

/** 应用壳注册 app 子对象的取值函数（09 §10）。 */
export function installAppProbe(fn: () => unknown): () => void {
  reg.appFn = fn
  ensureWindowProbe()
  return () => { if (reg.appFn === fn) reg.appFn = null }
}

export function probeMapInstanceId(): number { return reg.mapInstanceId }
