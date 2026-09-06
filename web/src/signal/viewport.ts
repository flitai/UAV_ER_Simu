// 视窗数学（U-3）：前半逐行对译 server/src/products/window.ts（D-046），后半是前端独有的
// 像素映射、缩放平移与请求规划。全部是无 DOM 的纯函数，可单测。
//
// 与服务端共用的三条约定（D-046）：区间半开 [lo, hi)；分组边界 B[g] = floor(g·n/m) 纯整数；
// 目标像素数超过原始数**不插值**。前端补一条（D-048）：像素 ← 源项取 floor(p·n/P) 最近邻，
// 源项少于像素时逐像素采样，同样不插值。

import type { ProductIndex } from '../state/types.js'

/** 半开区间 [lo, hi)。 */
export interface Span { lo: number; hi: number }
export type Stat = 'max' | 'mean' | 'min'
/** 视窗：时间相对索引 t0_s（秒），频率相对 center_Hz（Hz）。 */
export interface Viewport { t0: number; t1: number; f0: number; f1: number; stat: Stat }
export interface SpectrumGeom { dt: number; bw: number; nfft: number; rowsAvail: number }
export interface EnvelopeGeom { dt: number; rowsAvail: number; bucketSamples: number; lastBucketSamples: number; indexFinal: boolean }

/** 单次响应上限与缺省像素上限，与 server/src/products/window.ts 同值。 */
export const MAX_BYTES = 16 * 1024 * 1024
export const CAP_PY = 2048
export const CAP_PX = 4096
/** 精确零功率的下限（docs/display-products.md §2 的 floor_dB） */
export const FLOOR_DB = -300

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 时间窗 → 行区间（与服务端 selectRows 同式）。 */
export function selectRows(t0: number | null, t1: number | null, dt: number, rowsAvail: number): Span {
  const n = Math.max(0, Math.floor(rowsAvail))
  if (!(dt > 0)) return { lo: 0, hi: n }
  const lo = t0 === null ? 0 : clamp(Math.floor(t0 / dt), 0, n)
  const hi = t1 === null ? n : clamp(Math.ceil(t1 / dt), 0, n)
  return { lo, hi: Math.max(lo, hi) }
}

/** 频段 → 列区间（与服务端 selectCols 同式）：列 k 覆盖 [(k − half − 0.5)·bw, (k − half + 0.5)·bw)。 */
export function selectCols(f0: number | null, f1: number | null, bw: number, nfft: number): Span {
  const n = Math.max(0, Math.floor(nfft))
  if (!(bw > 0)) return { lo: 0, hi: n }
  const half = Math.floor(n / 2)
  const u = (f: number) => f / bw + half + 0.5
  const lo = f0 === null ? 0 : clamp(Math.floor(u(f0)), 0, n)
  const hi = f1 === null ? n : clamp(Math.ceil(u(f1)), 0, n)
  return { lo, hi: Math.max(lo, hi) }
}

/** 列 c 的低频边界（相对 center_Hz）。 */
export function colEdgeHz(c: number, bw: number, nfft: number): number {
  return (c - Math.floor(nfft / 2) - 0.5) * bw
}

/** 列 k 的中心频率（相对 center_Hz）。 */
export function colCenterHz(k: number, bw: number, nfft: number): number {
  return (k - Math.floor(nfft / 2)) * bw
}

/** n 个输入项分成 m 组的边界，长度 m + 1。 */
export function groupBounds(n: number, m: number): number[] {
  if (m <= 0) return [0]
  const out = new Array<number>(m + 1)
  for (let g = 0; g <= m; g++) out[g] = Math.floor((g * n) / m)
  return out
}

/** 输出组数：目标大于原始数不插值。 */
export function groupCount(n: number, target: number | null, cap: number): number {
  if (n <= 0) return 0
  const want = target === null ? Math.min(n, Math.max(1, cap)) : Math.min(Math.floor(target), n)
  return Math.max(1, want)
}

/** 像素 p（0..P−1）对应的源项序号：floor(p·n/P)。n = P 恒等；n < P 逐像素采样，不插值。 */
export function srcIndexForPixel(p: number, n: number, P: number): number {
  if (n <= 0 || P <= 0) return -1
  return Math.min(n - 1, Math.floor((p * n) / P))
}

export function spectrumGeomOf(index: ProductIndex): SpectrumGeom | null {
  const fs = index.sample_rate_Hz
  const nfft = index.nfft ?? index.row_len
  const hop = index.frame_hop_samples ?? 0
  if (!(fs > 0) || !(nfft > 0) || !(hop > 0)) return null
  const bw = index.bin_width_Hz ?? fs / nfft
  return { dt: hop / fs, bw, nfft, rowsAvail: Math.max(0, index.rows_available) }
}

export function envelopeGeomOf(index: ProductIndex): EnvelopeGeom | null {
  const fs = index.sample_rate_Hz
  const bucket = index.bucket_samples ?? 0
  if (!(fs > 0) || !(bucket > 0)) return null
  return {
    dt: bucket / fs,
    rowsAvail: Math.max(0, index.rows_available),
    bucketSamples: bucket,
    lastBucketSamples: index.last_bucket_samples ?? bucket,
    indexFinal: !!index.index_final,
  }
}

/** 全窗：时间 [0, rowsAvail·dt]（至少一行），频率全带。 */
export function fullWindow(g: SpectrumGeom, stat: Stat = 'max'): Viewport {
  return {
    t0: 0,
    t1: Math.max(1, g.rowsAvail) * g.dt,
    f0: colEdgeHz(0, g.bw, g.nfft),
    f1: colEdgeHz(g.nfft, g.bw, g.nfft),
    stat,
  }
}

/** 跟随模式的时间窗：最新行在顶，H 个像素行各一行。 */
export function liveWindow(newestRowIndex: number, H: number, dt: number): { t0: number; t1: number } {
  const t1 = (Math.max(0, newestRowIndex) + 1) * dt
  return { t0: Math.max(0, t1 - Math.max(1, H) * dt), t1 }
}

/** 夹到数据范围内，保证最小跨度一行 / 一列且 t0 < t1、f0 < f1。 */
export function clampViewport(vp: Viewport, g: SpectrumGeom): Viewport {
  const tMax = Math.max(1, g.rowsAvail) * g.dt
  const fLo = colEdgeHz(0, g.bw, g.nfft)
  const fHi = colEdgeHz(g.nfft, g.bw, g.nfft)
  let t0 = clamp(Math.min(vp.t0, vp.t1), 0, tMax)
  let t1 = clamp(Math.max(vp.t0, vp.t1), 0, tMax)
  if (t1 - t0 < g.dt) {
    t1 = Math.min(tMax, t0 + g.dt)
    t0 = Math.max(0, t1 - g.dt)
  }
  let f0 = clamp(Math.min(vp.f0, vp.f1), fLo, fHi)
  let f1 = clamp(Math.max(vp.f0, vp.f1), fLo, fHi)
  if (f1 - f0 < g.bw) {
    f1 = Math.min(fHi, f0 + g.bw)
    f0 = Math.max(fLo, f1 - g.bw)
  }
  return { t0, t1, f0, f1, stat: vp.stat }
}

export interface SpectrumRequest { t0: number; t1: number; f0: number; f1: number; px: number; py: number; stat: Stat }

/**
 * 回看请求的像素参数：px = min(W, CAP_PX)，py = min(H, CAP_PY, floor(MAX_BYTES / (cols × 4)))，
 * 与服务端缺省同式，因此永不 413；W / H 为 0（尚未布局）时取 1。
 */
export function planSpectrumQuery(vp: Viewport, W: number, H: number, g: SpectrumGeom): SpectrumRequest {
  const colSpan = selectCols(vp.f0, vp.f1, g.bw, g.nfft)
  const nCols = colSpan.hi - colSpan.lo
  const px = Math.max(1, Math.min(Math.floor(W), CAP_PX))
  const cols = Math.max(1, Math.min(px, nCols))
  const capPy = Math.max(1, Math.min(CAP_PY, Math.floor(MAX_BYTES / (cols * 4))))
  const py = Math.max(1, Math.min(Math.floor(H), capPy))
  return { t0: vp.t0, t1: vp.t1, f0: vp.f0, f1: vp.f1, px, py, stat: vp.stat }
}

/** 时间 → 像素行（顶 = t1，最新在顶）。 */
export function timeToY(t: number, H: number, t0: number, t1: number): number {
  const span = t1 - t0
  return span > 0 ? ((t1 - t) / span) * H + 0 : 0
}
export function yToTime(y: number, H: number, t0: number, t1: number): number {
  return H > 0 ? t1 - (y / H) * (t1 - t0) : t1
}
export function freqToX(f: number, W: number, f0: number, f1: number): number {
  const span = f1 - f0
  return span > 0 ? ((f - f0) / span) * W + 0 : 0
}
export function xToFreq(x: number, W: number, f0: number, f1: number): number {
  return W > 0 ? f0 + (x / W) * (f1 - f0) : f0
}

/** 以 anchor 为不动点缩放区间，跨度不小于 minSpan，整体不出 bounds（能平移就平移，否则裁剪）。 */
export function zoomSpan(s: Span, anchor: number, factor: number, minSpan: number, bounds: Span): Span {
  const width = Math.max(minSpan, (s.hi - s.lo) * factor)
  const a = clamp(anchor, s.lo, s.hi)
  const frac = s.hi > s.lo ? (a - s.lo) / (s.hi - s.lo) : 0.5
  return fitSpan({ lo: a - frac * width, hi: a + (1 - frac) * width }, bounds)
}

/** 平移 delta，整体不出 bounds。 */
export function panSpan(s: Span, delta: number, bounds: Span): Span {
  return fitSpan({ lo: s.lo + delta, hi: s.hi + delta }, bounds)
}

function fitSpan(s: Span, bounds: Span): Span {
  const width = s.hi - s.lo
  const bw = bounds.hi - bounds.lo
  if (width >= bw) return { lo: bounds.lo, hi: bounds.hi }
  if (s.lo < bounds.lo) return { lo: bounds.lo, hi: bounds.lo + width }
  if (s.hi > bounds.hi) return { lo: bounds.hi - width, hi: bounds.hi }
  return { lo: s.lo, hi: s.hi }
}

/** 瀑布上的框选（设备像素）→ 视窗；y 向下时间减小。 */
export function boxToViewport(
  vp: Viewport,
  box: { x0: number; y0: number; x1: number; y1: number },
  W: number,
  H: number,
  g: SpectrumGeom,
): Viewport {
  const fa = xToFreq(Math.min(box.x0, box.x1), W, vp.f0, vp.f1)
  const fb = xToFreq(Math.max(box.x0, box.x1), W, vp.f0, vp.f1)
  const ta = yToTime(Math.max(box.y0, box.y1), H, vp.t0, vp.t1)
  const tb = yToTime(Math.min(box.y0, box.y1), H, vp.t0, vp.t1)
  return clampViewport({ t0: ta, t1: tb, f0: fa, f1: fb, stat: vp.stat }, g)
}

/** 时间游标步进：以行起始时刻为格点，null 从窗内最新一行起；越窗夹住。 */
export function cursorStep(t: number | null, dir: -1 | 1, times10: boolean, dt: number, win: { t0: number; t1: number }): number {
  const last = Math.max(win.t0, win.t1 - dt)
  const start = t === null ? last : t
  const stepped = start + dir * dt * (times10 ? 10 : 1)
  const snapped = Math.round(stepped / dt) * dt
  return clamp(snapped, win.t0, last) + 0
}
