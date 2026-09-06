// 客户端归约（U-3）：与 server/src/products/{spectrum,envelope}.ts 同式同序，同步版、行源抽象为函数。
//
// 跟随模式把环里的行归约到像素列，回看模式画服务端返回的矩阵；两种模式必须画出同样的图，
// 所以这里的公式不是「近似照抄」而是逐行对译，并由 reduce.test.ts 用黄金基准
// tests/golden/product-window.json 守着（铁律 10）。统计量的域（D-046 第 3 条）：
//   max / min 直接比较 dB；mean 在线性功率域 float64 顺序累加 `acc = acc + 10^(v/10)`，
//   最后 10·log10(acc / count)；包络合桶 rms = sqrt(Σ n_j·rms_j² / Σ n_j)。

import {
  CAP_PX,
  CAP_PY,
  MAX_BYTES,
  type EnvelopeGeom,
  type Span,
  type SpectrumGeom,
  type Stat,
  colEdgeHz,
  groupBounds,
  groupCount,
  selectCols,
  selectRows,
} from './viewport.js'

/** 行源：第 i 行（绝对行号）的 Float32 视图。 */
export type RowAt = (i: number) => Float32Array

/** 归约结果：行主序 Float32，rows × cols；t0/t1 相对 t0_s，f0/f1 相对 center_Hz（包络为 null）。 */
export interface Extract {
  data: Float32Array
  rows: number
  cols: number
  t0: number
  t1: number
  f0: number | null
  f1: number | null
}

export interface SpectrumQuery {
  t0: number | null
  t1: number | null
  f0: number | null
  f1: number | null
  px: number | null
  py: number | null
  stat: Stat
}

export interface EnvelopeQuery { t0: number | null; t1: number | null; px: number | null }

export const ENVELOPE_ROW_LEN = 3

export interface SpectrumPlan {
  rowSpan: Span
  colSpan: Span
  rb: number[]
  cb: number[]
  rows: number
  cols: number
  t0: number
  t1: number
  f0: number
  f1: number
}

export function planSpectrum(g: SpectrumGeom, q: SpectrumQuery): SpectrumPlan {
  const rowSpan = selectRows(q.t0, q.t1, g.dt, g.rowsAvail)
  const colSpan = selectCols(q.f0, q.f1, g.bw, g.nfft)
  const nRows = rowSpan.hi - rowSpan.lo
  const nCols = colSpan.hi - colSpan.lo
  const cols = groupCount(nCols, q.px, CAP_PX)
  const capPy = cols > 0 ? Math.max(1, Math.min(CAP_PY, Math.floor(MAX_BYTES / (cols * 4)))) : CAP_PY
  const rows = groupCount(nRows, q.py, capPy)
  return {
    rowSpan,
    colSpan,
    rb: groupBounds(nRows, rows),
    cb: groupBounds(nCols, cols),
    rows,
    cols,
    t0: rowSpan.lo * g.dt,
    t1: rowSpan.hi * g.dt,
    f0: colEdgeHz(colSpan.lo, g.bw, g.nfft),
    f1: colEdgeHz(colSpan.hi, g.bw, g.nfft),
  }
}

/**
 * 单行按列分组归约，写入 out[off .. off + cols)。cb 为相对 colLo 的列分组边界（长度 cols + 1）。
 * 跟随模式逐行调用；与 reduceSpectrum 对单行组的结果逐位相同。
 */
export function reduceSpectrumRow(row: Float32Array, colLo: number, cb: number[], stat: Stat, out: Float32Array, off: number): void {
  const cols = cb.length - 1
  if (stat === 'max') {
    for (let h = 0; h < cols; h++) {
      let acc = Number.NEGATIVE_INFINITY
      for (let k = colLo + cb[h]!; k < colLo + cb[h + 1]!; k++) { const v = row[k]!; if (v > acc) acc = v }
      out[off + h] = acc
    }
  } else if (stat === 'min') {
    for (let h = 0; h < cols; h++) {
      let acc = Number.POSITIVE_INFINITY
      for (let k = colLo + cb[h]!; k < colLo + cb[h + 1]!; k++) { const v = row[k]!; if (v < acc) acc = v }
      out[off + h] = acc
    }
  } else {
    for (let h = 0; h < cols; h++) {
      let acc = 0
      for (let k = colLo + cb[h]!; k < colLo + cb[h + 1]!; k++) acc = acc + Math.pow(10, row[k]! / 10)
      out[off + h] = 10 * Math.log10(acc / (cb[h + 1]! - cb[h]!))
    }
  }
}

/** 按计划归约（同步）。逐行读、行内逐列，累加顺序与服务端一致。 */
export function reduceSpectrum(rowAt: RowAt, g: SpectrumGeom, q: SpectrumQuery): Extract {
  const p = planSpectrum(g, q)
  const out = new Float32Array(p.rows * p.cols)
  if (p.rows === 0 || p.cols === 0) return { data: out, rows: p.rows, cols: p.cols, t0: p.t0, t1: p.t1, f0: p.f0, f1: p.f1 }
  const state = new Float64Array(p.cols)
  const isMax = q.stat === 'max'
  const isMin = q.stat === 'min'
  for (let gi = 0; gi < p.rows; gi++) {
    const ra = p.rowSpan.lo + p.rb[gi]!
    const rbEnd = p.rowSpan.lo + p.rb[gi + 1]!
    state.fill(isMax ? Number.NEGATIVE_INFINITY : isMin ? Number.POSITIVE_INFINITY : 0)
    for (let i = ra; i < rbEnd; i++) {
      const row = rowAt(i)
      for (let h = 0; h < p.cols; h++) {
        const k0 = p.colSpan.lo + p.cb[h]!
        const k1 = p.colSpan.lo + p.cb[h + 1]!
        let acc = state[h]!
        if (isMax) {
          for (let k = k0; k < k1; k++) { const v = row[k]!; if (v > acc) acc = v }
        } else if (isMin) {
          for (let k = k0; k < k1; k++) { const v = row[k]!; if (v < acc) acc = v }
        } else {
          for (let k = k0; k < k1; k++) acc = acc + Math.pow(10, row[k]! / 10)
        }
        state[h] = acc
      }
    }
    const nr = rbEnd - ra
    const off = gi * p.cols
    for (let h = 0; h < p.cols; h++) {
      if (isMax || isMin) out[off + h] = state[h]!
      else out[off + h] = 10 * Math.log10(state[h]! / (nr * (p.cb[h + 1]! - p.cb[h]!)))
    }
  }
  return { data: out, rows: p.rows, cols: p.cols, t0: p.t0, t1: p.t1, f0: p.f0, f1: p.f1 }
}

export interface EnvelopePlan { rowSpan: Span; rb: number[]; rows: number; t0: number; t1: number }

export function planEnvelope(g: EnvelopeGeom, q: EnvelopeQuery): EnvelopePlan {
  const rowSpan = selectRows(q.t0, q.t1, g.dt, g.rowsAvail)
  const nRows = rowSpan.hi - rowSpan.lo
  const cap = Math.max(1, Math.min(CAP_PX, Math.floor(MAX_BYTES / (ENVELOPE_ROW_LEN * 4))))
  const rows = groupCount(nRows, q.px, cap)
  return { rowSpan, rb: groupBounds(nRows, rows), rows, t0: rowSpan.lo * g.dt, t1: rowSpan.hi * g.dt }
}

/** 第 j 桶的样点数：只有已收尾的末桶才可能不满。 */
export function bucketWeight(g: EnvelopeGeom, j: number): number {
  if (g.indexFinal && j === g.rowsAvail - 1 && g.lastBucketSamples > 0) return g.lastBucketSamples
  return g.bucketSamples
}

export function reduceEnvelope(rowAt: RowAt, g: EnvelopeGeom, q: EnvelopeQuery): Extract {
  const p = planEnvelope(g, q)
  const out = new Float32Array(p.rows * ENVELOPE_ROW_LEN)
  if (p.rows === 0) return { data: out, rows: 0, cols: ENVELOPE_ROW_LEN, t0: p.t0, t1: p.t1, f0: null, f1: null }
  for (let gi = 0; gi < p.rows; gi++) {
    const ra = p.rowSpan.lo + p.rb[gi]!
    const rbEnd = p.rowSpan.lo + p.rb[gi + 1]!
    let mn = Number.POSITIVE_INFINITY
    let mx = Number.NEGATIVE_INFINITY
    let acc = 0
    let ntot = 0
    for (let j = ra; j < rbEnd; j++) {
      const row = rowAt(j)
      const a = row[0]!
      const b = row[1]!
      const rms = row[2]!
      if (a < mn) mn = a
      if (b > mx) mx = b
      const n = bucketWeight(g, j)
      acc = acc + n * (rms * rms)
      ntot += n
    }
    const off = gi * ENVELOPE_ROW_LEN
    out[off] = mn
    out[off + 1] = mx
    out[off + 2] = Math.sqrt(acc / ntot)
  }
  return { data: out, rows: p.rows, cols: ENVELOPE_ROW_LEN, t0: p.t0, t1: p.t1, f0: null, f1: null }
}
