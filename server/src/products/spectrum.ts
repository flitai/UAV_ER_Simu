// 谱产品的视窗归约（06 备忘录 §9A B-7；docs/display-products.md §3；决策 D-046）。
//
// 输入是 <op_id>/spectrum.f32：每行 nfft 个 float32，值为 10·log10(功率) 的 dBFS，
// 列 k 的中心频率 = center_Hz + (k − floor(nfft/2))·bin_width_Hz（引擎已 fftshift，列 0 = −Fs/2），
// 行 i 的起始时刻 = t0_s + i·frame_hop_samples / Fs。
//
// 统计量（D-046 第 3 条）：
//   max / min 直接对 dB 值取——比较运算不引入舍入，两种语言逐位相同；
//   mean 在**线性功率域**聚合（铁律 5：dB 域与线性域不混算，功率聚合在线性域）：
//     10·log10( Σ 10^(v/10) / count )，float64 按**行主序顺序累加**，最后转 float32。
//   累加顺序是逐位复现的前提，algos/reference/product_window.py 必须用同样的循环嵌套，
//   **不得**改写成向量化或补偿求和（CPython 的 sum() 与 numpy 的 sum 都不是顺序累加）。
//
// 谱的 mean 对行不加权：末行段数不足是流结束的自然结果，不影响该行的值本身。

import {
  CAP_PX,
  CAP_PY,
  MAX_BYTES,
  type RowSource,
  type Span,
  chunkRows,
  colEdgeHz,
  groupBounds,
  groupCount,
  selectCols,
  selectRows,
} from './window.js'

export type Stat = 'max' | 'mean' | 'min'
export const STATS: ReadonlySet<string> = new Set(['max', 'mean', 'min'])

export interface SpectrumQuery {
  /** 秒，相对索引里的 t0_s；null = 不限 */
  t0: number | null
  t1: number | null
  /** Hz，相对 center_Hz；null = 全带 */
  f0: number | null
  f1: number | null
  /** 目标列数（频率方向）与行数（时间方向）；null = 缺省 */
  px: number | null
  py: number | null
  stat: Stat
}

export interface SpectrumGeom {
  /** 相邻两行的时间间隔 = frame_hop_samples / sample_rate_Hz */
  dt: number
  /** bin_width_Hz */
  bw: number
  nfft: number
  /** 以文件长度为准的行数（不是索引里的 rows） */
  rowsAvail: number
}

/** 抽取结果：行主序 Float32，rows × cols。 */
export interface Extract {
  data: Float32Array
  rows: number
  cols: number
  /** 实际覆盖的时间范围（秒，相对 t0_s） */
  t0: number
  t1: number
  /** 实际覆盖的频率范围（Hz，相对 center_Hz）；包络为 null */
  f0: number | null
  f1: number | null
}

export interface SpectrumPlan {
  rowSpan: Span
  colSpan: Span
  /** 行分组边界（相对 rowSpan.lo），长度 rows + 1 */
  rb: number[]
  /** 列分组边界（相对 colSpan.lo），长度 cols + 1 */
  cb: number[]
  rows: number
  cols: number
  bytes: number
  t0: number
  t1: number
  f0: number
  f1: number
}

/**
 * 只做选择与分组，不读盘。HEAD 与 413 判定都到这一步为止。
 * 缺省 py 另受「不超过单次响应上限」约束，使不带参数的请求永远不会 413。
 */
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
    bytes: rows * cols * 4,
    t0: rowSpan.lo * g.dt,
    t1: rowSpan.hi * g.dt,
    f0: colEdgeHz(colSpan.lo, g.bw, g.nfft),
    f1: colEdgeHz(colSpan.hi, g.bw, g.nfft),
  }
}

/** 按计划归约。逐个输出行组读盘，读块不超过 CHUNK_BYTES，不把整个文件读进内存。 */
export async function extractSpectrum(src: RowSource, g: SpectrumGeom, q: SpectrumQuery): Promise<Extract> {
  const p = planSpectrum(g, q)
  const out = new Float32Array(p.rows * p.cols)
  if (p.rows === 0 || p.cols === 0) {
    return { data: out, rows: p.rows, cols: p.cols, t0: p.t0, t1: p.t1, f0: p.f0, f1: p.f1 }
  }
  const rowLen = src.rowLen
  const step = chunkRows(rowLen)
  const state = new Float64Array(p.cols)
  const isMax = q.stat === 'max'
  const isMin = q.stat === 'min'

  for (let gi = 0; gi < p.rows; gi++) {
    const ra = p.rowSpan.lo + p.rb[gi]
    const rbEnd = p.rowSpan.lo + p.rb[gi + 1]
    state.fill(isMax ? Number.NEGATIVE_INFINITY : isMin ? Number.POSITIVE_INFINITY : 0)
    for (let i = ra; i < rbEnd; i += step) {
      const count = Math.min(step, rbEnd - i)
      const blk = await src.read(i, count)
      for (let r = 0; r < count; r++) {
        const base = r * rowLen
        for (let h = 0; h < p.cols; h++) {
          const k0 = p.colSpan.lo + p.cb[h]
          const k1 = p.colSpan.lo + p.cb[h + 1]
          if (isMax) {
            let acc = state[h]
            for (let k = k0; k < k1; k++) {
              const v = blk[base + k]
              if (v > acc) acc = v
            }
            state[h] = acc
          } else if (isMin) {
            let acc = state[h]
            for (let k = k0; k < k1; k++) {
              const v = blk[base + k]
              if (v < acc) acc = v
            }
            state[h] = acc
          } else {
            let acc = state[h]
            for (let k = k0; k < k1; k++) acc = acc + Math.pow(10, blk[base + k] / 10)
            state[h] = acc
          }
        }
      }
    }
    const nr = rbEnd - ra
    const off = gi * p.cols
    for (let h = 0; h < p.cols; h++) {
      if (isMax || isMin) {
        out[off + h] = state[h]
      } else {
        const cnt = nr * (p.cb[h + 1] - p.cb[h])
        out[off + h] = 10 * Math.log10(state[h] / cnt)
      }
    }
  }
  return { data: out, rows: p.rows, cols: p.cols, t0: p.t0, t1: p.t1, f0: p.f0, f1: p.f1 }
}
