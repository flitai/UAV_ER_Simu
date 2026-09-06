// 信号页自己的 Float32 缓冲（09 附录 A.1 的规则：产品数据不进 store）。
// 按 (op_id, kind) 各一个环，拷贝每一行（WS 的 ArrayBuffer 每条报文独立，不能长期持有）。
// 版本号每 rAF 最多加一次，U-3 的画布据此决定是否重画。

import type { RowHeader } from '../api/frames.js'

const CAP: Record<string, number> = { spectrum: 4096, envelope: 65536 }

class Ring {
  readonly rowLen: number
  readonly cap: number
  readonly data: Float32Array
  /** 每个槽位存的 row_index（−1 = 空），丢行斜纹与按行号取行靠它 */
  readonly idx: Int32Array
  rows = 0
  newestRowIndex = -1
  private head = 0
  readonly dropped: Array<{ from: number; to: number }> = []

  constructor(rowLen: number, cap: number) {
    this.rowLen = rowLen
    this.cap = cap
    this.data = new Float32Array(rowLen * cap)
    this.idx = new Int32Array(cap).fill(-1)
  }

  push(rowIndex: number, row: Float32Array): void {
    if (this.newestRowIndex >= 0 && rowIndex > this.newestRowIndex + 1) {
      this.dropped.push({ from: this.newestRowIndex + 1, to: rowIndex - 1 })
    }
    this.data.set(row.subarray(0, this.rowLen), this.head * this.rowLen)
    this.idx[this.head] = rowIndex
    this.head = (this.head + 1) % this.cap
    this.rows = Math.min(this.rows + 1, this.cap)
    this.newestRowIndex = Math.max(this.newestRowIndex, rowIndex)
  }

  /** 第 k 新的一行（k = 0 最新）。 */
  latest(k = 0): Float32Array | null {
    if (k >= this.rows) return null
    const i = (this.head - 1 - k + this.cap) % this.cap
    return this.data.subarray(i * this.rowLen, (i + 1) * this.rowLen)
  }

  /** 第 k 新的一行的 row_index；k 越界给 −1。 */
  rowIndexAt(k: number): number {
    if (k < 0 || k >= this.rows) return -1
    return this.idx[(this.head - 1 - k + this.cap) % this.cap]!
  }

  /** 按 row_index 取行；没收到（丢行或已被环覆盖）给 null。槽位的 row_index 随 k 严格递减，二分查找。 */
  byIndex(rowIndex: number): Float32Array | null {
    if (rowIndex < 0 || rowIndex > this.newestRowIndex) return null
    let lo = 0
    let hi = this.rows - 1
    while (lo <= hi) {
      const k = (lo + hi) >> 1
      const i = (this.head - 1 - k + this.cap) % this.cap
      const r = this.idx[i]!
      if (r === rowIndex) return this.data.subarray(i * this.rowLen, (i + 1) * this.rowLen)
      if (r > rowIndex) lo = k + 1
      else hi = k - 1
    }
    return null
  }
}

export class SignalBuffer {
  taskId: string | null = null
  version = 0
  private rings = new Map<string, Ring>()
  private subs = new Set<() => void>()
  private bump = false

  reset(taskId: string | null): void {
    this.taskId = taskId
    this.rings.clear()
    this.touch()
  }

  push(h: RowHeader, row: Float32Array): void {
    if (this.taskId && h.task_id !== this.taskId) return
    const key = `${h.op_id}/${h.kind}`
    let r = this.rings.get(key)
    if (!r || r.rowLen !== h.row_len) {
      r = new Ring(h.row_len, CAP[h.kind] ?? 1024)
      this.rings.set(key, r)
    }
    r.push(h.row_index, row)
    this.touch()
  }

  rows(op: string | null, kind: string): number { return (op && this.rings.get(`${op}/${kind}`)?.rows) || 0 }
  cols(op: string | null, kind: string): number { return (op && this.rings.get(`${op}/${kind}`)?.rowLen) || 0 }
  latestRow(op: string | null, kind: string, k = 0): Float32Array | null { return op ? this.rings.get(`${op}/${kind}`)?.latest(k) ?? null : null }
  newestRowIndex(op: string | null, kind: string): number { return op ? this.rings.get(`${op}/${kind}`)?.newestRowIndex ?? -1 : -1 }
  droppedRanges(op: string | null, kind: string): Array<{ from: number; to: number }> { return op ? this.rings.get(`${op}/${kind}`)?.dropped ?? [] : [] }
  rowIndexAt(op: string | null, kind: string, k: number): number { return op ? this.rings.get(`${op}/${kind}`)?.rowIndexAt(k) ?? -1 : -1 }
  rowByIndex(op: string | null, kind: string, rowIndex: number): Float32Array | null { return op ? this.rings.get(`${op}/${kind}`)?.byIndex(rowIndex) ?? null : null }
  /** 环的容量（行）；没有该环给 0。 */
  capacity(op: string | null, kind: string): number { return (op && this.rings.get(`${op}/${kind}`)?.cap) || 0 }

  subscribe(f: () => void): () => void { this.subs.add(f); return () => { this.subs.delete(f) } }

  private touch(): void {
    if (this.bump) return
    this.bump = true
    const fire = () => { this.bump = false; this.version += 1; for (const f of this.subs) f() }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fire)
    else fire()
  }
}

export function peakBinOf(row: Float32Array | null): number | null {
  if (!row || row.length === 0) return null
  let k = 0
  for (let i = 1; i < row.length; i++) if (row[i]! > row[k]!) k = i
  return k
}

export const signalBuffer = new SignalBuffer()
