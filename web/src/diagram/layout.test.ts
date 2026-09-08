import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoLayout, depths, COL, ROW, X0, Y0 } from './layout.js'
import { emptyDoc, parse, type DiagramDoc } from './doc.js'
import { EXAMPLES } from './examples/index.js'

const chain: DiagramDoc = {
  ...emptyDoc(),
  nodes: [
    { id: 'a', type: 'T', params: {} }, { id: 'b', type: 'T', params: {} },
    { id: 'c', type: 'T', params: {} }, { id: 'd', type: 'T', params: {} },
  ],
  edges: [
    { from: { node: 'a', port: 'out' }, to: { node: 'c', port: 'in' } },
    { from: { node: 'b', port: 'out' }, to: { node: 'c', port: 'in2' } },
    { from: { node: 'c', port: 'out' }, to: { node: 'd', port: 'in' } },
  ],
}

test('层号 = 从源算起的最长路径', () => {
  const d = depths(chain)
  assert.equal(d.get('a'), 0)
  assert.equal(d.get('b'), 0)
  assert.equal(d.get('c'), 1)
  assert.equal(d.get('d'), 2)
})

test('同层节点纵向排开，不同层横向拉开', () => {
  const out = autoLayout(chain)
  const p = Object.fromEntries(out.nodes.map((n) => [n.id, n.position!]))
  assert.deepEqual(p.a, { x: X0, y: Y0 })
  assert.deepEqual(p.b, { x: X0, y: Y0 + ROW }, '同为源，纵向排开')
  assert.deepEqual(p.c, { x: X0 + COL, y: Y0 })
  assert.deepEqual(p.d, { x: X0 + 2 * COL, y: Y0 })
})

test('已有 position 的节点一律不动（不重排作者的布局）', () => {
  const doc: DiagramDoc = { ...chain, nodes: chain.nodes.map((n) => (n.id === 'a' ? { ...n, position: { x: 999, y: 888 } } : n)) }
  const out = autoLayout(doc)
  assert.deepEqual(out.nodes.find((n) => n.id === 'a')!.position, { x: 999, y: 888 })
  assert.ok(out.nodes.find((n) => n.id === 'b')!.position)
})

test('全都有 position 时返回原对象，不产生多余的重渲染', () => {
  const doc: DiagramDoc = { ...chain, nodes: chain.nodes.map((n, i) => ({ ...n, position: { x: i, y: i } })) }
  assert.equal(autoLayout(doc), doc)
})

test('有环也不死循环', () => {
  const doc: DiagramDoc = {
    ...emptyDoc(),
    nodes: [{ id: 'x', type: 'T', params: {} }, { id: 'y', type: 'T', params: {} }],
    edges: [{ from: { node: 'x', port: 'o' }, to: { node: 'y', port: 'i' } }, { from: { node: 'y', port: 'o' }, to: { node: 'x', port: 'i' } }],
  }
  const out = autoLayout(doc)
  assert.equal(out.nodes.every((n) => !!n.position), true)
})

test('引擎自带的示例框图排完位后互不重叠', () => {
  for (const ex of EXAMPLES) {
    const r = parse(ex.text)
    assert.equal(r.ok, true)
    if (!r.ok) continue
    const out = autoLayout(r.doc)
    const pts = out.nodes.map((n) => `${n.position!.x},${n.position!.y}`)
    assert.equal(new Set(pts).size, pts.length, `${ex.id} 的 ${pts.length} 个节点应各占一处`)
  }
})
