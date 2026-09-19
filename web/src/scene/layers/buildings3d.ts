// 观测区域内建筑的三维拉伸。
//
// **数据源是场景数据包的 `buildings.geojson`，不是瓦片**（铁律 11：渲染与遮挡计算同源，
// 单一来源同时驱动这两件事）。瓦片的 `buildings` 层只作观测区域之外的渲染回退，
// 永远不进遮挡计算（决策 D-002）。
//
// 外观参数与 Airports `addBldg3d()`（index.html 第 1296 行）保持一致：色值 PM.bldg、
// 最小显示层级 14、在 14 至 14.7 之间从平面"长起来"。字段名不同：本项目的产物用
// `height_m` / `base_m`（单位米，离地高差），Airports 用瓦片的 `height` / `min_height`。

import type { Map as MLMap, ExpressionSpecification, FillExtrusionLayerSpecification } from 'maplibre-gl'
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

/**
 * **渲染侧缺高度时的兜底值必须是 0，不能是别的数**（D4，D-076）。
 *
 * 物理侧对 `height_m` 缺失或 ≤ 0 的要素是**剔除并计数**（`occlusion/geojson.ts` 的
 * `droppedHeight`，C++ `buildings_json.cpp` 同律）。渲染侧要是拿一个正数顶替，
 * 同一份文件在两边就成了两个意思：屏幕上立着一栋楼，视线却从它当中穿过去，
 * 而且**画面上看不出来**——这正是铁律 11「渲染—物理同源」要防的，
 * 也正是铁律 15 点名的那个写法（`height ?? 8`）。取 0 则两边同义：物理侧没有它、屏幕上也看不见。
 *
 * 当前的 `buildings.geojson` 47582 个要素**没有一个缺高度**（D-027b 的估算兜底保证了这点），
 * 所以这个改动不改变今天画面上的任何一个像素。留着它是因为「碰巧没有反例」不是保证。
 */
export const HEIGHT_FALLBACK_M = 0
export const BASE_FALLBACK_M = 0

export function buildings3dPaint(colorBySrc = false): FillExtrusionLayerSpecification['paint'] {
  return {
    'fill-extrusion-color': colorBySrc ? COLOR_BY_SRC : PM.bldg,
    // 14→14.7 的插值让建筑从平面"长起来"，避免跨过 minzoom 时整片弹出
    'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'],
      14, 0, 14.7, ['coalesce', ['get', 'height_m'], HEIGHT_FALLBACK_M]],
    'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'],
      14, 0, 14.7, ['coalesce', ['get', 'base_m'], BASE_FALLBACK_M]],
    'fill-extrusion-opacity': 0.95,
  }
}

/**
 * 交给 MapLibre 的那个地址（D4，D-076）。
 *
 * **不能从 `map.getStyle()` 里读**：GeoJSON 源加载完之后，序列化出来的 `data` 会从地址
 * 变成解析后的那个对象（2026-09-19 实测——同一个页面，源加载前读到字符串、加载后读到对象，
 * 于是「两侧地址相同」这条断言先是通过、后又失败）。所以在交出去的那一刻记下来。
 */
let sourceUrl: string | null = null
export function buildingsSourceUrl(): string | null { return sourceUrl }

export function addBuildings3d(map: MLMap, opts: Buildings3dOptions): void {
  if (map.getLayer(BUILDINGS_LAYER_ID)) return
  sourceUrl = opts.data
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
    paint: buildings3dPaint(opts.colorBySrc),
  }, before)
}

export function setBuildingsColorBySrc(map: MLMap, on: boolean): void {
  if (!map.getLayer(BUILDINGS_LAYER_ID)) return
  map.setPaintProperty(BUILDINGS_LAYER_ID, 'fill-extrusion-color', on ? COLOR_BY_SRC : PM.bldg)
}
