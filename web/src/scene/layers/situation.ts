// 态势图层（06 备忘录 §9C G-4 的 sites / plannedRoute 与 G-5 的 targets / trails / links；
// 切片 ⑧ V-2 加告警区、高度立柱、目标选中环与标签、链路距离标注，D-061，13 报告 §4）。
//
// 图层注册范式照 layers/buildings3d.ts：全部插在第一个 symbol 层之前，压在底图标注之下。
// 数据一律走 GeoJSON 源的 setData：MapLibre 的 setData 是增量的，20 Hz 更新不会重建图层。
// 图标用 map.addImage 运行时注册，不引精灵图集（docs/display-route.md 第 3 节）。
//
// 本模块只管画。数据从哪来（运行中的 WS 事件、结束后的 track 端点、编辑器的草稿）由调用方决定。

import type { Map as MLMap } from 'maplibre-gl'
import { SIT, ICON_SVG, ICON_COLOR, makeIcon, type IconName } from '../style/situation.js'
import { PM, PM_FONT } from '../style/colors.js'

export const SRC = {
  sites: 'cuav-sites',
  route: 'cuav-planned-route',
  waypoints: 'cuav-waypoints',
  targets: 'cuav-targets',
  trails: 'cuav-trails',
  links: 'cuav-links',
  zones: 'cuav-zones',
  poles: 'cuav-target-poles',
} as const

/** 全部态势图层的 id（e2e 的图层断言表按它来）。 */
export const LAYER_IDS = [
  'cuav-zone-fill', 'cuav-zone-line', 'cuav-link-line', 'cuav-link-label', 'cuav-route-line', 'cuav-trail-line',
  'cuav-waypoint-dot', 'cuav-site-dot', 'cuav-site-icon', 'cuav-target-pole', 'cuav-target-ring', 'cuav-target-icon',
  'cuav-target-label',
] as const

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
  /** 在告警区内：图标换红环变体（D-061） */
  alert?: boolean
  /** 当前选中：画选中环 */
  selected?: boolean
  /** 焦点目标（D-062）：标签带高度；非焦点只标识别号 */
  focus?: boolean
}

export interface LinkLine {
  link_id: string
  from: [number, number]
  to: [number, number]
  line_of_sight: boolean
  distance_m: number
  /** 焦点目标的链路（D-062）：3 px 带距离标注；其余 1 px 不标注 */
  focus?: boolean
}

export interface ZoneCircle {
  id: string
  name: string
  kind: 'alert' | 'warning' | string
  lon: number
  lat: number
  radius_m: number
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

/** 注册三个图标。失败（画布不可用）时静默跳过，图层退化成只有圆点，不抛。 */
export async function loadSituationIcons(map: MLMap): Promise<void> {
  for (const name of Object.keys(ICON_SVG) as IconName[]) {
    if (!alive(map) || map.hasImage(name)) continue
    const data = await makeIcon(ICON_SVG[name], 96, ICON_COLOR[name], SIT.halo)
    // 光栅化是异步的：等回来时地图可能已经被拆了
    if (data && alive(map) && !map.hasImage(name)) map.addImage(name, data, { pixelRatio: 3 })
  }
}

/** 经纬度沿真北顺时针方位推进给定距离。小范围用等距圆柱近似足够画图（与 fixOverlay 同式）。 */
function advance(lon: number, lat: number, bearing_deg: number, dist_m: number): [number, number] {
  const rad = (bearing_deg * Math.PI) / 180
  const dN = dist_m * Math.cos(rad)
  const dE = dist_m * Math.sin(rad)
  const mPerDegLat = 111132.0
  const mPerDegLon = 111320.0 * Math.cos((lat * Math.PI) / 180)
  return [lon + dE / (mPerDegLon || 1), lat + dN / mPerDegLat]
}

/** 圆的多边形近似：64 个顶点，首尾相接。 */
function circlePolygon(lon: number, lat: number, radius_m: number, n = 64): Array<[number, number]> {
  const ring: Array<[number, number]> = []
  for (let i = 0; i <= n; i++) ring.push(advance(lon, lat, (360 * i) / n, radius_m))
  return ring
}

/** 高度立柱的底座：目标位置一个 2 m × 2 m 的小方块，拉伸到离地高。 */
function poleFootprint(lon: number, lat: number, half_m = 1): Array<[number, number]> {
  const [e] = advance(lon, lat, 90, half_m)
  const [w] = advance(lon, lat, 270, half_m)
  const [, n] = advance(lon, lat, 0, half_m)
  const [, s] = advance(lon, lat, 180, half_m)
  return [[w, s], [e, s], [e, n], [w, n], [w, s]]
}

/**
 * 一次性建齐全部图层。可重复调用（已存在即跳过），因为 style.load 与 idle 都会触发挂载。
 * 顺序即压盖顺序：告警区最下，链路线、规划航线、航迹、航点、站点、立柱、选中环、目标、标签依次向上。
 */
export function addSituationLayers(map: MLMap): void {
  if (!alive(map)) return
  const before = firstSymbolLayer(map)
  for (const id of Object.values(SRC)) ensureSource(map, id)

  if (!map.getLayer('cuav-zone-fill')) {
    map.addLayer({
      id: 'cuav-zone-fill', type: 'fill', source: SRC.zones,
      paint: {
        'fill-color': ['case', ['==', ['get', 'kind'], 'warning'], SIT.zoneWarning, SIT.zoneAlert],
        'fill-opacity': 0.08,
      },
    }, before)
  }
  if (!map.getLayer('cuav-zone-line')) {
    map.addLayer({
      id: 'cuav-zone-line', type: 'line', source: SRC.zones,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', 'kind'], 'warning'], SIT.zoneWarning, SIT.zoneAlert],
        'line-width': 2, 'line-dasharray': [4, 3], 'line-opacity': 0.9,
      },
    }, before)
  }
  if (!map.getLayer('cuav-link-line')) {
    map.addLayer({
      id: 'cuav-link-line', type: 'line', source: SRC.links,
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': ['case', ['get', 'los'], SIT.linkLos, SIT.linkNlos],
        // 焦点目标的链路 3 px，其余 1 px 淡画（D-062：地图分焦点与背景）
        'line-width': ['case', ['==', ['get', 'focus'], true], 3, 1],
        'line-opacity': ['case', ['==', ['get', 'focus'], true], 0.9, 0.55],
      },
    }, before)
  }
  if (!map.getLayer('cuav-link-label')) {
    // 距离标注（09 §5.2 早已规定「线旁标距离」）。只写数字与单位：随包字形只有拉丁字符（PM_FONT）
    map.addLayer({
      id: 'cuav-link-label', type: 'symbol', source: SRC.links,
      filter: ['==', ['get', 'focus'], true],
      layout: {
        'symbol-placement': 'line-center', 'text-field': ['get', 'label'], 'text-font': PM_FONT,
        'text-size': 11, 'text-allow-overlap': false, 'text-ignore-placement': false,
      },
      paint: { 'text-color': PM.ink, 'text-halo-color': SIT.halo, 'text-halo-width': 1.5 },
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
      paint: {
        'line-color': SIT.trail,
        'line-width': ['case', ['==', ['get', 'focus'], true], 2.4, 1.2],
        'line-opacity': ['case', ['==', ['get', 'focus'], true], 0.5, 0.3],
      },
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
    map.addLayer({
      id: 'cuav-site-dot', type: 'circle', source: SRC.sites,
      // 圆点只作图标的锚与兜底：图标注册失败时仍看得见站点，图标在时它压在图标下面
      paint: { 'circle-radius': 4, 'circle-color': SIT.site, 'circle-stroke-color': SIT.siteHalo, 'circle-stroke-width': 2 },
    }, before)
  }
  if (!map.getLayer('cuav-site-icon')) {
    map.addLayer({
      id: 'cuav-site-icon', type: 'symbol', source: SRC.sites,
      // 图源 96 px、pixelRatio 3 → 自然尺寸 32 CSS px（V-2 由 24 px 加到 32 px）
      layout: { 'icon-image': 'cuav-site', 'icon-size': 1.0, 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    }, before)
  }
  if (!map.getLayer('cuav-target-pole')) {
    // 高度立柱：符号层没有高程，用一个小方块的拉伸体从地面升到离地高（AGL，铁律 2；平地假设与 LOS 同口径）。
    // 俯仰视角下就是「从地面升起的柱子」，平视时看不出高度——可接受
    map.addLayer({
      id: 'cuav-target-pole', type: 'fill-extrusion', source: SRC.poles,
      paint: {
        'fill-extrusion-color': SIT.target, 'fill-extrusion-opacity': 0.6,
        'fill-extrusion-height': ['get', 'alt_m'], 'fill-extrusion-base': 0,
      },
    }, before)
  }
  if (!map.getLayer('cuav-target-ring')) {
    map.addLayer({
      id: 'cuav-target-ring', type: 'circle', source: SRC.targets,
      filter: ['==', ['get', 'selected'], true],
      paint: { 'circle-radius': 24, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': SIT.target, 'circle-stroke-width': 2 },
    }, before)
  }
  if (!map.getLayer('cuav-target-icon')) {
    map.addLayer({
      id: 'cuav-target-icon', type: 'symbol', source: SRC.targets,
      layout: {
        // 在告警区内换红环变体；1.25 × 32 = 40 CSS px（V-2 由 25.6 px 加到 40 px）
        'icon-image': ['case', ['==', ['get', 'alert'], true], 'cuav-drone-alert', 'cuav-drone'],
        'icon-size': 1.25,
        'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
      // 不发射时画淡一点：图标还在（目标仍被跟踪），但一眼能看出没在发
      paint: { 'icon-opacity': ['case', ['get', 'tx_on'], 1.0, 0.45] },
    }, before)
  }
  if (!map.getLayer('cuav-target-label')) {
    map.addLayer({
      id: 'cuav-target-label', type: 'symbol', source: SRC.targets,
      layout: {
        'text-field': ['get', 'label'], 'text-font': PM_FONT, 'text-size': 11,
        'text-offset': [0, 1.9], 'text-anchor': 'top', 'text-allow-overlap': true, 'text-ignore-placement': true,
      },
      paint: { 'text-color': PM.ink, 'text-halo-color': SIT.halo, 'text-halo-width': 1.5 },
    }, before)
  }
}

/** 一组图层的显隐（图层弹层的开关用）。 */
export function setLayersVisible(map: MLMap, ids: readonly string[], on: boolean): void {
  if (!alive(map)) return
  for (const id of ids) {
    try {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
    } catch { /* 地图正在拆除 */ }
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
/**
 * 画选中目标的航线。`emitterId` 会写进每个航点要素——**点选与拖动从要素身上读它属于谁**，
 * 不再拿「当前选中的是谁」去猜（2026-09-19 用户反馈「画航点会和不同的目标画串」）。
 */
export function setPlannedRoute(map: MLMap, points: RoutePoint[], selectedIndex = -1, emitterId: string | null = null): void {
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
      properties: { index: i, alt_m: p.alt_m, selected: i === selectedIndex, emitter_id: emitterId ?? '' },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  })
}

/** 告警区：圆的多边形近似。 */
export function setZones(map: MLMap, zones: ZoneCircle[]): void {
  setData(map, SRC.zones, {
    type: 'FeatureCollection',
    features: zones.map((z) => ({
      type: 'Feature',
      properties: { id: z.id, name: z.name, kind: z.kind, radius_m: z.radius_m },
      geometry: { type: 'Polygon', coordinates: [circlePolygon(z.lon, z.lat, z.radius_m)] },
    })),
  })
}

export function setTargets(map: MLMap, targets: TargetPoint[]): void {
  setData(map, SRC.targets, {
    type: 'FeatureCollection',
    features: targets.map((t) => ({
      type: 'Feature',
      properties: {
        id: t.id, heading: t.heading_deg, speed: t.speed_mps, alt_m: t.alt_m, tx_on: t.tx_on,
        alert: t.alert === true, selected: t.selected === true, focus: t.focus !== false,
        label: t.focus === false ? t.id : `${t.id} · ${t.alt_m.toFixed(0)} m`,
      },
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
    })),
  })
  setData(map, SRC.poles, {
    type: 'FeatureCollection',
    features: targets.filter((t) => t.alt_m > 0).map((t) => ({
      type: 'Feature',
      properties: { id: t.id, alt_m: t.alt_m },
      geometry: { type: 'Polygon', coordinates: [poleFootprint(t.lon, t.lat)] },
    })),
  })
}

/** 航迹。`focusId` 给定时只有它的航迹按焦点画（粗），其余细而淡；null = 全部按焦点画。 */
export function setTrails(map: MLMap, trails: Map<string, Array<[number, number]>>, focusId: string | null = null): void {
  const features: unknown[] = []
  trails.forEach((pts, id) => {
    if (pts.length >= 2) {
      features.push({ type: 'Feature', properties: { id, focus: focusId === null || id === focusId }, geometry: { type: 'LineString', coordinates: pts } })
    }
  })
  setData(map, SRC.trails, { type: 'FeatureCollection', features })
}

function distanceLabel(m: number): string {
  return m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`
}

export function setLinks(map: MLMap, links: LinkLine[]): void {
  setData(map, SRC.links, {
    type: 'FeatureCollection',
    features: links.map((l) => ({
      type: 'Feature',
      properties: { link_id: l.link_id, los: l.line_of_sight, distance_m: l.distance_m, label: distanceLabel(l.distance_m), focus: l.focus !== false },
      geometry: { type: 'LineString', coordinates: [l.from, l.to] },
    })),
  })
}

/** 清空全部态势数据（关掉态势图层开关时用）。图层留着，只把数据置空。 */
export function clearSituation(map: MLMap): void {
  for (const id of Object.values(SRC)) setData(map, id, EMPTY)
}
