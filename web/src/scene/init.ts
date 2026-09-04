// 地图实例的创建。相机与控件参数照搬 Airports `newMap()`（index.html 第 1375 行，决策 D-017）。
//
// 一处有意偏离：初始视角。Airports 是全球视角 `center [12,26] zoom 1.5`，本项目直接落在观测
// 区域上（中心与缩放由数据包清单给出），因为本系统的地图是仿真场景而不是全球浏览工具。
// 俯仰角 55 度按 CLAUDE.md「地理场景 / 态势显示子线」一节取。

import maplibregl, { type Map as MLMap, type StyleSpecification } from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { registerGlyphs } from './style/glyphs.js'

let protocolsReady = false

/**
 * 注册 pmtiles 与离线字形两个自定义协议。必须在建图之前调用一次。
 * pmtiles 协议走 HTTP Range 按需取瓦片，**不是整文件下载**——底图是 137 GB 的整份全球文件
 * （决策 D-022），整文件取等于不可用（铁律 7）。
 */
export function registerProtocols(): void {
  if (protocolsReady) return
  maplibregl.addProtocol('pmtiles', new Protocol().tile)
  registerGlyphs()
  protocolsReady = true
}

export interface NewMapOptions {
  container: HTMLElement
  style: StyleSpecification
  center: [number, number]
  zoom: number
  pitch?: number
  bearing?: number
}

export function newMap(o: NewMapOptions): MLMap {
  const m = new maplibregl.Map({
    container: o.container, style: o.style,
    center: o.center, zoom: o.zoom, pitch: o.pitch ?? 55, bearing: o.bearing ?? 0,
    minZoom: 1, maxZoom: 18, attributionControl: false, renderWorldCopies: true,
    // 本地只内嵌了拉丁字形；中日韩文字交给系统字体在客户端渲染
    localIdeographFontFamily: "'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif",
  })
  // 指南针必须留着：三维建筑会把视角仰起来，而右键拖拽即可转向，
  // 没有它用户没有任何复位手段。visualizePitch 让图标跟着俯仰倾斜。
  m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
  m.addControl(new maplibregl.ScaleControl({ maxWidth: 90 }), 'bottom-left')
  return m
}
