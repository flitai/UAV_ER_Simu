// 观测区域边界线（09 §5.2 切片 ①）：框外没有建筑数据、视距判定不可信，边界要常显。
// 这是在 Airports 样式之上**新增**的一层，不改任何既有图层的外观（D-017）。

import type { Map as MLMap } from 'maplibre-gl'
import { PM } from '../style/colors.js'

export const AOI_BOUNDARY_SOURCE_ID = 'aoi-boundary'
export const AOI_BOUNDARY_LAYER_ID = 'aoi-boundary'

export function addAoiBoundary(map: MLMap, bbox: [number, number, number, number]): void {
  if (map.getLayer(AOI_BOUNDARY_LAYER_ID)) return
  const [w, s, e, n] = bbox
  if (!map.getSource(AOI_BOUNDARY_SOURCE_ID)) {
    map.addSource(AOI_BOUNDARY_SOURCE_ID, {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] } },
    })
  }
  let before: string | undefined
  for (const l of map.getStyle().layers ?? []) {
    if (l.type === 'symbol') { before = l.id; break }
  }
  map.addLayer({
    id: AOI_BOUNDARY_LAYER_ID, type: 'line', source: AOI_BOUNDARY_SOURCE_ID,
    paint: { 'line-color': PM.waterInk, 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.9 },
  }, before)
}

export function bboxContains(bbox: [number, number, number, number], lng: number, lat: number): boolean {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]
}
