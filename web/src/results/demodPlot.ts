// 解调页签的两种图（D-107），画在 Canvas 2D 上，颜色取 CSS 令牌（浅色 / 深色随主题，D-078）：
//   ① OFDM 星座：均衡后的点（半透明）、理想星座点（叉）、判决边界（虚线）；
//   ② GFSK 频偏：符号中心频偏直方图（标出名义 ±f_dev）+ 一个包的瞬时频偏轨迹与符号中心点。
// 只画事实，不写解释句（D-039）。

import { token, withAlpha } from '../shell/theme.js'
import type { DemodHeader } from '../api/client.js'

interface Pal { bg: string; grid: string; dim: string; ink: string; pt: string; mark: string }

function pal(): Pal {
  return {
    bg: token('--white', '#ffffff'), grid: token('--border', '#ddd7cd'), dim: token('--dim', '#7b7367'),
    ink: token('--ink', '#48423a'), pt: token('--accent', '#1e40af'), mark: token('--target', '#be123c'),
  }
}

export function setupCanvas(cv: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
  }
  cv.style.width = `${w}px`
  cv.style.height = `${h}px`
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

function levelsOf(h: DemodHeader): number[] {
  const xs = new Set<number>()
  for (const [a] of h.ideal ?? []) xs.add(a)
  return [...xs].sort((a, b) => a - b)
}

export function drawConstellation(ctx: CanvasRenderingContext2D, size: number, h: DemodHeader, pts: Float32Array): void {
  const p = pal()
  const pad = 34
  const plot = size - 2 * pad
  ctx.fillStyle = p.bg
  ctx.fillRect(0, 0, size, size)
  const lv = levelsOf(h)
  const R = Math.max(...lv.map(Math.abs), 0.5) * 1.6
  const X = (v: number) => pad + ((v + R) / (2 * R)) * plot
  const Y = (v: number) => pad + ((R - v) / (2 * R)) * plot
  // 框与轴
  ctx.strokeStyle = p.grid
  ctx.lineWidth = 1
  ctx.strokeRect(pad + 0.5, pad + 0.5, plot, plot)
  ctx.beginPath()
  ctx.moveTo(X(0), pad); ctx.lineTo(X(0), pad + plot)
  ctx.moveTo(pad, Y(0)); ctx.lineTo(pad + plot, Y(0))
  ctx.stroke()
  // 判决边界：相邻电平的中点
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  for (let i = 0; i + 1 < lv.length; i++) {
    const m = 0.5 * (lv[i] + lv[i + 1])
    if (Math.abs(m) < 1e-9) continue
    ctx.moveTo(X(m), pad); ctx.lineTo(X(m), pad + plot)
    ctx.moveTo(pad, Y(m)); ctx.lineTo(pad + plot, Y(m))
  }
  ctx.stroke()
  ctx.setLineDash([])
  // 点：点多则淡
  const n = pts.length / 2
  const alpha = Math.min(0.85, Math.max(0.12, 600 / Math.max(n, 1)))
  ctx.fillStyle = withAlpha(p.pt, alpha)
  const r = n > 8000 ? 1.1 : 1.6
  for (let i = 0; i < n; i++) {
    const x = X(pts[2 * i])
    const y = Y(pts[2 * i + 1])
    if (x < pad || x > pad + plot || y < pad || y > pad + plot) continue
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r)
  }
  // 理想星座点
  ctx.strokeStyle = p.mark
  ctx.lineWidth = 1.5
  for (const [a, b] of h.ideal ?? []) {
    const x = X(a)
    const y = Y(b)
    ctx.beginPath()
    ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y)
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5)
    ctx.stroke()
  }
  // 刻度
  ctx.fillStyle = p.dim
  ctx.font = '11px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (const v of [-1, 0, 1]) ctx.fillText(String(v), X(v), pad + plot + 4)
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (const v of [-1, 0, 1]) ctx.fillText(String(v), pad - 4, Y(v))
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillText('I', pad + plot / 2, size - 2)
  ctx.save()
  ctx.translate(10, pad + plot / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.textBaseline = 'middle'
  ctx.fillText('Q', 0, 0)
  ctx.restore()
}

/** 直方图的分箱（kHz）：范围 ±2·名义频偏，箱宽取名义频偏的 1/16 */
export function histogram(dev: Float32Array, fdevHz: number): { lo: number; w: number; counts: number[] } {
  const lo = -2 * fdevHz
  const w = fdevHz / 16
  const counts = new Array<number>(64).fill(0)
  for (const v of dev) {
    const i = Math.floor((v - lo) / w)
    if (i >= 0 && i < counts.length) counts[i]++
  }
  return { lo, w, counts }
}

export function drawGfsk(ctx: CanvasRenderingContext2D, w: number, hgt: number, h: DemodHeader, dev: Float32Array,
  trace: Float32Array): void {
  const p = pal()
  ctx.fillStyle = p.bg
  ctx.fillRect(0, 0, w, hgt)
  const fdev = h.deviation_nominal_Hz ?? 1
  const R = h.symbol_rate_Hz ?? 1
  const padL = 48
  const padR = 12
  const top1 = 10
  const h1 = Math.round((hgt - 70) * 0.5)
  const top2 = top1 + h1 + 36
  const h2 = hgt - top2 - 24
  const pw = w - padL - padR
  ctx.font = '11px system-ui, sans-serif'
  // ① 直方图
  const hist = histogram(dev, fdev)
  const cmax = Math.max(1, ...hist.counts)
  const fx = (f: number) => padL + ((f - hist.lo) / (4 * fdev)) * pw
  ctx.strokeStyle = p.grid
  ctx.strokeRect(padL + 0.5, top1 + 0.5, pw, h1)
  ctx.fillStyle = withAlpha(p.pt, 0.75)
  hist.counts.forEach((c, i) => {
    if (!c) return
    const x0 = fx(hist.lo + i * hist.w)
    const x1 = fx(hist.lo + (i + 1) * hist.w)
    const y = top1 + h1 - (c / cmax) * (h1 - 4)
    ctx.fillRect(x0 + 0.5, y, Math.max(1, x1 - x0 - 1), top1 + h1 - y)
  })
  ctx.strokeStyle = p.mark
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  for (const f of [-fdev, fdev]) { ctx.moveTo(fx(f), top1); ctx.lineTo(fx(f), top1 + h1) }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = p.dim
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (const f of [-2 * fdev, -fdev, 0, fdev, 2 * fdev]) ctx.fillText((f / 1e3).toFixed(0), fx(f), top1 + h1 + 3)
  ctx.fillText('符号中心频偏 / kHz', padL + pw / 2, top1 + h1 + 17)
  // ② 轨迹
  const n = trace.length / 2
  if (n < 2) return
  const t0 = trace[0]
  const t1 = trace[2 * (n - 1)]
  const tx = (t: number) => padL + ((t - t0) / (t1 - t0)) * pw
  const fy = (f: number) => top2 + ((2 * fdev - f) / (4 * fdev)) * h2
  ctx.strokeStyle = p.grid
  ctx.strokeRect(padL + 0.5, top2 + 0.5, pw, h2)
  ctx.beginPath()
  ctx.moveTo(padL, fy(0)); ctx.lineTo(padL + pw, fy(0))
  ctx.stroke()
  ctx.strokeStyle = p.mark
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  for (const f of [-fdev, fdev]) { ctx.moveTo(padL, fy(f)); ctx.lineTo(padL + pw, fy(f)) }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.save()
  ctx.beginPath()
  ctx.rect(padL, top2, pw, h2)
  ctx.clip()
  ctx.strokeStyle = withAlpha(p.ink, 0.6)
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const x = tx(trace[2 * i])
    const y = fy(trace[2 * i + 1])
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.fillStyle = p.pt
  for (let k = 0; k < dev.length; k++) {
    const x = tx((k + 0.5) / R)
    ctx.fillRect(x - 1.5, fy(dev[k]) - 1.5, 3, 3)
  }
  ctx.restore()
  ctx.fillStyle = p.dim
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (const f of [-fdev, 0, fdev]) ctx.fillText((f / 1e3).toFixed(0), padL - 4, fy(f))
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const dur = t1 - t0
  const stepMs = dur * 1e3 > 2 ? 0.5 : 0.2
  for (let t = 0; t <= t1 * 1e3 + 1e-9; t += stepMs) {
    if (t / 1e3 < t0) continue
    ctx.fillText(t.toFixed(1), tx(t / 1e3), top2 + h2 + 3)
  }
  ctx.save()
  ctx.translate(12, top2 + h2 / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.textAlign = 'center'
  ctx.fillText('频偏 / kHz', 0, 0)
  ctx.restore()
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillText('时间 / ms', padL + pw, hgt - 1)
}
