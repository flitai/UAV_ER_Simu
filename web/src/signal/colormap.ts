// 色图（U-3，D-048）：viridis 的 10 个标准锚点分段线性插值成 256 级查找表，随包内嵌、零依赖（铁律 6）。
// 像素 ← 列用 srcIndexForPixel 最近邻，不插值；丢行画斜纹（09 §7.2：不留白、不静默跳过）。

import { FLOOR_DB, srcIndexForPixel } from './viewport.js'

export const VIRIDIS_ANCHORS: readonly string[] = [
  '#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725',
]

export type Rgb = [number, number, number]

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** 256 × RGBA 查找表；锚点落在 i = round(j·255/(n−1)) 处精确等于锚点色。 */
export function buildLut(anchors: readonly string[] = VIRIDIS_ANCHORS): Uint8ClampedArray {
  const rgb = anchors.map(hexToRgb)
  const n = rgb.length
  const lut = new Uint8ClampedArray(256 * 4)
  // 段边界取整数 b[j] = round(j·255/(n−1))，锚点在边界处精确命中
  const b = rgb.map((_, j) => Math.round((j * 255) / (n - 1)))
  for (let j = 0; j < n - 1; j++) {
    const a = rgb[j]!
    const c = rgb[j + 1]!
    const span = b[j + 1]! - b[j]!
    for (let i = b[j]!; i <= b[j + 1]!; i++) {
      const f = span > 0 ? (i - b[j]!) / span : 0
      lut[i * 4] = Math.round(a[0] + (c[0] - a[0]) * f)
      lut[i * 4 + 1] = Math.round(a[1] + (c[1] - a[1]) * f)
      lut[i * 4 + 2] = Math.round(a[2] + (c[2] - a[2]) * f)
      lut[i * 4 + 3] = 255
    }
  }
  return lut
}

/** dB 值 → 查找表序号 0..255；≤ floor、NaN、量程无效一律 0（最暗）。 */
export function dbToIndex(v: number, lo: number, hi: number): number {
  if (!(v > FLOOR_DB) || !(hi > lo)) return 0
  const u = (v - lo) / (hi - lo)
  if (!(u > 0)) return 0
  if (u >= 1) return 255
  return Math.round(u * 255)
}

/** 一行 dB 值 → W 个像素的 RGBA，写到 out[outOff ..)。cols 个值从 values[off] 起。 */
export function paintRow(
  values: Float32Array, off: number, cols: number, W: number, lo: number, hi: number,
  lut: Uint8ClampedArray, out: Uint8ClampedArray, outOff: number,
): void {
  for (let x = 0; x < W; x++) {
    const k = srcIndexForPixel(x, cols, W)
    const idx = k < 0 ? 0 : dbToIndex(values[off + k]!, lo, hi) * 4
    const o = outOff + x * 4
    out[o] = lut[idx]!
    out[o + 1] = lut[idx + 1]!
    out[o + 2] = lut[idx + 2]!
    out[o + 3] = 255
  }
}

/** 斜纹行：((x + y) & 4) 取墨色否则纸色，连续行自然成 45° 纹，周期 8 像素。 */
export function paintHatch(out: Uint8ClampedArray, outOff: number, W: number, y: number, ink: Rgb, paper: Rgb): void {
  for (let x = 0; x < W; x++) {
    const c = ((x + y) & 4) !== 0 ? ink : paper
    const o = outOff + x * 4
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255
  }
}

/** 纸色填充（数据尚未到达的行，不是丢行）。 */
export function paintBlank(out: Uint8ClampedArray, outOff: number, W: number, paper: Rgb): void {
  for (let x = 0; x < W; x++) {
    const o = outOff + x * 4
    out[o] = paper[0]; out[o + 1] = paper[1]; out[o + 2] = paper[2]; out[o + 3] = 255
  }
}
