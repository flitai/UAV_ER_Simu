// 迹线模式与 marker 读数（U-3，09 §7.2 迹线行与 Marker 行）。
// avg 在线性功率域求平均，与 reduce.ts 的 mean 同式；maxhold / minhold 逐点保持。

import { FLOOR_DB } from './viewport.js'

export type TraceMode = 'single' | 'avg' | 'maxhold' | 'minhold'

/** 线性功率域平均：out[k] = 10·log10(Σ 10^(v/10) / N)，行序累加。 */
export function avgLinear(rows: readonly Float32Array[], out: Float32Array): void {
  const cols = out.length
  const acc = new Float64Array(cols)
  for (const r of rows) for (let k = 0; k < cols; k++) acc[k] = acc[k]! + Math.pow(10, r[k]! / 10)
  const n = rows.length
  for (let k = 0; k < cols; k++) out[k] = n > 0 ? 10 * Math.log10(acc[k]! / n) : FLOOR_DB
}

export class TraceState {
  private hist: Float32Array[] = []
  private hold: Float32Array | null = null
  private latest: Float32Array | null = null
  private out: Float32Array | null = null
  private dirty = true

  constructor(public mode: TraceMode = 'single', public n = 16) {}

  /** 改模式或平均帧数：清历史。 */
  configure(mode: TraceMode, n: number): void {
    if (mode === this.mode && n === this.n) return
    this.mode = mode
    this.n = Math.max(1, Math.floor(n))
    this.reset()
  }

  reset(): void {
    this.hist = []
    this.hold = null
    this.latest = null
    this.out = null
    this.dirty = true
  }

  /** 推入一行（拷贝）。 */
  push(row: Float32Array): void {
    const cols = row.length
    if (this.latest && this.latest.length !== cols) this.reset()
    const copy = new Float32Array(row)
    this.latest = copy
    if (this.mode === 'avg') {
      this.hist.push(copy)
      while (this.hist.length > this.n) this.hist.shift()
    } else if (this.mode === 'maxhold' || this.mode === 'minhold') {
      if (!this.hold) this.hold = new Float32Array(copy)
      else if (this.mode === 'maxhold') { for (let k = 0; k < cols; k++) if (copy[k]! > this.hold[k]!) this.hold[k] = copy[k]! }
      else { for (let k = 0; k < cols; k++) if (copy[k]! < this.hold[k]!) this.hold[k] = copy[k]! }
    }
    this.dirty = true
  }

  get frames(): number { return this.mode === 'avg' ? this.hist.length : this.latest ? 1 : 0 }

  /** 当前迹线；没有数据时 null。返回的数组只读，下一次 push 后失效。 */
  value(): Float32Array | null {
    if (!this.latest) return null
    if (this.mode === 'single') return this.latest
    if (this.mode === 'avg') {
      if (this.dirty || !this.out || this.out.length !== this.latest.length) {
        this.out = new Float32Array(this.latest.length)
        avgLinear(this.hist, this.out)
        this.dirty = false
      }
      return this.out
    }
    return this.hold
  }
}

/** 峰值：忽略 ≤ floorDb 与非有限值；全无则 null。 */
export function peakOf(values: ArrayLike<number> | null, floorDb = FLOOR_DB): { k: number; v: number } | null {
  if (!values || values.length === 0) return null
  let k = -1
  let best = Number.NEGATIVE_INFINITY
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    if (v > floorDb && v > best) { best = v; k = i }
  }
  return k < 0 ? null : { k, v: best }
}

export interface MarkerPoint { f: number; v: number }

/** M2 相对 M1 的差值读数；缺一个即 null。 */
export function markerReadout(m1: MarkerPoint | null, m2: MarkerPoint | null): { df: number | null; dv: number | null } {
  if (!m1 || !m2) return { df: null, dv: null }
  return { df: m2.f - m1.f, dv: m2.v - m1.v }
}
