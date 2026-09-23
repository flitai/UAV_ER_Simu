// 运行说明怎么分层：要紧的（导致降级 / 无效的节点）与例行的（正常节点的说明）。
//
// 由来（用户 2026-09-22）：引擎每次运行会给七八条说明，其中通常只有一两条是真问题，
// 其余是每次都有的收尾（末尾样点不足一帧、结束时丢弃不满一段）。
// 此前两处界面都是「结果降级就整段标红」，于是红色只剩「这里有字」的意思。
//
// 分层照**引擎给的逐节点四态**，不猜关键词——引擎本来就分得清
// （golden-01 缺省链 15 个节点里只有 adc 是 degraded），此前是服务端把它压扁成
// 扁平的 reasons 数组、前端又只读了那个数组，信息丢在半路。
//
// 这个文件只有纯函数，顶栏的任务详情与结果页左栏共用，免得两处各分各的又分出两个样子。

import type { AppState } from '../state/types.js'

export interface NoteGroup {
  node: string
  /** 该节点的四态；扁平退路下为 null（不知道，也就不装作知道） */
  state: string | null
  lines: string[]
}

/** 把 `节点名：说明` 按节点分组；分不出前缀的归「其他」。顺序保持引擎给的顺序。 */
export function groupReasons(reasons: string[]): Array<{ node: string; lines: string[] }> {
  const out: Array<{ node: string; lines: string[] }> = []
  for (const r of reasons) {
    const i = r.indexOf('：')
    const node = i > 0 ? r.slice(0, i) : '其他'
    const line = i > 0 ? r.slice(i + 1) : r
    const last = out[out.length - 1]
    if (last && last.node === node) last.lines.push(line)
    else out.push({ node, lines: [line] })
  }
  return out
}

/**
 * 分成「要紧的」与「例行的」两段。
 * 有逐节点状态就按状态分；没有（旧任务的 task.json 没这一份）就全部归例行、状态标 null——
 * **不知道就不装作知道**，那时一条也不标红，至少不会把例行的猜成问题。
 */
export function splitNotes(
  nodes: AppState['task']['nodes'],
  reasons: string[],
): { alerts: NoteGroup[]; routine: NoteGroup[] } {
  if (nodes.length > 0) {
    const alerts: NoteGroup[] = []
    const routine: NoteGroup[] = []
    for (const n of nodes) {
      if (n.notes.length === 0) continue
      const g: NoteGroup = { node: n.name, state: n.state, lines: n.notes }
      ;(n.state === 'valid' ? routine : alerts).push(g)
    }
    return { alerts, routine }
  }
  return { alerts: [], routine: groupReasons(reasons).map((g) => ({ ...g, state: null })) }
}

/** 两段各有多少条说明（标题里写条数用）。 */
export function countLines(groups: NoteGroup[]): number {
  return groups.reduce((n, g) => n + g.lines.length, 0)
}
