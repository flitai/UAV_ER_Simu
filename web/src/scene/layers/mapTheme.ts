// 地图的主题切换（D-078）：底图、建筑、观测区域边界、山体阴影、视距探测与全部态势图层，一处换齐。
//
// **不走 `map.setStyle()`**：那会把运行时加进来的图层与数据源（态势、建筑、遮挡探测）一起清掉，
// 还要重拉瓦片。这里按层 setPaintProperty：底图的新颜色从同一个 `protomapsStyle()` 按深色色表求值
// 取出——图层结构两种主题逐项相同（protomaps.test.ts 钉着），所以只需要拷 paint。

import type { Map as MLMap } from 'maplibre-gl'
import type { Theme } from '../../shell/theme.js'
import { BASEMAP_DARK, BASEMAP_LIGHT, protomapsStyle } from '../style/protomaps.js'
import { SIT, setSituationTheme } from '../style/situation.js'
import { applySituationTheme } from './situation.js'
import { setBuildingsBaseColor } from './buildings3d.js'
import { AOI_BOUNDARY_LAYER_ID } from './aoiBoundary.js'
import { HILLSHADE_LAYER_ID, hillshadePaint } from './hillshade.js'
import { LOS_PROBE_LAYER_IDS } from './losProbe.js'
import { applyCoverageTheme } from './coverage.js'

export function basemapPalette(theme: Theme) {
  return theme === 'dark' ? BASEMAP_DARK : BASEMAP_LIGHT
}

/** 换主题。可在地图任何状态下调；没建出来的图层跳过，之后建的会按当前主题取色。 */
export async function applyMapTheme(map: MLMap, theme: Theme): Promise<void> {
  setSituationTheme(theme)
  const pal = basemapPalette(theme)
  const style = protomapsStyle({ url: '', palette: pal })
  try {
    for (const l of style.layers) {
      if (!map.getLayer(l.id)) continue
      for (const [k, v] of Object.entries((l as { paint?: Record<string, unknown> }).paint ?? {})) {
        map.setPaintProperty(l.id, k, v as never)
      }
    }
    setBuildingsBaseColor(map, pal.bldg)
    if (map.getLayer(AOI_BOUNDARY_LAYER_ID)) map.setPaintProperty(AOI_BOUNDARY_LAYER_ID, 'line-color', pal.waterInk)
    if (map.getLayer(HILLSHADE_LAYER_ID)) {
      for (const [k, v] of Object.entries(hillshadePaint(theme))) map.setPaintProperty(HILLSHADE_LAYER_ID, k, v as never)
    }
    for (const id of LOS_PROBE_LAYER_IDS) {
      if (!map.getLayer(id)) continue
      map.setPaintProperty(id, id.endsWith('line') ? 'line-color' : 'circle-color', ['case', ['get', 'los'], SIT.linkLos, SIT.linkNlos])
      if (id.endsWith('dot')) map.setPaintProperty(id, 'circle-stroke-color', SIT.halo)
    }
  } catch { /* 地图正在拆除 */ }
  applyCoverageTheme(map)
  await applySituationTheme(map)
}
