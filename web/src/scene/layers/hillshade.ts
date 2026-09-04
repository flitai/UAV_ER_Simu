// 山体阴影。参数照搬 Airports index.html 第 1218 行（决策 D-017）。
//
// 高程瓦片只作视觉效果，**不进视距计算**（铁律 2：建筑高度是离地高差，数字高程模型是海拔，
// 禁止隐式相加）。数据只到 zoom 8，更高缩放由 MapLibre 自己放大。

import type { Map as MLMap } from 'maplibre-gl'

export const DEM_SOURCE_ID = 'dem'
export const HILLSHADE_LAYER_ID = 'hillshade'

export interface HillshadeOptions {
  /** 高程瓦片模板，例如 `/data/basemap/dem/{z}/{x}/{y}.png` */
  tiles: string
  maxzoom?: number
}

export function addHillshade(map: MLMap, opts: HillshadeOptions): void {
  if (map.getLayer(HILLSHADE_LAYER_ID)) return
  if (!map.getSource(DEM_SOURCE_ID)) {
    map.addSource(DEM_SOURCE_ID, {
      type: 'raster-dem', tiles: [opts.tiles], tileSize: 256,
      encoding: 'terrarium', maxzoom: opts.maxzoom ?? 8,
    })
  }
  // 插在第一个线图层（道路）之前：地形阴影应垫在道路和标注之下，否则会把路网糊掉。
  // 用带 alpha 的柔和色，避免山地过曝成一片白。
  let before: string | undefined
  for (const l of map.getStyle().layers ?? []) {
    if (l.type === 'line' || l.type === 'symbol') { before = l.id; break }
  }
  map.addLayer({
    id: HILLSHADE_LAYER_ID, type: 'hillshade', source: DEM_SOURCE_ID,
    paint: {
      'hillshade-exaggeration': 0.28,
      'hillshade-shadow-color': 'rgba(88,96,112,0.34)',
      'hillshade-highlight-color': 'rgba(255,255,255,0.22)',
      'hillshade-accent-color': 'rgba(0,0,0,0)',
    },
  }, before)
}

export function removeHillshade(map: MLMap): void {
  if (map.getLayer(HILLSHADE_LAYER_ID)) map.removeLayer(HILLSHADE_LAYER_ID)
  if (map.getSource(DEM_SOURCE_ID)) map.removeSource(DEM_SOURCE_ID)
}
