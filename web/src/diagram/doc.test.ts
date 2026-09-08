// 文档模型与规范序列化的单测（09 §6.10）。
// 关键判据：往返稳定 + 与引擎自带的示例框图字段等价（序列化与 golden 等价，06 §9B U-2 验收条）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { serialize, parse, nextId, renameNode, removeNode, pruneEdges, stripDefaults, missingRequired, emptyDoc, type DiagramDoc } from './doc.js'
import { EXAMPLES } from './examples/index.js'
import type { Catalog } from '../api/catalog.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const engineDiagram = (n: string) => readFileSync(join(ROOT, 'engine/tests/diagrams', n), 'utf8')

test('往返稳定：serialize(parse(x)) 是幂等的', () => {
  for (const ex of EXAMPLES) {
    const r = parse(ex.text)
    assert.equal(r.ok, true, `${ex.id} 应能解析`)
    if (!r.ok) continue
    const once = serialize(r.doc)
    const twice = serialize((parse(once) as { ok: true; doc: DiagramDoc }).doc)
    assert.equal(twice, once, `${ex.id} 两次序列化应逐字节相同`)
  }
})

test('与引擎自带的示例框图字段等价（前端示例就是它的副本）', () => {
  const pairs: Array<[string, string]> = [
    ['slice1', 'slice1_tone_noise_psd.json'],
    ['slice2', 'slice2_scenario_link.json'],
  ]
  for (const [id, file] of pairs) {
    const ex = EXAMPLES.find((e) => e.id === id)
    assert.ok(ex, `示例 ${id} 应存在`)
    const a = parse(ex!.text), b = parse(engineDiagram(file))
    assert.equal(a.ok && b.ok, true)
    if (!a.ok || !b.ok) continue
    // 逐字段比对：两侧各自规范序列化后应完全相同
    assert.equal(serialize(a.doc), serialize(b.doc), `${id} 与 ${file} 应字段等价`)
  }
})

test('连线字段是嵌套的 {node, port}，不是扁平的 from_port（对着真文件断言）', () => {
  const r = parse(engineDiagram('slice2_scenario_link.json'))
  assert.equal(r.ok, true)
  if (!r.ok) return
  for (const e of r.doc.edges) {
    assert.equal(typeof e.from, 'object', 'from 必须是对象')
    assert.equal(typeof e.from.node, 'string')
    assert.equal(typeof e.from.port, 'string')
    assert.equal(typeof e.to.node, 'string')
    assert.equal((e as unknown as Record<string, unknown>).from_port, undefined, '不存在扁平字段')
  }
  // 序列化后仍是嵌套结构，且能被再次读回
  const again = parse(serialize(r.doc))
  assert.equal(again.ok, true)
  if (!again.ok) return
  assert.deepEqual(again.doc.edges, r.doc.edges)
})

test('观测点带 params 时不丢（示例的 nfft / window / 桶长）', () => {
  const r = parse(engineDiagram('slice2_scenario_link.json'))
  assert.equal(r.ok, true)
  if (!r.ok) return
  const op = r.doc.observation_points![0]!
  assert.equal(op.params?.nfft, 4096)
  const back = parse(serialize(r.doc))
  assert.equal((back as { ok: true; doc: typeof r.doc }).doc.observation_points![0]!.params?.nfft, 4096)
})

test('键序固定：打乱输入键序，序列化结果不变', () => {
  const a = parse(EXAMPLES[0]!.text)
  assert.equal(a.ok, true)
  if (!a.ok) return
  const shuffled = JSON.parse(JSON.stringify(a.doc)) as DiagramDoc
  const reordered: Record<string, unknown> = {}
  for (const k of Object.keys(shuffled).reverse()) reordered[k] = (shuffled as unknown as Record<string, unknown>)[k]
  const b = parse(JSON.stringify(reordered))
  assert.equal(b.ok, true)
  if (!b.ok) return
  assert.equal(serialize(b.doc), serialize(a.doc))
})

test('规范形式以换行结尾，缩进两空格', () => {
  const t = serialize(emptyDoc('x'))
  assert.ok(t.endsWith('}\n'))
  assert.ok(t.includes('\n  "diagram_id": "x"'))
})

const cat = {
  schema_version: 'cuav-catalog/1', engine_version: '0', port_types: [], port_compat: [],
  components: [{
    type: 'T', display_name: 'T', category: 'source', model_id: 'T', model_layer: 'M3', model_level: 'E2', version: '0',
    ports: {}, params: [
      { name: 'a', type: 'number', default: 5 },
      { name: 'b', type: 'number', required: true },
      { name: 'c', type: 'number', default: 1 },
    ],
  }],
} as unknown as Catalog

test('缺省值不写入，非缺省值保留', () => {
  const doc: DiagramDoc = { ...emptyDoc(), nodes: [{ id: 'n', type: 'T', params: { a: 5, b: 7, c: 2 } }] }
  const out = stripDefaults(doc, cat)
  assert.deepEqual(out.nodes[0]!.params, { b: 7, c: 2 }, 'a 等于缺省应删，b 无缺省应留，c 与缺省不同应留')
})

test('目录里没有的组件，参数原样保留（无从判断是不是缺省）', () => {
  const doc: DiagramDoc = { ...emptyDoc(), nodes: [{ id: 'n', type: '不在目录里', params: { a: 5 } }] }
  assert.deepEqual(stripDefaults(doc, cat).nodes[0]!.params, { a: 5 })
})

test('必填且无缺省的参数被标为待填', () => {
  assert.deepEqual(missingRequired(cat.components[0]!, {}), ['b'])
  assert.deepEqual(missingRequired(cat.components[0]!, { b: 1 }), [])
})

test('新 id 不与既有冲突', () => {
  assert.equal(nextId('tone', []), 'tone')
  assert.equal(nextId('tone', ['tone']), 'tone-2')
  assert.equal(nextId('tone', ['tone', 'tone-2']), 'tone-3')
  assert.equal(nextId('ToneSource', []), 'tonesource', '大写与非法字符要规整成 [a-z0-9_-]')
})

test('改名同步更新连线与观测点的引用', () => {
  const doc: DiagramDoc = {
    ...emptyDoc(),
    nodes: [{ id: 'a', type: 'T', params: {} }, { id: 'b', type: 'T', params: {} }],
    edges: [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }],
    observation_points: [{ id: 's4', node: 'a', port: 'out', products: ['spectrum'] }],
  }
  const r = renameNode(doc, 'a', 'z')
  assert.equal(r.edges[0]!.from.node, 'z')
  assert.equal(r.observation_points![0]!.node, 'z')
})

test('删节点连带删掉它的连线与观测点，不留悬空引用', () => {
  const doc: DiagramDoc = {
    ...emptyDoc(),
    nodes: [{ id: 'a', type: 'T', params: {} }, { id: 'b', type: 'T', params: {} }],
    edges: [{ from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }],
    observation_points: [{ id: 's4', node: 'a', port: 'out', products: ['spectrum'] }],
  }
  const r = removeNode(doc, 'a')
  assert.deepEqual(r.nodes.map((n) => n.id), ['b'])
  assert.equal(r.edges.length, 0)
  assert.equal(r.observation_points!.length, 0)
})

test('场景绑定改变后，端口消失的连线被剪掉并报出', () => {
  const doc: DiagramDoc = {
    ...emptyDoc(),
    nodes: [{ id: 'scn', type: 'S', params: {} }, { id: 'ch', type: 'C', params: {} }],
    edges: [{ from: { node: 'scn', port: 'link:uav-1' }, to: { node: 'ch', port: 'scene' } }],
  }
  const after = pruneEdges(doc, (id) => (id === 'scn' ? { in: [], out: ['link:uav-2'] } : { in: ['scene'], out: [] }))
  assert.equal(after.removed.length, 1, '辐射源换了，link:uav-1 不再存在')
  assert.equal(after.doc.edges.length, 0)
  const same = pruneEdges(doc, (id) => (id === 'scn' ? { in: [], out: ['link:uav-1'] } : { in: ['scene'], out: [] }))
  assert.equal(same.removed.length, 0)
  assert.equal(same.doc, doc, '没有变化时应返回原对象')
})

test('template_ref 在键序里排在 run 之后 trace 之前，且往返不丢（D-051）', () => {
  const doc: DiagramDoc = {
    ...emptyDoc('chain-synthetic'),
    template_ref: { template_id: 'chain-v1', mode: 'synthetic', version: 1 },
    trace: { created_by: 'tester' },
  }
  const text = serialize(doc)
  const keys = Object.keys(JSON.parse(text) as Record<string, unknown>)
  assert.ok(keys.indexOf('template_ref') > keys.indexOf('run'), 'template_ref 应在 run 之后')
  assert.ok(keys.indexOf('template_ref') < keys.indexOf('trace'), 'template_ref 应在 trace 之前')
  const back = parse(text)
  assert.equal(back.ok, true)
  if (!back.ok) return
  assert.deepEqual(back.doc.template_ref, { template_id: 'chain-v1', mode: 'synthetic', version: 1 })
  assert.equal(serialize(back.doc), text, '往返逐字节相同')
})

test('没有 template_ref 的框图序列化后不出现该键（自由画布存的框图）', () => {
  const text = serialize(emptyDoc('freeform'))
  assert.ok(!text.includes('template_ref'))
})
