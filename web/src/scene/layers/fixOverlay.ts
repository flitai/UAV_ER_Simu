// 测向线与定位误差椭圆的 Canvas 叠加层（D-053，11 报告 §5.4；docs/display-route.md §3 冻结的语义）。
//
// 为什么走 Canvas 而不是 MapLibre 图层：扇形楔子与旋转椭圆都不是 GeoJSON 能直接表达的形状，
// 用多边形近似要在每帧重算顶点，反而更贵；`map.project` 把经纬度换成像素后由 2D 上下文直接画。
// 这与 09 附录 A.2 对 PPI 扫描 / 误差椭圆的既定做法一致。
//
// **地图拆除是异步事件驱动的**（D-049 ⑩）：每个入口先查地图还活着，否则抛在 React 效应里
// 会让整棵界面树被卸载。

import type { Map as MlMap } from 'maplibre-gl'
import type { BearingSample, PositionSample } from '../sceneStore.js'
import { SIT } from '../style/situation.js'

const CLASS = 'cuav-fix-overlay'

/** 无定位解时测向线画多长（米）。有解时画到解算点再延伸一段，见下。 */
const RAY_FALLBACK_M = 3000
/** 有定位解时越过解算点再延伸的比例——线穿过交汇点才看得出「几条线交在这里」。 */
const RAY_OVERSHOOT = 0.2

export interface FixOverlayInput {
  /** 站点位置，键 site_id */
  sites: Map<string, { lon: number; lat: number }>
  bearings: BearingSample[]
  positions: PositionSample[]
  /** 开发者模式下才画标签（D-039：界面不主动解释） */
  dev: boolean
}

interface Handle {
  canvas: HTMLCanvasElement
  draw: (input: FixOverlayInput) => void
  destroy: () => void
}

/** 经纬度沿真北顺时针方位推进给定距离，得到另一点。小范围用等距圆柱近似足够画图。 */
function advance(lon: number, lat: number, bearing_deg: number, dist_m: number): [number, number] {
  const rad = (bearing_deg * Math.PI) / 180
  const dN = dist_m * Math.cos(rad)
  const dE = dist_m * Math.sin(rad)
  const mPerDegLat = 111132.0
  const mPerDegLon = 111320.0 * Math.cos((lat * Math.PI) / 180)
  return [lon + dE / (mPerDegLon || 1), lat + dN / mPerDegLat]
}

function methodColor(m: string): string {
  if (m === 'tdoa') return SIT.tdoa
  if (m === 'aoa_tdoa') return SIT.fusion
  return SIT.aoa
}

/** 把 #rrggbb 加上不透明度变成 rgba()。 */
function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

export function attachFixOverlay(map: MlMap): Handle | null {
  const container = map.getContainer()
  if (!container) return null
  const canvas = document.createElement('canvas')
  canvas.className = CLASS
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.pointerEvents = 'none'   // 不吃鼠标事件：底下的地图照常拖拽缩放
  container.appendChild(canvas)

  let last: FixOverlayInput | null = null

  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1
    const w = container.clientWidth
    const h = container.clientHeight
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
  }

  const draw = (input: FixOverlayInput): void => {
    last = input
    // 地图可能已经被拆掉：MapLibre 的 remove() 之后 project 会抛
    if (!map.getContainer || !map.getContainer()) return
    resize()
    const g = canvas.getContext('2d')
    if (!g) return
    const dpr = window.devicePixelRatio || 1
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)

    // 有定位解的目标：测向线画到解算点，没有就画固定长度
    const fixOf = new Map<string, PositionSample>()
    for (const p of input.positions) {
      const cur = fixOf.get(p.emitter_id)
      if (!cur || p.t_s > cur.t_s) fixOf.set(p.emitter_id, p)
    }

    // ---------------- 测向线与 ±2σ 楔形
    for (const b of input.bearings) {
      if (b.use_policy === 'exclude') continue          // 被剔除的量测不画：画了会让人以为它参与了解算
      const s = input.sites.get(b.site_id)
      if (!s) continue
      const fix = fixOf.get(b.emitter_id)
      let dist = RAY_FALLBACK_M
      if (fix) {
        const mPerDegLat = 111132.0
        const mPerDegLon = 111320.0 * Math.cos((s.lat * Math.PI) / 180)
        const dE = (fix.lon - s.lon) * mPerDegLon
        const dN = (fix.lat - s.lat) * mPerDegLat
        dist = Math.hypot(dE, dN) * (1 + RAY_OVERSHOOT)
      }
      const p0 = map.project([s.lon, s.lat])
      const end = advance(s.lon, s.lat, b.bearing_deg, dist)
      const p1 = map.project(end)

      // ±2σ 楔形：σ 大时一眼看得出这条线不可信
      if (b.bearing_std_deg > 0.05) {
        const a = advance(s.lon, s.lat, b.bearing_deg - 2 * b.bearing_std_deg, dist)
        const c = advance(s.lon, s.lat, b.bearing_deg + 2 * b.bearing_std_deg, dist)
        const pa = map.project(a)
        const pc = map.project(c)
        g.beginPath()
        g.moveTo(p0.x, p0.y)
        g.lineTo(pa.x, pa.y)
        g.lineTo(pc.x, pc.y)
        g.closePath()
        g.fillStyle = alpha(SIT.bearing, 0.1)
        g.fill()
      }

      g.beginPath()
      g.moveTo(p0.x, p0.y)
      g.lineTo(p1.x, p1.y)
      g.strokeStyle = SIT.bearing
      g.lineWidth = 1.5
      // 非 valid 的裁决画虚线：数据在，但这一帧的测向不可信
      g.setLineDash(b.df_result_state === 'valid' ? [] : [5, 4])
      g.stroke()
      g.setLineDash([])
    }

    // ---------------- 定位点与 2σ 椭圆
    for (const p of input.positions) {
      if (p.state === 'invalid') continue
      const c = map.project([p.lon, p.lat])
      const color = methodColor(p.method)
      // 半轴长度换算成像素：沿正东与正北各取一点，量出每米多少像素
      const east = map.project(advance(p.lon, p.lat, 90, Math.max(p.semi_major_m, 1)))
      const north = map.project(advance(p.lon, p.lat, 0, Math.max(p.semi_major_m, 1)))
      const pxPerM = Math.hypot(east.x - c.x, east.y - c.y) / Math.max(p.semi_major_m, 1)
      const pyPerM = Math.hypot(north.x - c.x, north.y - c.y) / Math.max(p.semi_major_m, 1)
      const scale = (pxPerM + pyPerM) / 2
      const a = Math.max(p.semi_major_m * scale, 2)
      const bAxis = Math.max(p.semi_minor_m * scale, 2)
      // 椭圆旋转角是相对 ENU 东向的（PositionReport.enu_origin 声明过），
      // 屏幕 y 轴朝下，所以取负
      g.beginPath()
      g.ellipse(c.x, c.y, a, bAxis, (-p.rotation_deg * Math.PI) / 180, 0, Math.PI * 2)
      g.fillStyle = alpha(color, 0.12)
      g.fill()
      g.strokeStyle = color
      g.lineWidth = 1.5
      g.stroke()

      g.beginPath()
      g.moveTo(c.x - 5, c.y)
      g.lineTo(c.x + 5, c.y)
      g.moveTo(c.x, c.y - 5)
      g.lineTo(c.x, c.y + 5)
      g.strokeStyle = color
      g.lineWidth = 2
      g.stroke()

      // 标签只在开发者模式（D-039：界面不主动解释）
      if (input.dev) {
        g.font = '11px system-ui, sans-serif'
        g.fillStyle = color
        g.fillText(`${p.method} CEP ${p.cep_m.toFixed(0)} m`, c.x + 8, c.y - 8)
      }
    }
  }

  const onMove = (): void => { if (last) draw(last) }
  map.on('move', onMove)
  map.on('resize', onMove)

  return {
    canvas,
    draw,
    destroy() {
      map.off('move', onMove)
      map.off('resize', onMove)
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas)
    },
  }
}
