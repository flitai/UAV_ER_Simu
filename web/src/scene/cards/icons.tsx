// 卡片用的两种小图形（13 报告 §3.3）：机型剪影与小方位盘。内联 SVG，不加载任何资源（铁律 6）。

/** 机型剪影：按 `platform_type` 四选一，都用 currentColor 填色，朝上画。 */
export function PlatformIcon({ type, size = 22 }: { type: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 32 32', 'aria-hidden': true, className: 'plat-icon' }
  switch (type) {
    case 'fixed_wing':
      return (
        <svg {...common}>
          <path d="M16 2 L18 12 L30 16 L30 19 L18 17 L17 26 L21 28 L21 30 L11 30 L11 28 L15 26 L14 17 L2 19 L2 16 L14 12 Z" fill="currentColor" />
        </svg>
      )
    case 'racing':
      return (
        <svg {...common}>
          <path d="M6 6 L26 26 M26 6 L6 26" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <circle cx="6" cy="6" r="3.5" fill="currentColor" /><circle cx="26" cy="6" r="3.5" fill="currentColor" />
          <circle cx="6" cy="26" r="3.5" fill="currentColor" /><circle cx="26" cy="26" r="3.5" fill="currentColor" />
          <circle cx="16" cy="16" r="3" fill="currentColor" />
        </svg>
      )
    case 'medium':
      return (
        <svg {...common}>
          <path d="M16 3 L19 11 L30 13 L30 17 L19 16 L18 25 L24 27 L24 30 L8 30 L8 27 L14 25 L13 16 L2 17 L2 13 L13 11 Z" fill="currentColor" />
        </svg>
      )
    default:   // multirotor
      return (
        <svg {...common}>
          <path d="M8 8 L24 24 M24 8 L8 24" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="24" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="8" cy="24" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="24" cy="24" r="5" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="16" cy="16" r="3.5" fill="currentColor" />
        </svg>
      )
  }
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
