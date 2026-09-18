// 视距探测的两个图层（D3-7，D-074）：站 → 被点那一点的一条线，外加点上的一个圈。
//
// **不并进 situation.ts**：那一套画的是「某一帧真实发生了什么」，由任务的链路帧驱动，
// 关掉态势开关就该整层清空；探测画的是「假设目标在这儿会怎样」，是推演，不该被那个开关连坐。
//
// 颜色与链路线同一对（视距绿 / 非视距红，`docs/display-route.md` 第 4 节标定过对比度）——
// 探测看到的与跑完任务后链路线的颜色是同一件事，用两套色只会让人以为它们是两回事。
// 线画成虚线：它是推演不是实测。

import type { Map as MLMap } from 'maplibre-gl'
import { SIT } from '../style/situation.js'

export const LOS_PROBE_SOURCE_ID = 'cuav-losprobe'
export const LOS_PROBE_LAYER_IDS = ['cuav-losprobe-line', 'cuav-losprobe-dot'] as const

export interface LosProbeShape {
  from: [number, number]
  to: [number, number]
  line_of_sight: boolean
}

const EMPTY = { type: 'FeatureCollection' as const, features: [] as unknown[] }

/** 地图正在拆除时 MapLibre 的查询会抛；图层入口一律先查它还活着（D-049 ⑩）。 */
function alive(map: MLMap): boolean {
  try { return !!map.getStyle() } catch { return false }
}

/** 建源与两层；已经在就什么都不做。可重复调用（style.load 与 idle 都会触发挂载）。 */
export function addLosProbeLayers(map: MLMap, before?: string): void {
  if (!alive(map)) return
  try {
    if (!map.getSource(LOS_PROBE_SOURCE_ID)) {
      map.addSource(LOS_PROBE_SOURCE_ID, { type: 'geojson', data: EMPTY as never })
    }
    if (!map.getLayer('cuav-losprobe-line')) {
      map.addLayer({
        id: 'cuav-losprobe-line', type: 'line', source: LOS_PROBE_SOURCE_ID,
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': ['case', ['get', 'los'], SIT.linkLos, SIT.linkNlos],
          'line-width': 2.5, 'line-opacity': 0.95, 'line-dasharray': [2, 1.5],
        },
      }, before)
    }
    if (!map.getLayer('cuav-losprobe-dot')) {
      map.addLayer({
        id: 'cuav-losprobe-dot', type: 'circle', source: LOS_PROBE_SOURCE_ID,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 6,
          'circle-color': ['case', ['get', 'los'], SIT.linkLos, SIT.linkNlos],
          'circle-stroke-color': SIT.halo, 'circle-stroke-width': 2,
        },
      }, before)
    }
  } catch { /* 地图正在拆除 */ }
}

/** 摆一条探测线；`null` 即清空。 */
export function setLosProbe(map: MLMap, shape: LosProbeShape | null): void {
  if (!alive(map)) return
  try {
    const src = map.getSource(LOS_PROBE_SOURCE_ID) as { setData?: (d: unknown) => void } | undefined
    if (!src || typeof src.setData !== 'function') return
    const features: unknown[] = []
    if (shape) {
      const properties = { los: shape.line_of_sight }
      features.push({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: [shape.from, shape.to] } })
      features.push({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: shape.to } })
    }
    src.setData({ type: 'FeatureCollection', features })
  } catch { /* 地图正在拆除 */ }
}
