// 视窗抽取的纯函数：行列选择、分组边界、行源抽象（06 备忘录 §9A B-7；docs/display-products.md §3；决策 D-046）。
//
// 这一层不碰文件、不碰 HTTP，只做整数运算，因此可以逐行对译成 Python 参考实现
// （algos/reference/product_window.py），两侧对同一产品文件的归约必须逐值一致（B-7 验收条件）。
//
// 三条约定（D-046）：
//   1. 区间一律半开 [lo, hi)；时间按行起始时刻，频率按 bin 中心 ± 半格。
//   2. 分组边界 B[g] = floor(g·n/m)，纯整数运算，与浮点无关，两种语言必然相同。
//   3. 目标像素数超过原始行列数时**不插值**，只返回原始数（docs/display-products.md §3 规则 1）。

/** 半开区间 [lo, hi)。 */
export interface Span {
  lo: number
  hi: number
}

/** 单次响应上限（docs/display-products.md §3 规则 2）。 */
export const MAX_BYTES = 16 * 1024 * 1024
/** 时间方向（行）缺省上限 */
export const CAP_PY = 2048
/** 频率方向（列）缺省上限 */
export const CAP_PX = 4096
/** 读盘分块上限：一次 read 的字节数，与输出大小无关 */
export const CHUNK_BYTES = 4 * 1024 * 1024

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * 时间窗 → 行区间。`dt` = 相邻两行的时间间隔（谱为 frame_hop_samples / Fs，包络为 bucket_samples / Fs）。
 * `t0` / `t1` 相对索引里的 `t0_s`，为 null 表示不限。窗口整体落在数据之外时返回空区间（lo == hi）。
 */
export function selectRows(t0: number | null, t1: number | null, dt: number, rowsAvail: number): Span {
  const n = Math.max(0, Math.floor(rowsAvail))
  if (!(dt > 0)) return { lo: 0, hi: n } // 采样率异常时不做时间裁剪，交由上层报索引不合法
  const lo = t0 === null ? 0 : clamp(Math.floor(t0 / dt), 0, n)
  const hi = t1 === null ? n : clamp(Math.ceil(t1 / dt), 0, n)
  return { lo, hi: Math.max(lo, hi) }
}

/**
 * 频段 → 列区间。列 k 的中心频率是 `center_Hz + (k − half)·bw`（fftshift 后列 0 = −Fs/2），
 * 覆盖 `[(k − half − 0.5)·bw, (k − half + 0.5)·bw)`；`half = floor(nfft / 2)` 对奇偶 nfft 通用。
 * `f0` / `f1` 相对 `center_Hz`，为 null 表示全带。
 */
export function selectCols(f0: number | null, f1: number | null, bw: number, nfft: number): Span {
  const n = Math.max(0, Math.floor(nfft))
  if (!(bw > 0)) return { lo: 0, hi: n }
  const half = Math.floor(n / 2)
  const u = (f: number) => f / bw + half + 0.5
  const lo = f0 === null ? 0 : clamp(Math.floor(u(f0)), 0, n)
  const hi = f1 === null ? n : clamp(Math.ceil(u(f1)), 0, n)
  return { lo, hi: Math.max(lo, hi) }
}

/** 列 c 的低频边界（相对 center_Hz）。列区间 [c0, c1) 的频率范围即 colEdgeHz(c0) 到 colEdgeHz(c1)。 */
export function colEdgeHz(c: number, bw: number, nfft: number): number {
  return (c - Math.floor(nfft / 2) - 0.5) * bw
}

/**
 * n 个输入项分成 m 组的边界，长度 m + 1，B[0] = 0、B[m] = n。
 * m ≤ n 时每组至少一项；m = 0（没有输入项）时返回 [0]。
 */
export function groupBounds(n: number, m: number): number[] {
  if (m <= 0) return [0]
  const out = new Array<number>(m + 1)
  for (let g = 0; g <= m; g++) out[g] = Math.floor((g * n) / m)
  return out
}

/**
 * 输出组数：目标为 null 时取 min(n, cap)，否则取 min(目标, n)——**目标大于原始数不插值**。
 * n = 0 时返回 0（空窗）。
 */
export function groupCount(n: number, target: number | null, cap: number): number {
  if (n <= 0) return 0
  const want = target === null ? Math.min(n, Math.max(1, cap)) : Math.min(Math.floor(target), n)
  return Math.max(1, want)
}

/** 按行读取定长产品的抽象。read() 返回 count 行连续数据（count × rowLen 个 float32）。 */
export interface RowSource {
  readonly rows: number
  readonly rowLen: number
  read(row0: number, count: number): Promise<Float32Array>
}

/** 内存行源：黄金基准与单元测试用，与文件行源必须给出完全相同的结果。 */
export class MemoryRowSource implements RowSource {
  readonly rows: number
  constructor(
    private readonly data: Float32Array,
    readonly rowLen: number,
  ) {
    this.rows = Math.floor(data.length / rowLen)
  }

  read(row0: number, count: number): Promise<Float32Array> {
    const off = row0 * this.rowLen
    return Promise.resolve(this.data.subarray(off, off + count * this.rowLen))
  }
}

/** 一次读盘的最大行数（至少 1 行，避免 rowLen 极大时死循环）。 */
export function chunkRows(rowLen: number, chunkBytes = CHUNK_BYTES): number {
  return Math.max(1, Math.floor(chunkBytes / (rowLen * 4)))
}
