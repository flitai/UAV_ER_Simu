// 无位置节点的初始布局（09 §6.4）。
//
// 09 §6.4 说「不做自动布局」，指的是**不重排作者已经摆好的节点**——框图的空间安排携带作者意图。
// 但框图文件里 `position` 是可选的（docs/diagram-format.md §3），手写或引擎自带的示例都没有它，
// 此时必须给一个初始位置，否则全部堆在同一点。本模块只给**没有 position 的节点**排位，
// 已有 position 的一律不动。
//
// 排法是按拓扑深度分层：深度 = 从源节点算起的最长路径。这正好是信号链的阅读顺序
// （源 → 信道 → 分析 → 观测点），列内按出现次序纵向排开。

import type { DiagramDoc, DiagramNode } from './doc.js'

export const COL = 260
export const ROW = 130
export const X0 = 40
export const Y0 = 40

/** 每个节点的层号。有环时不死循环：迭代次数封顶，剩下的留在当前层。 */
export function depths(doc: DiagramDoc): Map<string, number> {
  const d = new Map<string, number>()
  for (const n of doc.nodes) d.set(n.id, 0)
  const preds = new Map<string, string[]>()
  for (const e of doc.edges) preds.set(e.to.node, [...(preds.get(e.to.node) ?? []), e.from.node])
  for (let pass = 0; pass < doc.nodes.length + 1; pass++) {
    let moved = false
    for (const n of doc.nodes) {
      const ps = preds.get(n.id) ?? []
      if (ps.length === 0) continue
      const want = Math.max(...ps.map((p) => (d.get(p) ?? 0) + 1))
      if (want > (d.get(n.id) ?? 0)) { d.set(n.id, want); moved = true }
    }
    if (!moved) break
  }
  return d
}

/** 给没有 position 的节点排位；已有 position 的原样返回。文档没有变化时返回原对象。 */
export function autoLayout(doc: DiagramDoc): DiagramDoc {
  const missing = doc.nodes.filter((n) => !n.position)
  if (missing.length === 0) return doc
  const d = depths(doc)
  const seen = new Map<number, number>()
  const placed = new Map<string, { x: number; y: number }>()
  for (const n of doc.nodes) {
    if (n.position) continue
    const col = d.get(n.id) ?? 0
    const row = seen.get(col) ?? 0
    seen.set(col, row + 1)
    placed.set(n.id, { x: X0 + col * COL, y: Y0 + row * ROW })
  }
  const nodes: DiagramNode[] = doc.nodes.map((n) => (placed.has(n.id) ? { ...n, position: placed.get(n.id)! } : n))
  return { ...doc, nodes }
}
