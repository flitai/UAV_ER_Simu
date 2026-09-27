// 探测范围图层（D-079）：Pd 场的着色图 + Pd = 0.9 等值线。
//
// 着色图走 MapLibre 的 image 源：一格一像素画进画布、转位图、四角贴到网格包围盒上
// （格心等分包围盒，像素中心正是格心）。40000 格的 GeoJSON 多边形（em-demo 的做法）在
// 拖动地图时每帧要重新镶嵌，位图不用。压在建筑之下：楼挡住的地方本来就该看得见楼。
// 等值线是 GeoJSON 线层，压在态势图层同一个位置（第一个标注层之前），带一圈底色晕保证在色带上看得清。
// 两个图层**不进** situation.ts 的 LAYER_IDS——那是 slice8 的 13 个图层断言表。

import type { Map as MLMap } from 'maplibre-gl'
import { SIT } from '../style/situation.js'
import { BUILDINGS_LAYER_ID } from './buildings3d.js'
import { paintField } from '../coverage/paint.js'
import type { Segment } from '../coverage/contour.js'

export const COVERAGE_LAYER_IDS = ['cuav-coverage-fill', 'cuav-coverage-contour-halo', 'cuav-coverage-contour'] as const
const IMG_SRC = 'cuav-coverage-img'
const LINE_SRC = 'cuav-coverage-line'
const EMPTY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function alive(map: MLMap): boolean {
  try { return !!map.getStyle() } catch { return false }
}

function firstSymbol(map: MLMap): string | undefined {
  for (const l of map.getStyle()?.layers ?? []) if (l.type === 'symbol') return l.id
  return undefined
}

export function coverageLinePaint(): Record<string, unknown> {
  // 1.2 px（2026-09-27 用户：「细一些」，原 2 px）
  return { 'line-color': SIT.coverageContour, 'line-width': 1.2, 'line-opacity': 0.9 }
}
export function coverageHaloPaint(): Record<string, unknown> {
  // 晕随线一起收窄、变淡：原 4.5 px / 0.7 让整条线读起来比 2 px 粗得多
  return { 'line-color': SIT.halo, 'line-width': 2.4, 'line-opacity': 0.5 }
}

/** 建齐三个图层（可重复调用）。缺省不可见，开关打开才显示。 */
export function addCoverageLayers(map: MLMap): void {
  if (!alive(map)) return
  try {
    if (!map.getSource(IMG_SRC)) {
      map.addSource(IMG_SRC, { type: 'image', url: EMPTY_PNG, coordinates: [[0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]] })
    }
    if (!map.getSource(LINE_SRC)) map.addSource(LINE_SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    if (!map.getLayer('cuav-coverage-fill')) {
      const before = map.getLayer(BUILDINGS_LAYER_ID) ? BUILDINGS_LAYER_ID : firstSymbol(map)
      map.addLayer({
        id: 'cuav-coverage-fill', type: 'raster', source: IMG_SRC, layout: { visibility: 'none' },
        // 一格一像素放大显示：取最近邻，别让 GPU 把格与格之间抹成渐变（那会画出不存在的中间值）
        paint: { 'raster-opacity': 1, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 },
      }, before)
    }
    const beforeLine = firstSymbol(map)
    if (!map.getLayer('cuav-coverage-contour-halo')) {
      map.addLayer({ id: 'cuav-coverage-contour-halo', type: 'line', source: LINE_SRC, layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' }, paint: coverageHaloPaint() as never }, beforeLine)
    }
    if (!map.getLayer('cuav-coverage-contour')) {
      map.addLayer({ id: 'cuav-coverage-contour', type: 'line', source: LINE_SRC, layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' }, paint: coverageLinePaint() as never }, beforeLine)
    }
  } catch { /* 地图正在拆除 */ }
}

export function setCoverageVisible(map: MLMap, on: boolean): void {
  if (!alive(map)) return
  for (const id of COVERAGE_LAYER_IDS) {
    try { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none') } catch { /* 拆除中 */ }
  }
}

/** 画一次：值场 → 位图贴到包围盒；等值线段 → 线要素。values 为 null 即清空。 */
export function setCoverage(map: MLMap, geom: { nx: number; ny: number; bbox: [number, number, number, number] } | null,
                            values: ArrayLike<number> | null, segments: Segment[]): void {
  if (!alive(map)) return
  try {
    const img = map.getSource(IMG_SRC) as { updateImage?: (o: { url: string; coordinates: number[][] }) => void } | undefined
    const line = map.getSource(LINE_SRC) as { setData?: (d: unknown) => void } | undefined
    if (!geom || !values) {
      img?.updateImage?.({ url: EMPTY_PNG, coordinates: [[0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]] })
      line?.setData?.({ type: 'FeatureCollection', features: [] })
      return
    }
    const c = document.createElement('canvas')
    c.width = geom.nx
    c.height = geom.ny
    const g = c.getContext('2d')
    if (!g) return
    g.putImageData(new ImageData(paintField(geom.nx, geom.ny, values) as Uint8ClampedArray<ArrayBuffer>, geom.nx, geom.ny), 0, 0)
    const [w, s, e, n] = geom.bbox
    img?.updateImage?.({ url: c.toDataURL('image/png'), coordinates: [[w, n], [e, n], [e, s], [w, s]] })
    line?.setData?.({
      type: 'FeatureCollection',
      features: segments.map((sg) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: sg } })),
    })
  } catch { /* 地图正在拆除 */ }
}

/** 换主题：等值线与晕按当前 SIT 重设（着色图是 viridis，两种主题通用）。 */
export function applyCoverageTheme(map: MLMap): void {
  if (!alive(map)) return
  try {
    if (map.getLayer('cuav-coverage-contour')) for (const [k, v] of Object.entries(coverageLinePaint())) map.setPaintProperty('cuav-coverage-contour', k, v)
    if (map.getLayer('cuav-coverage-contour-halo')) for (const [k, v] of Object.entries(coverageHaloPaint())) map.setPaintProperty('cuav-coverage-contour-halo', k, v)
  } catch { /* 拆除中 */ }
}
