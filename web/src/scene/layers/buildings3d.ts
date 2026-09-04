// 观测区域内建筑的三维拉伸。
//
// **数据源是场景数据包的 `buildings.geojson`，不是瓦片**（铁律 11：渲染与遮挡计算同源，
// 单一来源同时驱动这两件事）。瓦片的 `buildings` 层只作观测区域之外的渲染回退，
// 永远不进遮挡计算（决策 D-002）。
//
// 外观参数与 Airports `addBldg3d()`（index.html 第 1296 行）保持一致：色值 PM.bldg、
// 最小显示层级 14、在 14 至 14.7 之间从平面"长起来"。字段名不同：本项目的产物用
// `height_m` / `base_m`（单位米，离地高差），Airports 用瓦片的 `height` / `min_height`。

import type { Map as MLMap, ExpressionSpecification } from 'maplibre-gl'
import { PM } from '../style/colors.js'

export const BUILDINGS_SOURCE_ID = 'aoi-buildings'
export const BUILDINGS_LAYER_ID = 'aoi-buildings-3d'

export interface Buildings3dOptions {
  /** `buildings.geojson` 的地址 */
  data: string
  /**
   * 按高度来源分色。默认 false，即与 Airports 外观一致的单色。
   * 打开后估算高度（`src=est:area`）显示为浅色，实测标注为深色——铁律 14 要求估算值可识别，
   * 演示与交付图若使用估算高度必须显式标注，这个开关是标注手段之一。
   */
  colorBySrc?: boolean
}

const COLOR_BY_SRC: ExpressionSpecification = [
  'match', ['get', 'src'],
  'osm:height', '#8c6d5a',
  'osm:levels', '#b09a86',
  'tile:height', '#c0392b',
  PM.bldg,                       // est:area 及其它，用与瓦片建筑相同的浅色
]

export function addBuildings3d(map: MLMap, opts: Buildings3dOptions): void {
  if (map.getLayer(BUILDINGS_LAYER_ID)) return
  if (!map.getSource(BUILDINGS_SOURCE_ID)) {
    map.addSource(BUILDINGS_SOURCE_ID, { type: 'geojson', data: opts.data })
  }
  // 插在第一个标注层之前：建筑要压住道路，但不能盖掉地名。
  let before: string | undefined
  for (const l of map.getStyle().layers ?? []) {
    if (l.type === 'symbol') { before = l.id; break }
  }
  map.addLayer({
    id: BUILDINGS_LAYER_ID, type: 'fill-extrusion', source: BUILDINGS_SOURCE_ID, minzoom: 14,
    paint: {
      'fill-extrusion-color': opts.colorBySrc ? COLOR_BY_SRC : PM.bldg,
      // 14→14.7 的插值让建筑从平面"长起来"，避免跨过 minzoom 时整片弹出
      'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'],
        14, 0, 14.7, ['coalesce', ['get', 'height_m'], 8]],
      'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'],
        14, 0, 14.7, ['coalesce', ['get', 'base_m'], 0]],
      'fill-extrusion-opacity': 0.95,
    },
  }, before)
}

export function setBuildingsColorBySrc(map: MLMap, on: boolean): void {
  if (!map.getLayer(BUILDINGS_LAYER_ID)) return
  map.setPaintProperty(BUILDINGS_LAYER_ID, 'fill-extrusion-color', on ? COLOR_BY_SRC : PM.bldg)
}
