// 覆盖场的着色（D-079）：viridis 五档 + 值域不透明度，照 em-demo 的覆盖图层取值
// （`components/MapView.tsx` 的 coverage-fill：色 0→#440154 … 1→#fde725，
// 不透明度 0→0、.05→.18、.5→.34、1→.46）。色表复用信号视图那张随包的 viridis（signal/colormap.ts），
// 两种主题通用，不随主题换。

import { buildLut } from '../../signal/colormap.js'

const LUT = buildLut()

/** Pd → 不透明度，分段线性。低于 0.02 的格全透明（em-demo 的 VALUE_FLOOR）。 */
export function alphaOf(pd: number): number {
  if (!(pd >= 0.02)) return 0
  if (pd <= 0.05) return 0.18 * (pd / 0.05)
  if (pd <= 0.5) return 0.18 + (0.34 - 0.18) * ((pd - 0.05) / 0.45)
  return 0.34 + (0.46 - 0.34) * ((Math.min(pd, 1) - 0.5) / 0.5)
}

/** 网格 → RGBA 像素（一格一像素，第 0 行在北，与图像同向）。 */
export function paintField(nx: number, ny: number, v: ArrayLike<number>): Uint8ClampedArray {
  const px = new Uint8ClampedArray(nx * ny * 4)
  for (let k = 0; k < nx * ny; k++) {
    const pd = v[k]!
    const a = alphaOf(pd)
    if (a === 0) continue
    const idx = Math.max(0, Math.min(255, Math.round(pd * 255)))
    px[k * 4] = LUT[idx * 4]!
    px[k * 4 + 1] = LUT[idx * 4 + 1]!
    px[k * 4 + 2] = LUT[idx * 4 + 2]!
    px[k * 4 + 3] = Math.round(a * 255)
  }
  return px
}
