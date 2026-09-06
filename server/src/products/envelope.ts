// 包络产品的视窗归约（06 备忘录 §9A B-7；docs/display-products.md §3；决策 D-046）。
//
// 输入是 <op_id>/envelope.f32：每行 3 个 float32 [min_abs, max_abs, rms_abs]，桶内 |x| 的最小、最大、
// 均方根，线性、相对满量程；桶 j 的起始时刻 = t0_s + j·bucket_samples / Fs。
//
// 合桶（D-046 第 3 条）：min 取最小、max 取最大、rms 取**按样点数加权的均方根**
//   sqrt( Σ n_j·rms_j² / Σ n_j )，n_j = bucket_samples，
// 仅当索引已收尾（rows == 文件行数）且 j 是最后一行时取 last_bucket_samples——
// 运行中索引每 64 行才刷新，那时 last_bucket_samples 恰等于 bucket_samples，规则在任何时刻都成立。
// `acc = acc + n_j·(r·r)` 的结合顺序是逐位复现的前提，Python 参考必须照写，不得改写。
//
// 包络没有 stat 参数（三列语义固定），也没有频率维度。

import { CAP_PX, MAX_BYTES, type RowSource, type Span, chunkRows, groupBounds, groupCount, selectRows } from './window.js'
import type { Extract } from './spectrum.js'

/** 包络行恒为三列 [min_abs, max_abs, rms_abs]。 */
export const ENVELOPE_ROW_LEN = 3

export interface EnvelopeQuery {
  t0: number | null
  t1: number | null
  /** 目标行数（时间方向）；沿用规范里的 px 参数名 */
  px: number | null
}

export interface EnvelopeGeom {
  /** 相邻两桶的时间间隔 = bucket_samples / sample_rate_Hz */
  dt: number
  rowsAvail: number
  bucketSamples: number
  lastBucketSamples: number
  /** 索引是否已收尾（rows == 文件行数）；未收尾时末桶按满桶计权 */
  indexFinal: boolean
}

export interface EnvelopePlan {
  rowSpan: Span
  rb: number[]
  rows: number
  cols: 3
  bytes: number
  t0: number
  t1: number
}

export function planEnvelope(g: EnvelopeGeom, q: EnvelopeQuery): EnvelopePlan {
  const rowSpan = selectRows(q.t0, q.t1, g.dt, g.rowsAvail)
  const nRows = rowSpan.hi - rowSpan.lo
  const cap = Math.max(1, Math.min(CAP_PX, Math.floor(MAX_BYTES / (ENVELOPE_ROW_LEN * 4))))
  const rows = groupCount(nRows, q.px, cap)
  return {
    rowSpan,
    rb: groupBounds(nRows, rows),
    rows,
    cols: ENVELOPE_ROW_LEN,
    bytes: rows * ENVELOPE_ROW_LEN * 4,
    t0: rowSpan.lo * g.dt,
    t1: rowSpan.hi * g.dt,
  }
}

/** 第 j 桶的样点数：只有已收尾的末桶才可能不满。 */
export function bucketWeight(g: EnvelopeGeom, j: number): number {
  if (g.indexFinal && j === g.rowsAvail - 1 && g.lastBucketSamples > 0) return g.lastBucketSamples
  return g.bucketSamples
}

export async function extractEnvelope(src: RowSource, g: EnvelopeGeom, q: EnvelopeQuery): Promise<Extract> {
  const p = planEnvelope(g, q)
  const out = new Float32Array(p.rows * ENVELOPE_ROW_LEN)
  if (p.rows === 0) {
    return { data: out, rows: 0, cols: ENVELOPE_ROW_LEN, t0: p.t0, t1: p.t1, f0: null, f1: null }
  }
  const step = chunkRows(ENVELOPE_ROW_LEN)
  for (let gi = 0; gi < p.rows; gi++) {
    const ra = p.rowSpan.lo + p.rb[gi]
    const rbEnd = p.rowSpan.lo + p.rb[gi + 1]
    let mn = Number.POSITIVE_INFINITY
    let mx = Number.NEGATIVE_INFINITY
    let acc = 0
    let ntot = 0
    for (let j = ra; j < rbEnd; j += step) {
      const count = Math.min(step, rbEnd - j)
      const blk = await src.read(j, count)
      for (let r = 0; r < count; r++) {
        const base = r * ENVELOPE_ROW_LEN
        const a = blk[base]
        const b = blk[base + 1]
        const rms = blk[base + 2]
        if (a < mn) mn = a
        if (b > mx) mx = b
        const n = bucketWeight(g, j + r)
        acc = acc + n * (rms * rms)
        ntot += n
      }
    }
    const off = gi * ENVELOPE_ROW_LEN
    out[off] = mn
    out[off + 1] = mx
    out[off + 2] = Math.sqrt(acc / ntot)
  }
  return { data: out, rows: p.rows, cols: ENVELOPE_ROW_LEN, t0: p.t0, t1: p.t1, f0: null, f1: null }
}
