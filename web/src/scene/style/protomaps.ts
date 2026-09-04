// Protomaps 浅色底图样式，自 Airports `index.html` 第 810 至 1092 行逐层照搬（决策 D-017）。
//
// **只把原生 JavaScript 切成 TypeScript 模块，不改任何视觉参数**：图层顺序、色值、线宽档位、
// 缩放门槛、过滤条件、标注字号与光晕全部保持原样。任何视觉偏离都要先记一条决策。
//
// 原文里的注释一并保留——那些注释记录的是踩过的坑（比如水层必须按几何类型过滤，
// 否则河道线会被当成环填成大片假水面），删掉等于把教训丢了。

import type { StyleSpecification, LayerSpecification } from 'maplibre-gl'
import { PM, PM_NAME, PM_FONT } from './colors.js'
import { GLYPH_URL } from './constants.js'

type AnyLayer = LayerSpecification
// 手写样式里的表达式是数组字面量，与 MapLibre 的联合类型对不上号，逐个标注收益极低。
// 在这个模块边界上收口成 LayerSpecification，模块外仍是强类型。
const layer = (o: unknown): AnyLayer => o as AnyLayer

export interface ProtomapsStyleOptions {
  /** PMTiles 归档的 URL，会被拼成 `pmtiles://<url>` */
  url: string
  /** 归档的最高缩放级，默认 15 */
  maxzoom?: number
}

export function protomapsStyle({ url, maxzoom = 15 }: ProtomapsStyleOptions): StyleSpecification {
  const src = {
    pm: {
      type: 'vector' as const,
      url: 'pmtiles://' + url,
      attribution:
        '<a href="https://protomaps.com">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  }
  const L: AnyLayer[] = []
  const add = (o: unknown) => L.push(layer(o))
  const kindIn = (list: string[]) => ['in', ['get', 'kind'], ['literal', list]]
  const detailIn = (list: string[]) => ['in', ['get', 'kind_detail'], ['literal', list]]

  // 面层：kind 命中即可
  function fill(id: string, kinds: string[], color: string,
                opts?: { sl?: string; minzoom?: number; opacity?: number }) {
    const paint: Record<string, unknown> = { 'fill-color': color }
    if (opts && opts.opacity != null) paint['fill-opacity'] = opts.opacity
    const o: Record<string, unknown> = {
      id, type: 'fill', source: 'pm', 'source-layer': (opts && opts.sl) || 'landuse',
      filter: kindIn(kinds), paint,
    }
    if (opts && opts.minzoom) o.minzoom = opts.minzoom
    add(o)
  }

  // 线宽插值：把 [z,w, z,w, ...] 展开成 interpolate 表达式
  const w = (...args: number[]): unknown[] => ['interpolate', ['exponential', 1.5], ['zoom'], ...args]

  // ===== 底 =====
  add({ id: 'bg', type: 'background', paint: { 'background-color': PM.paper } })
  add({ id: 'earth', type: 'fill', source: 'pm', 'source-layer': 'earth',
        filter: ['==', ['get', 'kind'], 'earth'], paint: { 'fill-color': PM.earth } })
  add({ id: 'landcover', type: 'fill', source: 'pm', 'source-layer': 'landcover', maxzoom: 8,
        paint: { 'fill-color': ['match', ['get', 'kind'],
                   'forest', PM.wood, 'grassland', PM.green, 'farmland', PM.green,
                   'glacier', PM.ice, 'barren', PM.sand, PM.green],
                 'fill-opacity': 0.55 } })

  // ===== 土地利用 =====
  fill('lu-wood', ['forest', 'wood', 'scrub'], PM.wood, { minzoom: 6 })
  fill('lu-grass', ['grass', 'meadow', 'grassland', 'farmland', 'allotments',
                    'village_green', 'orchard', 'vineyard', 'farmyard'], PM.green, { minzoom: 6 })
  fill('lu-park', ['park', 'garden', 'nature_reserve', 'recreation_ground',
                   'dog_park', 'national_park', 'protected_area'], PM.park, { minzoom: 5 })
  fill('lu-sand', ['sand', 'beach', 'bare_rock', 'barren', 'quarry'], PM.sand, { minzoom: 9 })
  fill('lu-glacier', ['glacier'], PM.ice, { minzoom: 5 })
  fill('lu-wetland', ['wetland'], PM.wet, { minzoom: 8 })
  fill('lu-built', ['residential', 'commercial', 'industrial', 'retail', 'railway',
                    'military', 'pedestrian', 'platform', 'other'], PM.built,
       { minzoom: 10, opacity: 0.7 })
  fill('lu-inst', ['school', 'college', 'university', 'hospital', 'kindergarten'], PM.inst, { minzoom: 11 })
  fill('lu-sport', ['pitch', 'playground', 'golf_course', 'zoo', 'theme_park', 'stadium'], PM.sport, { minzoom: 12 })
  fill('lu-grave', ['cemetery'], PM.grave, { minzoom: 11 })
  // 机场用地：整片场区比普通工业用地更该被看见，单列一层并给描边
  fill('lu-aerodrome', ['aerodrome', 'airfield'], PM.aero, { minzoom: 9 })
  add({ id: 'lu-aerodrome-case', type: 'line', source: 'pm', 'source-layer': 'landuse', minzoom: 10,
        filter: kindIn(['aerodrome', 'airfield']),
        paint: { 'line-color': PM.aeroCase, 'line-width': w(10, 0.5, 14, 1.2) } })

  // ===== 水 =====
  // 必须按几何类型过滤：Protomaps 的 water 层把水域面和河道线混在一起（上海一带
  // 631 个要素里 596 个是 river/canal 的线）。fill 层拿到 LineString 会把折线首尾
  // 相连当成环去填充，于是沿着河谷糊出大片假水面。geometry-type 对 MultiPolygon
  // 也返回 "Polygon"，实测过，不会漏掉多部件水域。
  add({ id: 'water', type: 'fill', source: 'pm', 'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': PM.water } })
  add({ id: 'waterway', type: 'line', source: 'pm', 'source-layer': 'water', minzoom: 9,
        filter: ['all', ['==', ['geometry-type'], 'LineString'],
                 kindIn(['river', 'canal', 'stream', 'ditch'])],
        paint: { 'line-color': PM.water, 'line-width': w(9, 0.5, 12, 1.2, 15, 3, 18, 7) } })

  // ===== 机场道面（在道路之下，让公路压在跑道上而不是相反）=====
  fill('aero-runway-area', ['runway'], PM.apron, { minzoom: 11, sl: 'landuse' })
  add({ id: 'pier', type: 'line', source: 'pm', 'source-layer': 'roads', minzoom: 13,
        filter: detailIn(['pier']),
        paint: { 'line-color': PM.earth, 'line-width': w(13, 1, 18, 6) } })

  // ===== 道路 =====
  // 分级表：[后缀, kind_detail 列表, 填充色, 描边色, 起始缩放, 宽度档位]
  // 所有 casing 先画完再画所有 fill，否则高等级道路的描边会切断低等级道路的路面。
  const ROADS: Array<[string, string[], string, string, number, number[]]> = [
    ['service', ['service', 'alley', 'driveway', 'parking_aisle', 'emergency_access'],
      PM.road, PM.roadCase, 14, [14, 0.8, 16, 2.4, 18, 6]],
    ['minor', ['residential', 'unclassified', 'living_street', 'raceway'],
      PM.road, PM.roadCase, 12, [12, 0.7, 15, 3, 18, 11]],
    ['tertiary', ['tertiary', 'tertiary_link'],
      PM.road, PM.roadCase, 10, [10, 0.8, 14, 3.4, 18, 14]],
    ['secondary', ['secondary', 'secondary_link'],
      PM.road, PM.roadCase, 9, [9, 0.9, 13, 3.4, 18, 18]],
    ['primary', ['primary', 'primary_link'],
      PM.major, PM.majorCase, 7, [7, 0.9, 12, 3.4, 18, 22]],
    ['trunk', ['trunk', 'trunk_link'],
      PM.major, PM.majorCase, 6, [6, 0.9, 12, 4, 18, 24]],
    ['motorway', ['motorway', 'motorway_link'],
      PM.motor, PM.motorCase, 5, [5, 1, 10, 3, 14, 9, 18, 28]],
  ]
  const notBridge = ['!=', ['get', 'is_bridge'], true]

  // 隧道：虚线描边、不画路面，压在地面道路之下
  add({ id: 'tunnel', type: 'line', source: 'pm', 'source-layer': 'roads', minzoom: 12,
        filter: ['all', ['==', ['get', 'is_tunnel'], true],
                 detailIn(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
                           'residential', 'unclassified', 'motorway_link'])],
        layout: { 'line-cap': 'butt' },
        paint: { 'line-color': PM.roadCase, 'line-dasharray': [3, 2],
                 'line-width': w(12, 1.2, 16, 5, 18, 10) } })
  // 步道
  add({ id: 'road-path', type: 'line', source: 'pm', 'source-layer': 'roads', minzoom: 14,
        filter: ['all', ['==', ['get', 'kind'], 'path'], ['!', detailIn(['pier'])]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#e9e4db', 'line-dasharray': [2, 1.5],
                 'line-width': w(14, 0.7, 18, 2.6) } })
  // casing
  for (const r of ROADS) {
    add({ id: 'road-' + r[0] + '-case', type: 'line', source: 'pm', 'source-layer': 'roads',
          minzoom: r[4], filter: ['all', notBridge, detailIn(r[1])],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': r[3],
                   'line-width': w(...r[5].map((v, k) => (k % 2 ? +(v * 1.3 + 0.7).toFixed(2) : v))) } })
  }
  // fill
  for (const r of ROADS) {
    add({ id: 'road-' + r[0], type: 'line', source: 'pm', 'source-layer': 'roads',
          minzoom: r[4], filter: ['all', notBridge, detailIn(r[1])],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': r[2], 'line-width': w(...r[5]) } })
  }
  // 桥：整体画在地面道路之上，避免被下面的路面盖住
  add({ id: 'bridge-case', type: 'line', source: 'pm', 'source-layer': 'roads', minzoom: 12,
        filter: ['==', ['get', 'is_bridge'], true],
        layout: { 'line-cap': 'butt' },
        paint: { 'line-color': PM.majorCase, 'line-width': w(12, 3.2, 16, 9, 18, 20) } })
  add({ id: 'bridge', type: 'line', source: 'pm', 'source-layer': 'roads', minzoom: 12,
        filter: ['==', ['get', 'is_bridge'], true],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': PM.road, 'line-width': w(12, 1.6, 16, 6, 18, 16) } })

  // ===== 机场跑道 / 滑行道 =====
  add({ id: 'aeroway-taxiway-case', type: 'line', source: 'pm', 'source-layer': 'roads', minzoom: 12,
        filter: detailIn(['taxiway']),
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': PM.aeroCase, 'line-width': w(12, 1.2, 15, 4, 18, 13) } })
  add({ id: 'aeroway-taxiway', type: 'line', source: 'pm', 'source-layer': 'roads', minzoom: 12,
        filter: detailIn(['taxiway']),
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f7f6fa', 'line-width': w(12, 0.6, 15, 2.6, 18, 10) } })
  add({ id: 'aeroway-runway-case', type: 'line', source: 'pm', 'source-layer': 'roads', minzoom: 10,
        filter: detailIn(['runway']),
        layout: { 'line-cap': 'butt' },
        paint: { 'line-color': PM.aeroCase, 'line-width': w(10, 2, 13, 7, 18, 34) } })
  add({ id: 'aeroway-runway', type: 'line', source: 'pm', 'source-layer': 'roads', minzoom: 10,
        filter: detailIn(['runway']),
        layout: { 'line-cap': 'butt' },
        paint: { 'line-color': '#ffffff', 'line-width': w(10, 1.2, 13, 5, 18, 28) } })

  // ===== 轨道 =====
  add({ id: 'rail-case', type: 'line', source: 'pm', 'source-layer': 'roads', minzoom: 11,
        filter: detailIn(['rail', 'light_rail', 'monorail']),
        paint: { 'line-color': PM.railCase, 'line-width': w(11, 1.2, 16, 4) } })
  add({ id: 'rail', type: 'line', source: 'pm', 'source-layer': 'roads', minzoom: 11,
        filter: detailIn(['rail', 'light_rail', 'monorail']),
        paint: { 'line-color': '#f3f0ea', 'line-width': w(11, 0.6, 16, 2),
                 'line-dasharray': [2.5, 2.5] } })
  add({ id: 'rail-subway', type: 'line', source: 'pm', 'source-layer': 'roads', minzoom: 13,
        filter: detailIn(['subway']),
        paint: { 'line-color': PM.rail, 'line-width': w(13, 0.6, 17, 2),
                 'line-dasharray': [3, 2], 'line-opacity': 0.7 } })
  add({ id: 'ferry', type: 'line', source: 'pm', 'source-layer': 'roads', minzoom: 9,
        filter: ['==', ['get', 'kind'], 'ferry'],
        paint: { 'line-color': PM.waterInk, 'line-width': w(9, 0.5, 14, 1.2),
                 'line-dasharray': [4, 3], 'line-opacity': 0.6 } })

  // ===== 建筑 =====
  // 观测区域之内的建筑由同源 GeoJSON 拉伸（铁律 11），这一层只作区域之外的渲染回退。
  add({ id: 'buildings', type: 'fill', source: 'pm', 'source-layer': 'buildings', minzoom: 14,
        filter: ['==', ['get', 'kind'], 'building'],
        paint: { 'fill-color': PM.bldg, 'fill-outline-color': PM.bldgCase } })

  // ===== 行政边界 =====
  // kind_detail 是行政级别：country=2 / region=4 / county=5,6 / locality=8
  add({ id: 'boundary-county', type: 'line', source: 'pm', 'source-layer': 'boundaries', minzoom: 8,
        filter: kindIn(['county', 'locality']),
        paint: { 'line-color': PM.bound, 'line-dasharray': [2, 3],
                 'line-width': w(8, 0.4, 13, 1), 'line-opacity': 0.7 } })
  add({ id: 'boundary-region', type: 'line', source: 'pm', 'source-layer': 'boundaries', minzoom: 4,
        filter: kindIn(['region']),
        paint: { 'line-color': PM.bound, 'line-dasharray': [4, 2],
                 'line-width': w(4, 0.5, 10, 1.4) } })
  add({ id: 'boundary-country', type: 'line', source: 'pm', 'source-layer': 'boundaries',
        filter: kindIn(['country']),
        paint: { 'line-color': '#b3aa9e', 'line-width': w(2, 0.7, 8, 2, 12, 3) } })

  // ===== 标注 =====
  // 统一的光晕参数，保证任何底色上都读得清
  const halo = (hw?: number) => ({ 'text-color': PM.ink, 'text-halo-color': PM.halo,
                                   'text-halo-width': hw || 1.5, 'text-halo-blur': 0.3 })

  // 水体：线状河流沿线排字，面状湖海居中排字
  add({ id: 'water-label-line', type: 'symbol', source: 'pm', 'source-layer': 'water', minzoom: 12,
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['has', 'name']],
        layout: { 'text-field': PM_NAME, 'text-font': PM_FONT, 'symbol-placement': 'line',
                  'text-size': 11, 'text-letter-spacing': 0.05 },
        paint: { 'text-color': PM.waterInk, 'text-halo-color': PM.halo, 'text-halo-width': 1.2 } })
  add({ id: 'water-label', type: 'symbol', source: 'pm', 'source-layer': 'water', minzoom: 8,
        filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['has', 'name']],
        layout: { 'text-field': PM_NAME, 'text-font': PM_FONT, 'text-max-width': 7,
                  'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 13] },
        paint: { 'text-color': PM.waterInk, 'text-halo-color': PM.halo, 'text-halo-width': 1.2 } })

  // 道路名
  add({ id: 'road-label', type: 'symbol', source: 'pm', 'source-layer': 'roads', minzoom: 13,
        filter: ['all', ['has', 'name'],
                 kindIn(['highway', 'major_road', 'medium_road', 'minor_road'])],
        layout: { 'text-field': PM_NAME, 'text-font': PM_FONT, 'symbol-placement': 'line',
                  'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 17, 12],
                  'symbol-spacing': 260 },
        paint: { 'text-color': PM.dim, 'text-halo-color': PM.halo, 'text-halo-width': 1.4 } })

  // POI：用 Protomaps 自带的 min_zoom 控密度，比一刀切好得多。
  add({ id: 'poi-label', type: 'symbol', source: 'pm', 'source-layer': 'pois', minzoom: 14,
        filter: ['all', ['has', 'name'], ['>=', ['zoom'], ['get', 'min_zoom']],
                 kindIn(['terminal', 'hangar', 'apron', 'helipad', 'gate', 'runway',
                         'hospital', 'school', 'university', 'college', 'museum', 'library',
                         'park', 'attraction', 'station', 'bus_station', 'marina', 'stadium',
                         'theatre', 'zoo', 'peak', 'police', 'fire_station', 'townhall',
                         'place_of_worship', 'nature_reserve', 'golf_course'])],
        layout: { 'text-field': PM_NAME, 'text-font': PM_FONT, 'text-max-width': 8,
                  'text-size': 11, 'text-anchor': 'top', 'text-offset': [0, 0.4],
                  'text-optional': true },
        paint: { 'text-color': PM.poi, 'text-halo-color': PM.halo, 'text-halo-width': 1.3 } })

  // 机场名：独立一层且给较高优先级
  add({ id: 'aerodrome-label', type: 'symbol', source: 'pm', 'source-layer': 'pois', minzoom: 11,
        filter: ['all', ['has', 'name'], ['==', ['get', 'kind'], 'aerodrome']],
        layout: { 'text-field': PM_NAME, 'text-font': PM_FONT, 'text-max-width': 9,
                  'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 15, 13],
                  'symbol-sort-key': 0 },
        paint: { 'text-color': '#6a6478', 'text-halo-color': PM.halo, 'text-halo-width': 1.6 } })

  // 地名：按 kind_detail 分层，越重要的层放得越靠后（越晚画越不容易被挤掉）
  add({ id: 'place-neighbourhood', type: 'symbol', source: 'pm', 'source-layer': 'places', minzoom: 13,
        filter: kindIn(['neighbourhood', 'macrohood']),
        layout: { 'text-field': PM_NAME, 'text-font': PM_FONT, 'text-max-width': 7,
                  'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 12],
                  'text-letter-spacing': 0.04, 'text-transform': 'uppercase' },
        paint: { 'text-color': PM.dim, 'text-halo-color': PM.halo, 'text-halo-width': 1.4 } })
  // 乡村小地名从 z9 就放出来；密度交给 MapLibre 的碰撞检测，min_zoom 只当排序键
  add({ id: 'place-village', type: 'symbol', source: 'pm', 'source-layer': 'places', minzoom: 9,
        filter: detailIn(['village', 'hamlet', 'isolated_dwelling', 'farm', 'locality']),
        layout: { 'text-field': PM_NAME, 'text-font': PM_FONT, 'text-max-width': 7,
                  'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9.5, 15, 12],
                  'symbol-sort-key': ['coalesce', ['get', 'min_zoom'], 15] },
        paint: halo(1.4) })
  add({ id: 'place-town', type: 'symbol', source: 'pm', 'source-layer': 'places', minzoom: 8,
        filter: detailIn(['town', 'suburb']),
        layout: { 'text-field': PM_NAME, 'text-font': PM_FONT, 'text-max-width': 7,
                  'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 14] },
        paint: halo(1.5) })
  add({ id: 'place-city', type: 'symbol', source: 'pm', 'source-layer': 'places', minzoom: 4,
        filter: detailIn(['city']),
        layout: { 'text-field': PM_NAME, 'text-font': PM_FONT, 'text-max-width': 8,
                  'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 8, 14, 13, 18] },
        paint: halo(1.8) })
  add({ id: 'place-region', type: 'symbol', source: 'pm', 'source-layer': 'places',
        minzoom: 4, maxzoom: 9, filter: kindIn(['region']),
        layout: { 'text-field': PM_NAME, 'text-font': PM_FONT, 'text-max-width': 8,
                  'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 13],
                  'text-letter-spacing': 0.08, 'text-transform': 'uppercase' },
        paint: { 'text-color': PM.dim, 'text-halo-color': PM.halo, 'text-halo-width': 1.5 } })
  add({ id: 'place-country', type: 'symbol', source: 'pm', 'source-layer': 'places', maxzoom: 8,
        filter: kindIn(['country']),
        layout: { 'text-field': PM_NAME, 'text-font': PM_FONT, 'text-max-width': 8,
                  'text-size': ['interpolate', ['linear'], ['zoom'], 2, 11, 6, 15],
                  'text-letter-spacing': 0.06 },
        paint: halo(1.8) })

  return { version: 8, glyphs: GLYPH_URL, sources: src, layers: L,
           _maxzoom: maxzoom } as unknown as StyleSpecification
}
