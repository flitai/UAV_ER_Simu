// 框图文档模型与规范序列化（09 §6.10，docs/diagram-format.md）。
//
// 画布的真相是这个文档，不是 JSON 文本；文本是它的投影（源码页签）。
// 序列化两条硬要求：**键序固定**、**缺省值不写入**。
//   键序固定 → 同一张框图两次保存字节相同，git 里看得出真实改动；
//   缺省值不写 → 目录缺省值变更时既有框图自动跟随（docs/diagram-format.md §3）。

import type { Catalog, ParamSpec } from '../api/catalog.js'
import { findComponent } from '../api/catalog.js'

export type ParamValue = number | string | boolean

export interface SceneBinding { scenario_id: string; entity_id?: string; site_id?: string }

export interface DiagramNode {
  id: string
  type: string
  label?: string
  params: Record<string, ParamValue>
  position?: { x: number; y: number }
  scene_binding?: SceneBinding
}

/** 连线。字段是**嵌套的** `{node, port}`，不是扁平的 from/from_port（docs/diagram-format.md §4）。 */
export interface EdgeEnd { node: string; port: string }
export interface DiagramEdge { id?: string; from: EdgeEnd; to: EdgeEnd }

export interface ObservationPoint {
  id: string
  node: string
  port: string
  products: string[]
  label?: string
  params?: Record<string, ParamValue>
}

export interface RunSpec {
  duration_s: number
  seed?: number
  block_size?: number
  [k: string]: ParamValue | undefined
}

export interface DiagramDoc {
  schema_version: string
  diagram_id: string
  name: string
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  observation_points?: ObservationPoint[]
  run: RunSpec
  scenario_ref?: { scenario_id: string; sha256: string }
  /** 典型链路视图的还原线索（D-051）。引擎只校验取值，不解释语义；自由画布存的框图没有这一段。 */
  template_ref?: TemplateRef
  trace?: Record<string, unknown>
}

export type ChainMode = 'synthetic' | 'replay' | 'mixed'
export interface TemplateRef { template_id: string; mode: ChainMode; version: number }

export const SCHEMA_VERSION = 'cuav-diagram/1'

export function emptyDoc(id = 'untitled'): DiagramDoc {
  return { schema_version: SCHEMA_VERSION, diagram_id: id, name: '未命名框图', nodes: [], edges: [], run: { duration_s: 1 } }
}

/** 顶层键序，取 docs/diagram-format.md §2 的表序。 */
const TOP_ORDER = ['schema_version', 'diagram_id', 'name', 'scenario_ref', 'nodes', 'edges', 'observation_points', 'run', 'template_ref', 'trace'] as const
/** 节点键序，取 §3 的表序。 */
const NODE_ORDER = ['id', 'type', 'label', 'scene_binding', 'params', 'position'] as const
const EDGE_ORDER = ['id', 'from', 'to'] as const
const OP_ORDER = ['id', 'label', 'node', 'port', 'products', 'params'] as const

function pick<T extends object>(o: T, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of order) {
    const v = (o as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  // 表序之外的键按名排序补在后面，保证「未知键不丢」且仍确定
  for (const k of Object.keys(o).sort()) {
    if (!order.includes(k) && (o as Record<string, unknown>)[k] !== undefined) out[k] = (o as Record<string, unknown>)[k]
  }
  return out
}

/**
 * 剔除与目录缺省值相同的参数。目录里查不到的组件或参数一律保留原样，
 * 因为此时无从判断它是不是缺省值，删掉会丢信息。
 */
export function stripDefaults(doc: DiagramDoc, cat: Catalog | null): DiagramDoc {
  if (!cat) return doc
  const nodes = doc.nodes.map((n) => {
    const spec = findComponent(cat, n.type)
    if (!spec) return n
    const params: Record<string, ParamValue> = {}
    for (const [k, v] of Object.entries(n.params)) {
      const ps = spec.params.find((p) => p.name === k)
      if (ps && ps.default !== undefined && ps.default !== null && ps.default === v) continue
      params[k] = v
    }
    return { ...n, params }
  })
  return { ...doc, nodes }
}

/** 规范序列化：固定键序 + 两空格缩进 + 末尾换行。与场景文件同法（D-049 ⑧）。 */
export function serialize(doc: DiagramDoc, cat: Catalog | null = null): string {
  const d = stripDefaults(doc, cat)
  const out = pick(d, TOP_ORDER)
  out.nodes = d.nodes.map((n) => pick(n, NODE_ORDER))
  out.edges = d.edges.map((e) => pick(e, EDGE_ORDER))
  if (d.observation_points) out.observation_points = d.observation_points.map((o) => pick(o, OP_ORDER))
  return JSON.stringify(out, null, 2) + '\n'
}

export function parse(text: string): { ok: true; doc: DiagramDoc } | { ok: false; error: string } {
  let v: unknown
  try { v = JSON.parse(text) } catch (e) { return { ok: false, error: (e as Error).message } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: '顶层不是对象' }
  const d = v as Partial<DiagramDoc>
  if (typeof d.diagram_id !== 'string') return { ok: false, error: '缺 diagram_id' }
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) return { ok: false, error: '缺 nodes 或 edges' }
  return { ok: true, doc: { ...(d as DiagramDoc), observation_points: d.observation_points ?? undefined } }
}

/** 生成不与既有 id 冲突的新 id：`tone`、`tone-2`、`tone-3`…（09 §6.4）。 */
export function nextId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const stem = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'node'
  if (!used.has(stem)) return stem
  for (let i = 2; i < 10000; i++) { const c = `${stem}-${i}`; if (!used.has(c)) return c }
  return `${stem}-${Date.now()}`
}

/**
 * 新建节点的初始参数：一律为空。
 * 有缺省值的由目录补，框图里不写（docs/diagram-format.md §3）；
 * 必填且无缺省的留空，面板据此标「待填」并让节点显示未校验态（09 §6.4 第 3 条）。
 */
export function initialParams(): Record<string, ParamValue> {
  return {}
}

/** 面板要标「待填」的参数：必填、无缺省、且用户还没填。 */
export function missingRequired(spec: { params: ParamSpec[] }, params: Record<string, ParamValue>): string[] {
  return spec.params
    .filter((p) => !p.internal && p.required && (p.default === undefined || p.default === null))
    .filter((p) => params[p.name] === undefined || params[p.name] === '')
    .map((p) => p.name)
}

/** 改节点 id 时同步更新连线与观测点的引用（09 §6.4 第 2 条）。 */
export function renameNode(doc: DiagramDoc, from: string, to: string): DiagramDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === from ? { ...n, id: to } : n)),
    edges: doc.edges.map((e) => ({
      ...e,
      from: e.from.node === from ? { ...e.from, node: to } : e.from,
      to: e.to.node === from ? { ...e.to, node: to } : e.to,
    })),
    observation_points: doc.observation_points?.map((o) => (o.node === from ? { ...o, node: to } : o)),
  }
}

/** 删节点时连带删掉它的连线与观测点，避免留下悬空引用（装载器会报 node_missing）。 */
export function removeNode(doc: DiagramDoc, id: string): DiagramDoc {
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => n.id !== id),
    edges: doc.edges.filter((e) => e.from.node !== id && e.to.node !== id),
    observation_points: doc.observation_points?.filter((o) => o.node !== id),
  }
}

/**
 * 场景绑定变更后，端口可能不再存在（`link:<emitter_id>` 按场景的辐射源生成，09 §6.8）。
 * 把引用了已消失端口的连线删掉，并报出删了哪几条，由界面提示。
 */
export function pruneEdges(doc: DiagramDoc, portsOf: (nodeId: string) => { in: string[]; out: string[] } | null): { doc: DiagramDoc; removed: DiagramEdge[] } {
  const removed: DiagramEdge[] = []
  const edges = doc.edges.filter((e) => {
    const a = portsOf(e.from.node), b = portsOf(e.to.node)
    const ok = !!a && !!b && a.out.includes(e.from.port) && b.in.includes(e.to.port)
    if (!ok) removed.push(e)
    return ok
  })
  return { doc: removed.length ? { ...doc, edges } : doc, removed }
}
