// 态势图层（06 备忘录 §9C G-4 的 sites / plannedRoute 与 G-5 的 targets / trails / links）。
//
// 图层注册范式照 layers/buildings3d.ts：全部插在第一个 symbol 层之前，压在底图标注之下。
// 数据一律走 GeoJSON 源的 setData：MapLibre 的 setData 是增量的，20 Hz 更新不会重建图层。
// 图标用 map.addImage 运行时注册，不引精灵图集（docs/display-route.md 第 3 节）。
//
// 本模块只管画。数据从哪来（运行中的 WS 事件、结束后的 track 端点、编辑器的草稿）由调用方决定。

import type { Map as MLMap } from 'maplibre-gl'
import { SIT, ICON_SVG, ICON_COLOR, makeIcon, type IconName } from '../style/situation.js'

export const SRC = {
  sites: 'cuav-sites',
  route: 'cuav-planned-route',
  waypoints: 'cuav-waypoints',
  targets: 'cuav-targets',
  trails: 'cuav-trails',
  links: 'cuav-links',
} as const

const EMPTY = { type: 'FeatureCollection' as const, features: [] as unknown[] }

export interface SitePoint {
  id: string
  name: string
  lon: number
  lat: number
}

export interface RoutePoint {
  lon: number
  lat: number
  alt_m: number
}

export interface TargetPoint {
  id: string
  lon: number
  lat: number
  alt_m: number
  heading_deg: number
  speed_mps: number
  tx_on: boolean
}

export interface LinkLine {
  link_id: string
  from: [number, number]
  to: [number, number]
  line_of_sight: boolean
  distance_m: number
}

function firstSymbolLayer(map: MLMap): string | undefined {
  const layers = map.getStyle()?.layers ?? []
  for (const l of layers) if (l.type === 'symbol') return l.id
  return undefined
}

/**
 * 地图是否还活着。视图切换、换场景与页面卸载都会让地图被 remove()，而 20 赫兹的定频 tick、
 * 异步的图标注册与 React 效应都可能在那之后还跑一次——那时 map.style 已经是 null，
 * 任何 getSource 都会抛，而抛在 React 效应里会让整棵界面树被卸载（React 19 的行为）。
 * 这不是可以「小心一点就避免」的：拆除是异步事件驱动的，只能在每个入口处挡一道。
 */
function alive(map: MLMap): boolean {
  try {
    return !!map.getStyle()
  } catch {
    return false
  }
}

function ensureSource(map: MLMap, id: string): void {
  if (!alive(map)) return
  try {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY as never })
  } catch { /* 地图正在拆除 */ }
}

function setData(map: MLMap, id: string, data: unknown): void {
  if (!alive(map)) return
  try {
    const src = map.getSource(id) as { setData?: (d: unknown) => void } | undefined
    if (src && typeof src.setData === 'function') src.setData(data)
  } catch { /* 地图正在拆除 */ }
}

/** 注册两个图标。失败（画布不可用）时静默跳过，图层退化成只有圆点，不抛。 */
export async function loadSituationIcons(map: MLMap): Promise<void> {
  for (const name of Object.keys(ICON_SVG) as IconName[]) {
    if (!alive(map) || map.hasImage(name)) continue
    const data = await makeIcon(ICON_SVG[name], 96, ICON_COLOR[name], SIT.halo)
    // 光栅化是异步的：等回来时地图可能已经被拆了
    if (data && alive(map) && !map.hasImage(name)) map.addImage(name, data, { pixelRatio: 3 })
  }
}

/**
 * 一次性建齐五组图层。可重复调用（已存在即跳过），因为 style.load 与 idle 都会触发挂载。
 * 顺序即压盖顺序：链路线在最下，规划航线、航迹、航点、站点、目标依次向上。
 */
export function addSituationLayers(map: MLMap): void {
  if (!alive(map)) return
  const before = firstSymbolLayer(map)
  for (const id of Object.values(SRC)) ensureSource(map, id)

  if (!map.getLayer('cuav-link-line')) {
    map.addLayer({
      id: 'cuav-link-line', type: 'line', source: SRC.links,
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': ['case', ['get', 'los'], SIT.linkLos, SIT.linkNlos],
        'line-width': 2.4, 'line-opacity': 0.9,
      },
    }, before)
  }
  if (!map.getLayer('cuav-route-line')) {
    map.addLayer({
      id: 'cuav-route-line', type: 'line', source: SRC.route,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': SIT.route, 'line-width': 2.2, 'line-opacity': 0.95, 'line-dasharray': [3, 2] },
    }, before)
  }
  if (!map.getLayer('cuav-trail-line')) {
    map.addLayer({
      id: 'cuav-trail-line', type: 'line', source: SRC.trails,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': SIT.trail, 'line-width': 2.4, 'line-opacity': 0.5 },
    }, before)
  }
  if (!map.getLayer('cuav-waypoint-dot')) {
    map.addLayer({
      id: 'cuav-waypoint-dot', type: 'circle', source: SRC.waypoints,
      paint: {
        'circle-radius': ['case', ['get', 'selected'], 7, 5],
        'circle-color': ['case', ['get', 'selected'], SIT.waypointSel, SIT.waypoint],
        'circle-stroke-color': SIT.halo, 'circle-stroke-width': 1.5,
      },
    }, before)
  }
  if (!map.getLayer('cuav-site-dot')) {
    // 圆点是图标的兜底：图标注册失败时仍然看得见站点。
    map.addLayer({
      id: 'cuav-site-dot', type: 'circle', source: SRC.sites,
      // 圆点只作图标的锚与兜底：图标注册失败时仍看得见站点，图标在时它压在图标下面
      paint: { 'circle-radius': 4, 'circle-color': SIT.site, 'circle-stroke-color': SIT.siteHalo, 'circle-stroke-width': 2 },
    }, before)
  }
  if (!map.getLayer('cuav-site-icon')) {
    map.addLayer({
      id: 'cuav-site-icon', type: 'symbol', source: SRC.sites,
      // 图源 96 px、pixelRatio 3 → 自然尺寸 32 CSS px；0.75 得 24 px，在 2K 屏上一眼能找到
      layout: { 'icon-image': 'cuav-site', 'icon-size': 0.75, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    }, before)
  }
  if (!map.getLayer('cuav-target-icon')) {
    map.addLayer({
      id: 'cuav-target-icon', type: 'symbol', source: SRC.targets,
      layout: {
        'icon-image': 'cuav-drone', 'icon-size': 0.8,
        'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
      // 不发射时画淡一点：图标还在（目标仍被跟踪），但一眼能看出没在发
      paint: { 'icon-opacity': ['case', ['get', 'tx_on'], 1.0, 0.45] },
    }, before)
  }
}

export function setSites(map: MLMap, sites: SitePoint[]): void {
  setData(map, SRC.sites, {
    type: 'FeatureCollection',
    features: sites.map((s) => ({
      type: 'Feature',
      properties: { id: s.id, name: s.name },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    })),
  })
}

/** 规划航线：一条虚线加一串航点方块。selectedIndex 为选中的航点，用于编辑器。 */
export function setPlannedRoute(map: MLMap, points: RoutePoint[], selectedIndex = -1): void {
  setData(map, SRC.route, {
    type: 'FeatureCollection',
    features:
      points.length >= 2
        ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) } }]
        : [],
  })
  setData(map, SRC.waypoints, {
    type: 'FeatureCollection',
    features: points.map((p, i) => ({
      type: 'Feature',
      properties: { index: i, alt_m: p.alt_m, selected: i === selectedIndex },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  })
}

export function setTargets(map: MLMap, targets: TargetPoint[]): void {
  setData(map, SRC.targets, {
    type: 'FeatureCollection',
    features: targets.map((t) => ({
      type: 'Feature',
      properties: { id: t.id, heading: t.heading_deg, speed: t.speed_mps, alt_m: t.alt_m, tx_on: t.tx_on },
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
    })),
  })
}

export function setTrails(map: MLMap, trails: Map<string, Array<[number, number]>>): void {
  const features: unknown[] = []
  trails.forEach((pts, id) => {
    if (pts.length >= 2) {
      features.push({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: pts } })
    }
  })
  setData(map, SRC.trails, { type: 'FeatureCollection', features })
}

export function setLinks(map: MLMap, links: LinkLine[]): void {
  setData(map, SRC.links, {
    type: 'FeatureCollection',
    features: links.map((l) => ({
      type: 'Feature',
      properties: { link_id: l.link_id, los: l.line_of_sight, distance_m: l.distance_m },
      geometry: { type: 'LineString', coordinates: [l.from, l.to] },
    })),
  })
}

/** 清空全部态势数据（关掉态势图层开关时用）。图层留着，只把数据置空。 */
export function clearSituation(map: MLMap): void {
  for (const id of Object.values(SRC)) setData(map, id, EMPTY)
}
