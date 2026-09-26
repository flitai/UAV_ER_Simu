// 态势图层的色值与图标（06 备忘录 §9C G-5 的 D2-4；docs/display-route.md 第 4 节）。
//
// em-demo 的色值是为 protomaps 深色底图调的（测向线橙 #f97316、定位青 #22d3ee），
// 本项目的底图是照搬 Airports 的浅色样式，那些颜色在浅色底上对比度不足（D-017）。
// 这里是在浅色底图上重新标定的一套，标定依据与对比度校验结果写在 docs/display-route.md 第 4 节。
//
// 图形语义沿用 em-demo（docs/display-route.md 第 3 节，已冻结）：视距绿 / 非视距红、
// 无人机图标随航向旋转、航迹抽稀。首期没有威胁分级与效应染色，目标只有一种颜色。

import { platformSvg, type PlatformKind } from './platformIcons.js'

/** 浅色底图上的态势色值。最低对比度 3.56:1（视距绿对水面），高于非文本图形的 3:1 门槛。 */
export const SIT_LIGHT = {
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
  label: '#48423a',       // 地图上的目标与距离标注（= PM.ink）
}

type SitPalette = { [K in keyof typeof SIT_LIGHT]: string }

/**
 * 深色底图上的态势色值（D-078）。基本就是 em-demo 为深色底调的那一套（测向橙 #f97316、
 * 时差青 #22d3ee、威胁红、站点蓝），光晕换成底色——深色底上白晕反而刺眼。
 * 与浅色一样按 D2-4 的判据对深色底图的陆地 / 建筑 / 水面实测，结果见 docs/display-route.md §4。
 */
export const SIT_DARK: SitPalette = {
  site: '#38bdf8',
  siteHalo: '#0a0e17',
  target: '#f43f5e',
  trail: '#f43f5e',
  linkLos: '#22c55e',
  linkNlos: '#ef4444',
  route: '#94a3b8',
  waypoint: '#cbd5e1',
  waypointSel: '#f43f5e',
  measure: '#fb923c',
  halo: '#0a0e17',
  bearing: '#f97316',
  aoa: '#f97316',
  tdoa: '#22d3ee',
  fusion: '#a78bfa',
  zoneAlert: '#ef4444',
  zoneWarning: '#eab308',
  label: '#e2e8f0',
}

/**
 * **当前主题**下的态势色值。各图层模块照旧读 `SIT.xxx`，切主题时由 `setSituationTheme()` 原地换值：
 * Canvas 叠加层每帧读它，自然跟上；MapLibre 图层在建图时就把颜色写死了，要由
 * layers/situation.ts 的 `applySituationTheme()` 逐层重设（D-078）。
 */
export const SIT: SitPalette = { ...SIT_LIGHT }

export function setSituationTheme(theme: 'light' | 'dark'): void {
  Object.assign(SIT, theme === 'dark' ? SIT_DARK : SIT_LIGHT)
}

/** 航迹抽稀：相邻点近于这个距离就不新增顶点。20 km 的观测区域上 3 米足够细。 */
export const TRAIL_MIN_STEP_DEG = 3e-5

const SITE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<circle cx="16" cy="16" r="7" fill="none" stroke="#000" stroke-width="3"/>
<circle cx="16" cy="16" r="2.5" fill="#000"/>
<path d="M16 3 L16 7 M16 25 L16 29 M3 16 L7 16 M25 16 L29 16" stroke="#000" stroke-width="2.5" stroke-linecap="round"/>
</svg>`

/**
 * 图标名。无人机按机型分图（D-078，剪影见 platformIcons.ts）：多旋翼沿用旧名 `cuav-drone` /
 * `cuav-drone-alert`（端到端按这两个名字断言），固定翼加后缀 `-fixed_wing`。
 */
export type IconName = 'cuav-drone' | 'cuav-drone-alert' | 'cuav-drone-fixed_wing' | 'cuav-drone-alert-fixed_wing' | 'cuav-site'

/** 机型 → 图标名后缀（多旋翼为空，保住旧名）。 */
export function droneIconSuffix(kind: PlatformKind): string {
  return kind === 'multirotor' ? '' : `-${kind}`
}

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
  'cuav-drone': platformSvg('multirotor'),
  'cuav-drone-alert': platformSvg('multirotor', true),
  'cuav-drone-fixed_wing': platformSvg('fixed_wing'),
  'cuav-drone-alert-fixed_wing': platformSvg('fixed_wing', true),
  'cuav-site': SITE_SVG,
}

/** 图标颜色：按当前主题取（函数而不是常量表，切主题后重新光栅化时才取得到新值）。 */
export function iconColor(name: IconName): string {
  if (name === 'cuav-site') return SIT.site
  return name.startsWith('cuav-drone-alert') ? SIT.zoneAlert : SIT.target
}
