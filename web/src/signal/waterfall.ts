// 瀑布簿记（U-3，纯函数）：位移计划、跟随模式的新行图像（缺号斜纹、未到纸色）、回看模式的整窗图像。
// 像素行 0 是最新（09 §7.2「最新行在顶」）。

import { paintBlank, paintHatch, paintRow, type Rgb } from './colormap.js'
import { reduceSpectrumRow, type Extract } from './reduce.js'
import { srcIndexForPixel, type Stat } from './viewport.js'

export type ShiftPlan = { kind: 'none' } | { kind: 'shift'; k: number } | { kind: 'full' }

/** 上次画到 prevNewest（−1 = 还没画过），现在最新 newest：位移 k = newest − prevNewest；k ≥ H 或倒退则全画。 */
export function planShift(prevNewest: number, newest: number, H: number): ShiftPlan {
  if (newest < 0) return { kind: 'none' }
  if (prevNewest < 0 || newest < prevNewest) return { kind: 'full' }
  if (newest === prevNewest) return { kind: 'none' }
  const k = newest - prevNewest
  return k >= H ? { kind: 'full' } : { kind: 'shift', k }
}

export interface RowLookup { rowByIndex(i: number): Float32Array | null }

export interface LivePaint {
  W: number
  lo: number
  hi: number
  lut: Uint8ClampedArray
  stat: Stat
  /** 列分组：相对 colLo 的边界，长度 cols + 1 */
  colLo: number
  cb: number[]
  ink: Rgb
  paper: Rgb
}

/**
 * 跟随模式：从 toIndex（在顶）到 fromIndex（在底）逐行取环，缺号斜纹、负行号纸色。
 * 返回 (toIndex − fromIndex + 1) 行的 RGBA。
 */
export function buildLiveRows(src: RowLookup, fromIndex: number, toIndex: number, o: LivePaint): { img: Uint8ClampedArray<ArrayBuffer>; rows: number; hatched: number; blank: number } {
  const rows = Math.max(0, toIndex - fromIndex + 1)
  const img = new Uint8ClampedArray(new ArrayBuffer(rows * o.W * 4))
  const cols = o.cb.length - 1
  const tmp = new Float32Array(Math.max(1, cols))
  let hatched = 0
  let blank = 0
  for (let y = 0; y < rows; y++) {
    const i = toIndex - y
    const off = y * o.W * 4
    if (i < 0) { paintBlank(img, off, o.W, o.paper); blank++; continue }
    const row = src.rowByIndex(i)
    if (!row) { paintHatch(img, off, o.W, y, o.ink, o.paper); hatched++; continue }
    reduceSpectrumRow(row, o.colLo, o.cb, o.stat, tmp, 0)
    paintRow(tmp, 0, cols, o.W, o.lo, o.hi, o.lut, img, off)
  }
  return { img, rows, hatched, blank }
}

/** 回看模式：像素行 y ← 数据行 rows − 1 − srcIndexForPixel(y, rows, H)（顶 = 最新）；rows = 0 全纸色。 */
export function buildWindowImage(ext: Extract, W: number, H: number, lo: number, hi: number, lut: Uint8ClampedArray, paper: Rgb): Uint8ClampedArray<ArrayBuffer> {
  const img = new Uint8ClampedArray(new ArrayBuffer(W * H * 4))
  for (let y = 0; y < H; y++) {
    const off = y * W * 4
    if (ext.rows === 0 || ext.cols === 0) { paintBlank(img, off, W, paper); continue }
    const r = ext.rows - 1 - srcIndexForPixel(y, ext.rows, H)
    paintRow(ext.data, r * ext.cols, ext.cols, W, lo, hi, lut, img, off)
  }
  return img
}
