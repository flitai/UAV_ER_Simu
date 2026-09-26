// 卡片用的两种小图形（13 报告 §3.3）：机型剪影与小方位盘。内联 SVG，不加载任何资源（铁律 6）。

import { PLATFORM_SHAPES, platformKind } from '../style/platformIcons.js'

/**
 * 机型剪影：与地图图标同一份（D-078，platformIcons.ts），currentColor 填色，朝上画。
 * 四个 `platform_type` 归成两种剪影；具体机型写在旁边的文字里。
 */
export function PlatformIcon({ type, size = 22 }: { type: string; size?: number }) {
  const shape = PLATFORM_SHAPES[platformKind(type).kind]
  return (
    <svg width={size} height={size} viewBox={shape.viewBox} aria-hidden className="plat-icon">
      {shape.paths.map((d, i) => <path key={i} d={d} fill="currentColor" fillRule="evenodd" />)}
    </svg>
  )
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180   // 真北在上、顺时针（铁律 1）
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

/**
 * 小方位盘：真北朝上，量测方位一根箭头，±2σ 一个扇区；测向裁决非 valid 时箭头虚线。
 * 只画量测，不画真值（D-039：界面不主动解释；真值只在开发者模式）。
 */
export function BearingDial({ bearing_deg, sigma_deg, valid, size = 40 }: { bearing_deg: number; sigma_deg: number; valid: boolean; size?: number }) {
  const c = size / 2
  const r = c - 3
  const half = Math.max(2 * sigma_deg, 1.5)
  const [x0, y0] = polar(c, c, r, bearing_deg - half)
  const [x1, y1] = polar(c, c, r, bearing_deg + half)
  const large = half * 2 > 180 ? 1 : 0
  const wedge = `M ${c} ${c} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`
  const [ax, ay] = polar(c, c, r, bearing_deg)
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="dial" aria-hidden="true">
      <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeOpacity="0.35" />
      <line x1={c} y1={c - r} x2={c} y2={c - r + 4} stroke="currentColor" strokeWidth="1.5" />
      <path d={wedge} fill="currentColor" fillOpacity="0.18" />
      <line x1={c} y1={c} x2={ax.toFixed(2)} y2={ay.toFixed(2)} stroke="currentColor" strokeWidth="2"
            strokeDasharray={valid ? undefined : '3 2'} strokeLinecap="round" />
      <circle cx={c} cy={c} r="1.8" fill="currentColor" />
    </svg>
  )
}
