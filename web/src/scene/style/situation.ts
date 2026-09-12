// 态势图层的色值与图标（06 备忘录 §9C G-5 的 D2-4；docs/display-route.md 第 4 节）。
//
// em-demo 的色值是为 protomaps 深色底图调的（测向线橙 #f97316、定位青 #22d3ee），
// 本项目的底图是照搬 Airports 的浅色样式，那些颜色在浅色底上对比度不足（D-017）。
// 这里是在浅色底图上重新标定的一套，标定依据与对比度校验结果写在 docs/display-route.md 第 4 节。
//
// 图形语义沿用 em-demo（docs/display-route.md 第 3 节，已冻结）：视距绿 / 非视距红、
// 无人机图标随航向旋转、航迹抽稀。首期没有威胁分级与效应染色，目标只有一种颜色。

/** 浅色底图上的态势色值。最低对比度 3.56:1（视距绿对水面），高于非文本图形的 3:1 门槛。 */
export const SIT = {
  site: '#1e40af',        // 侦察站
  siteHalo: '#ffffff',
  target: '#be123c',      // 无人机
  trail: '#be123c',       // 航迹，用低不透明度画
  linkLos: '#15803d',     // 视距链路
  linkNlos: '#b91c1c',    // 非视距链路（D3 接入遮挡后才会出现）
  route: '#475569',       // 规划航线，虚线
  waypoint: '#334155',
  waypointSel: '#be123c',
  measure: '#7c2d12',     // 测量工具
  halo: '#ffffff',
  // 测向与定位（D-053）。em-demo 的橙 #f97316 与青 #22d3ee 是为深色底调的，不沿用（D-017）；
  // 下面三色按 D2-4 的同一判据（WCAG 2.1 SC 1.4.11，非文本图形 ≥ 3:1）对陆地 / 建筑 / 水面
  // 三种底色实测：aoa 4.49 / 3.86 / 3.57，tdoa 4.80 / 4.12 / 3.81，fusion 6.36 / 5.46 / 5.05。
  bearing: '#b45309',     // 测向线（与 aoa 同色系，一眼看出线与解是一路的）
  aoa: '#b45309',         // 交叉定位点与 2σ 椭圆
  tdoa: '#0e7490',        // 时差定位
  fusion: '#6d28d9',      // aoa_tdoa 融合解
  // 告警区（D-061，13 报告 §4.2）。同一判据实测：alert 5.79 / 4.97 / 4.60，warning 6.35 / 5.45 / 5.04；
  // warning 特意比 bearing 的 #b45309 更深更红，免得楔形与警戒圈混成一色。
  zoneAlert: '#b91c1c',   // 告警区 alert；入圈目标的红环变体也用它
  zoneWarning: '#92400e', // 告警区 warning
} as const

/** 航迹抽稀：相邻点近于这个距离就不新增顶点。20 km 的观测区域上 3 米足够细。 */
export const TRAIL_MIN_STEP_DEG = 3e-5

/**
 * 无人机图标。单色路径，光栅化后用 source-in 染色（docs/display-route.md 第 3 节）；
 * 图标朝上画，靠 icon-rotate 表航向，所以尖端必须指向 +Y 的反方向（屏幕上的正北）。
 */
const DRONE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<path d="M16 2 L22 14 L17 13 L17 24 L21 24 L21 27 L11 27 L11 24 L15 24 L15 13 L10 14 Z"
      fill="#000" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>
</svg>`

/** 入圈变体：同一机身外加一圈粗环（D-061）。整个图标染成告警红，环让它在一群目标里一眼跳出来。 */
const DRONE_ALERT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<circle cx="16" cy="16" r="14" fill="none" stroke="#000" stroke-width="2.4"/>
<path d="M16 4 L21 14 L17 13 L17 23 L20.5 23 L20.5 25.5 L11.5 25.5 L11.5 23 L15 23 L15 13 L11 14 Z"
      fill="#000" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

const SITE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<circle cx="16" cy="16" r="7" fill="none" stroke="#000" stroke-width="3"/>
<circle cx="16" cy="16" r="2.5" fill="#000"/>
<path d="M16 3 L16 7 M16 25 L16 29 M3 16 L7 16 M25 16 L29 16" stroke="#000" stroke-width="2.5" stroke-linecap="round"/>
</svg>`

export type IconName = 'cuav-drone' | 'cuav-drone-alert' | 'cuav-site'

/** 把一段 SVG 变成染好色的 ImageData。异步：Image 解码是异步的。 */
export async function makeIcon(svg: string, px: number, color: string, halo: string): Promise<ImageData | null> {
  const c = document.createElement('canvas')
  c.width = px
  c.height = px
  const g = c.getContext('2d')
  if (!g) return null
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  const img = new Image()
  img.width = px
  img.height = px
  const ok = await new Promise<boolean>((res) => {
    img.onload = () => res(true)
    img.onerror = () => res(false)
    img.src = url
  })
  if (!ok) return null
  // 先画白色光晕：把图形错开一圈描出来，浅色底图上也能看清边界
  g.clearRect(0, 0, px, px)
  const r = Math.max(1, Math.round(px / 24))
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      if (dx * dx + dy * dy > r * r) continue
      g.drawImage(img, dx, dy, px, px)
    }
  }
  g.globalCompositeOperation = 'source-in'
  g.fillStyle = halo
  g.fillRect(0, 0, px, px)
  // 再把本体叠上去并染成主色
  g.globalCompositeOperation = 'source-over'
  const c2 = document.createElement('canvas')
  c2.width = px
  c2.height = px
  const g2 = c2.getContext('2d')
  if (!g2) return null
  g2.drawImage(img, 0, 0, px, px)
  g2.globalCompositeOperation = 'source-in'
  g2.fillStyle = color
  g2.fillRect(0, 0, px, px)
  g.drawImage(c2, 0, 0)
  return g.getImageData(0, 0, px, px)
}

export const ICON_SVG: Record<IconName, string> = {
  'cuav-drone': DRONE_SVG,
  'cuav-drone-alert': DRONE_ALERT_SVG,
  'cuav-site': SITE_SVG,
}

export const ICON_COLOR: Record<IconName, string> = {
  'cuav-drone': SIT.target,
  'cuav-drone-alert': SIT.zoneAlert,
  'cuav-site': SIT.site,
}
