// 序号跟踪（docs/api-versions.md §4.0）：seq = 0 的连接级报文不推进 lastSeq，唯 dropped 令 lastSeq = to。

export type SeqVerdict = 'apply' | 'dup' | 'gap' | 'conn'

export class SeqTracker {
  lastSeq: number
  dropped = 0

  constructor(since: number) { this.lastSeq = since }

  classify(seq: number, type: string, payload: Record<string, unknown> | undefined): SeqVerdict {
    if (seq === 0) {
      if (type === 'dropped' && payload) {
        const to = Number(payload['to'])
        const count = Number(payload['count'])
        if (Number.isFinite(to) && to > this.lastSeq) this.lastSeq = to
        if (Number.isFinite(count)) this.dropped += count
      }
      return 'conn'
    }
    if (seq <= this.lastSeq) return 'dup'
    if (seq === this.lastSeq + 1) { this.lastSeq = seq; return 'apply' }
    return 'gap'
  }

  /** 补取时明知有洞、无法填上：跳过去并返回跳过的区间。 */
  advanceTo(seq: number): { from: number; to: number } | null {
    if (seq <= this.lastSeq) return null
    const hole = { from: this.lastSeq + 1, to: seq - 1 }
    this.lastSeq = seq
    return hole.to >= hole.from ? hole : null
  }
}
