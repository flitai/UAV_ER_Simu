// 框图画布（09 §6，U-2）。文档是真相，React Flow 只是它的渲染与交互层。
//
// 贯穿本文件的一条原则：**画布不自行解释任何规则**。连线合法性查目录的 port_compat，
// 拒绝理由用目录原文，参数控件由 ParamSpec 生成。所以画布、服务端与引擎三处的校验必然一致。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyNodeChanges, Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type Edge, type Node, type NodeChange, type OnConnectStartParams,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ColumnLayout } from '../shell/ColumnLayout.js'
import { useAppState, useDispatch } from '../state/store.js'
import type { DiagramError } from '../state/types.js'
import { canConnect, connectionHint, findComponent, isCatalog, type Catalog, type ComponentSpec, type PortSpec } from '../api/catalog.js'
import { NodeCard, type NodeCardData } from './NodeCard.jsx'
import { Palette } from './Palette.jsx'
import { ParamPanel } from './ParamPanel.jsx'
import { summarize } from './format.js'
import { autoLayout } from './layout.js'
import { EXAMPLES } from './examples/index.js'
import { parseChain } from '../chain/compile.js'
import {
  emptyDoc, nextId, parse, pruneEdges, removeNode, renameNode, serialize,
  type DiagramDoc, type DiagramNode, type ObservationPoint,
} from './doc.js'

const NODE_TYPES = { cuav: NodeCard }
/** 稳定的空数组：行内 `[]` 每次渲染都是新身份，会让下游 useMemo 全部失效并把渲染带进死循环。 */
const NO_ERRORS: DiagramError[] = []

/** 动态端口在前端按同一规则本地推导（09 §6.8）：两侧读的是同一份场景文件，结果必然一致。 */
function portsOf(spec: ComponentSpec | null, node: DiagramNode, emitters: string[]): { in: PortSpec[]; out: PortSpec[] } {
  if (!spec) return { in: [], out: [] }
  const inp = spec.ports.in ?? []
  let out = spec.ports.out ?? []
  if (spec.dynamic_ports && node.scene_binding?.scenario_id) {
    const t = spec.dynamic_ports.type
    out = emitters.map((e) => ({ name: `link:${e}`, type: t }))
  }
  return { in: inp, out }
}

function Canvas() {
  const s = useAppState()
  const dispatch = useDispatch()
  const rf = useReactFlow()
  const wrap = useRef<HTMLDivElement | null>(null)
  const [sel, setSel] = useState<{ kind: 'node' | 'tap'; id: string } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [tab, setTab] = useState<'canvas' | 'source'>('canvas')
  const [backAsk, setBackAsk] = useState(false)
  const dragFrom = useRef<OnConnectStartParams | null>(null)

  const catalog: Catalog | null = isCatalog(s.components.catalog) ? s.components.catalog : null
  // 文档是真相。框图文件里 position 可选，手写与引擎自带的示例都没有，
  // 因此渲染前给没有位置的节点排一次位（layout.ts；已有位置的不动）。
  // 排位结果只用于渲染，不回写文档——回写会把「用户没摆过」变成「用户摆过」。
  const doc: DiagramDoc = useMemo(() => {
    const r = parse(s.diagram.text)
    return autoLayout(r.ok ? r.doc : emptyDoc(s.context.diagramId ?? 'untitled'))
  }, [s.diagram.text, s.context.diagramId])

  // 「回到典型链路」的判据：当前文档还解不解得回九个槽位（10 报告 §5.6）。
  // 用原始文本而不是上面那个 doc——`autoLayout` 会补 position，那是渲染用的加工品。
  // 解得开就直接回；解不开说明画布里增删过节点，回去只能新建一条链，必须先问（铁律 15）。
  const isChain = useMemo(() => {
    const r = parse(s.diagram.text)
    return r.ok && parseChain(r.doc) !== null
  }, [s.diagram.text])

  // 场景清单：下拉取 GET /api/v1/scenarios 的摘要；实体与站点的**标识**只有场景文档里才有，
  // 而文档只在场景视图载入了那个场景时才在手上。未载入时下拉为空并给提示，不猜标识。
  const scenarios = useMemo(() => {
    const doc = s.scene.scenario.doc as { emitters?: Array<{ id?: string }>; sites?: Array<{ id?: string }> } | null
    const cur = s.scene.scenario.id
    return s.scene.scenario.list.map((x) => ({
      id: x.scenario_id,
      loaded: x.scenario_id === cur,
      entities: x.scenario_id === cur ? (doc?.emitters ?? []).map((e) => e.id ?? '').filter(Boolean) : [],
      sites: x.scenario_id === cur ? (doc?.sites ?? []).map((e) => e.id ?? '').filter(Boolean) : [],
    }))
  }, [s.scene.scenario.list, s.scene.scenario.id, s.scene.scenario.doc])
  const emittersOf = useCallback((scenarioId: string | undefined) =>
    (scenarios.find((x) => x.id === scenarioId)?.entities ?? []), [scenarios])

  const commit = useCallback((next: DiagramDoc, label: string) => {
    dispatch({ type: 'diagram/setDoc', text: serialize(next, catalog), label })
  }, [dispatch, catalog])

  const errors = useMemo(
    () => (s.diagram.validation && !s.diagram.validation.ok ? s.diagram.validation.errors : NO_ERRORS),
    [s.diagram.validation])
  const errByNode = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const e of errors) if (e.node_id) m.set(e.node_id, [...(m.get(e.node_id) ?? []), e.port ?? ''])
    return m
  }, [errors])

  const derived: Node[] = useMemo(() => doc.nodes.map((n) => {
    const spec = catalog ? findComponent(catalog, n.type) : null
    const ports = portsOf(spec, n, emittersOf(n.scene_binding?.scenario_id))
    const bad = errByNode.get(n.id)
    const data: NodeCardData = {
      node: n, spec, ports,
      summary: summarize(n.params, (k) => spec?.params.find((p) => p.name === k)?.unit),
      status: bad ? 'error' : s.diagram.validation?.ok ? 'ok' : 'unchecked',
      errorPorts: (bad ?? []).filter(Boolean),
      taps: (doc.observation_points ?? []).filter((o) => o.node === n.id).map((o) => ({ id: o.id, port: o.port })),
      onTapClick: (id: string) => setSel({ kind: 'tap', id }),
    }
    return { id: n.id, type: 'cuav', position: n.position ?? { x: 40, y: 40 }, data, selected: sel?.kind === 'node' && sel.id === n.id }
  }), [doc, catalog, errByNode, s.diagram.validation, sel, emittersOf])

  /** 目录里查不到的节点类型。有它们在，连到它们的边一条都画不出来（见 NodeCard 的说明）。 */
  const unknownTypes = useMemo(() => {
    if (!catalog) return [] as string[]
    const out = new Set<string>()
    for (const n of doc.nodes) if (!findComponent(catalog, n.type)) out.add(n.type)
    return [...out].sort()
  }, [doc, catalog])
  const droppedEdges = useMemo(() => {
    if (!unknownTypes.length) return 0
    const bad = new Set(doc.nodes.filter((n) => unknownTypes.includes(n.type)).map((n) => n.id))
    return doc.edges.filter((e) => bad.has(e.from.node) || bad.has(e.to.node)).length
  }, [doc, unknownTypes])

  const edges: Edge[] = useMemo(() => doc.edges.flatMap((e, i) => {
    const src = doc.nodes.find((n) => n.id === e.from.node)
    if (!src) return []
    const spec = catalog ? findComponent(catalog, src.type) : null
    const t = portsOf(spec, src, emittersOf(src.scene_binding?.scenario_id)).out.find((p) => p.name === e.from.port)?.type
    // 参数流画虚线，在视觉上把慢变参数与 IQ 主干分开（09 §6.5）
    const dashed = t === 'SceneParamFrame' || t === 'ChannelPathSet'
    return [{
      id: e.id ?? `e${i}`, source: e.from.node, target: e.to.node,
      sourceHandle: e.from.port, targetHandle: e.to.port,
      style: dashed ? { strokeDasharray: '6 4' } : undefined,
      data: { type: t },
    }]
  }), [doc, catalog, emittersOf])

  const typeOfHandle = useCallback((nodeId: string | null, handle: string | null, side: 'in' | 'out') => {
    if (!nodeId || !handle || !catalog) return null
    const n = doc.nodes.find((x) => x.id === nodeId)
    if (!n) return null
    const p = portsOf(findComponent(catalog, n.type), n, emittersOf(n.scene_binding?.scenario_id))
    return (side === 'out' ? p.out : p.in).find((x) => x.name === handle)?.type ?? null
  }, [doc, catalog, emittersOf])

  /** 连线合法性：只查目录，理由用目录原文（09 §6.5）。 */
  const isValidConnection = useCallback((c: Connection | Edge) => {
    if (!catalog) return false
    const a = typeOfHandle(c.source, c.sourceHandle ?? null, 'out')
    const b = typeOfHandle(c.target, c.targetHandle ?? null, 'in')
    if (!a || !b) return false
    if (doc.edges.some((e) => e.to.node === c.target && e.to.port === c.targetHandle)) return false
    return canConnect(catalog, a, b).ok
  }, [catalog, typeOfHandle, doc.edges])

  const onConnect = useCallback((c: Connection) => {
    if (!catalog || !c.source || !c.target || !c.sourceHandle || !c.targetHandle) return
    const a = typeOfHandle(c.source, c.sourceHandle, 'out')
    const b = typeOfHandle(c.target, c.targetHandle, 'in')
    if (!a || !b) return
    if (doc.edges.some((e) => e.to.node === c.target && e.to.port === c.targetHandle)) {
      setHint('一个输入口只能连一条边'); return
    }
    const v = canConnect(catalog, a, b)
    if (!v.ok) { setHint(`${v.reason}${connectionHint(a, b) ? '。' + connectionHint(a, b) : ''}`); return }
    setHint(null)
    const id = `e${doc.edges.length + 1}`
    commit({ ...doc, edges: [...doc.edges, { id, from: { node: c.source, port: c.sourceHandle }, to: { node: c.target, port: c.targetHandle } }] }, '连线')
  }, [catalog, doc, typeOfHandle, commit])

  const addNode = useCallback((spec: ComponentSpec, at?: { x: number; y: number }) => {
    const id = nextId(spec.type, doc.nodes.map((n) => n.id))
    const pos = at ?? { x: 60 + doc.nodes.length * 40, y: 60 + doc.nodes.length * 30 }
    const n: DiagramNode = { id, type: spec.type, params: {}, position: { x: Math.round(pos.x / 16) * 16, y: Math.round(pos.y / 16) * 16 } }
    commit({ ...doc, nodes: [...doc.nodes, n] }, `添加 ${spec.display_name}`)
    setSel({ kind: 'node', id })
  }, [doc, commit])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const type = e.dataTransfer.getData('application/cuav-component')
    const spec = type && catalog ? findComponent(catalog, type) : null
    if (!spec) return
    addNode(spec, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }, [catalog, rf, addNode])

  // 拖动期间画布自己持有节点位置。若每帧都从文档重新推导，节点会被不断拽回文档里的旧位置，
  // 表现为「拉动滞后、不跟着光标走」。所以：变化先落到本地状态（拖动因此跟手），
  // 只在**松手时**提交一次到文档——撤销栈也因此是一次拖动一步，而不是每帧一步。
  const [rfNodes, setRfNodes] = useState<Node[]>(derived)
  const nodesRef = useRef<Node[]>(derived)
  const dragging = useRef(false)
  useEffect(() => {
    if (dragging.current) return   // 拖动中不让文档回灌，否则又会打架
    nodesRef.current = derived
    setRfNodes(derived)
  }, [derived])

  const onNodesChange = useCallback((chs: NodeChange[]) => {
    const next = applyNodeChanges(chs, nodesRef.current)
    nodesRef.current = next
    setRfNodes(next)
    let ended = false
    for (const ch of chs) {
      if (ch.type === 'position') { if (ch.dragging) dragging.current = true; else ended = true }
      else if (ch.type === 'select' && ch.selected) setSel({ kind: 'node', id: ch.id })
    }
    if (!ended) return
    dragging.current = false
    const pos = new Map(next.map((n) => [n.id, n.position]))
    const moved = doc.nodes.some((n) => {
      const p = pos.get(n.id)
      return !!p && (n.position?.x !== p.x || n.position?.y !== p.y)
    })
    if (moved) commit({ ...doc, nodes: doc.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })) }, '移动节点')
  }, [doc, commit])

  const del = useCallback(() => {
    if (!sel) return
    if (sel.kind === 'node') commit(removeNode(doc, sel.id), '删除节点')
    else commit({ ...doc, observation_points: (doc.observation_points ?? []).filter((o) => o.id !== sel.id) }, '删除观测点')
    setSel(null)
  }, [sel, doc, commit])

  const addTap = useCallback((nodeId: string, port: string) => {
    const id = nextId(port.replace(/[^a-z0-9_-]/gi, '') || 'op', (doc.observation_points ?? []).map((o) => o.id))
    const op: ObservationPoint = { id, node: nodeId, port, products: ['spectrum', 'envelope'] }
    commit({ ...doc, observation_points: [...(doc.observation_points ?? []), op] }, '打观测点')
    setSel({ kind: 'tap', id })
  }, [doc, commit])

  // 键盘：Delete 删选中；Ctrl+Shift+D 复制（Ctrl+D 是 Chromium 收藏，09 §11）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); del() }
      else if (e.key === 'D' && e.ctrlKey && e.shiftKey && sel?.kind === 'node') {
        e.preventDefault()
        const src = doc.nodes.find((n) => n.id === sel.id)
        if (!src) return
        const id = nextId(src.type, doc.nodes.map((n) => n.id))
        commit({ ...doc, nodes: [...doc.nodes, { ...src, id, position: { x: (src.position?.x ?? 0) + 32, y: (src.position?.y ?? 0) + 32 } }] }, '复制节点')
        setSel({ kind: 'node', id })
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [del, sel, doc, commit])

  const selNode = sel?.kind === 'node' ? doc.nodes.find((n) => n.id === sel.id) ?? null : null
  const selTap = sel?.kind === 'tap' ? (doc.observation_points ?? []).find((o) => o.id === sel.id) ?? null : null

  return (
    <ColumnLayout
      left={<Palette catalog={catalog} onAdd={(c) => addNode(c)} />}
      center={
        <div className="diagram-canvas" ref={wrap} onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }} data-canvas>
          <div className="diagram-tools">
            <button type="button" data-action="open-chain" title="回到框图页的默认形态（典型链路视图）"
              onClick={() => {
                if (isChain) dispatch({ type: 'ui/navigate', view: 'diagram', canvas: false })
                else setBackAsk(true)
              }}>← 回到典型链路</button>
            <label>示例框图
              <select data-action="example" value="" onChange={(e) => {
                const ex = EXAMPLES.find((x) => x.id === e.target.value)
                if (ex) { dispatch({ type: 'diagram/loadExample', text: ex.text }); setSel(null) }
              }}>
                <option value="">选择…</option>
                {EXAMPLES.map((ex) => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
              </select>
            </label>
            <button data-action="undo" disabled={s.diagram.undo.past.length === 0}
              onClick={() => dispatch({ type: 'diagram/undo' })} title="撤销 Ctrl+Z">↶</button>
            <button data-action="redo" disabled={s.diagram.undo.future.length === 0}
              onClick={() => dispatch({ type: 'diagram/redo' })} title="重做 Ctrl+Y">↷</button>
            <span className="muted">{s.context.diagramId ?? '未命名'}{s.diagram.dirty ? ' ●' : ''}</span>
            <span className="muted">{doc.nodes.length} 节点 · {doc.edges.length} 连线 · {(doc.observation_points ?? []).length} 观测点</span>
            {s.ui.devMode && (
              <span className="diagram-tabs" data-dev="source-tab">
                <button data-tab="canvas" className={tab === 'canvas' ? 'on' : ''} onClick={() => setTab('canvas')}>画布</button>
                <button data-tab="source" className={tab === 'source' ? 'on' : ''} onClick={() => setTab('source')}>源码</button>
              </span>
            )}
            <span className="muted right">Ctrl+Enter 校验并运行</span>
          </div>
          {backAsk && !isChain && (
            <div className="diagram-back-ask" role="alertdialog" data-chain-back-ask>
              <span>当前框图已不是典型链路的形状（画布里增删过节点或连线），解不回九个槽位。
                回去只能新建一条链——<b>新建那一下</b>当前改动才会丢；在那之前改动还在，可以再回画布。</span>
              <button type="button" data-action="open-chain-confirm"
                onClick={() => { setBackAsk(false); dispatch({ type: 'ui/navigate', view: 'diagram', canvas: false }) }}>仍要回去</button>
              <button type="button" data-action="open-chain-cancel" onClick={() => setBackAsk(false)}>留在画布</button>
            </div>
          )}
          <textarea className="diagram-text" spellCheck={false} value={s.diagram.text} data-diagram-text
            hidden={!(s.ui.devMode && tab === 'source')}
            onChange={(e) => dispatch({ type: 'diagram/setText', text: e.target.value })} />
          <div className="rf-host" hidden={s.ui.devMode && tab === 'source'}>
          <ReactFlow
            nodes={rfNodes} edges={edges} nodeTypes={NODE_TYPES}
            snapToGrid snapGrid={[16, 16]}
            onNodesChange={onNodesChange} onConnect={onConnect} isValidConnection={isValidConnection}
            onConnectStart={(_, p) => { dragFrom.current = p }}
            onEdgeClick={(_, e) => commit({ ...doc, edges: doc.edges.filter((x, i) => (x.id ?? `e${i}`) !== e.id) }, '删除连线')}
            onNodeContextMenu={(ev, n) => {
              ev.preventDefault()
              const spec = catalog ? findComponent(catalog, doc.nodes.find((x) => x.id === n.id)?.type ?? '') : null
              const node = doc.nodes.find((x) => x.id === n.id)
              if (!spec || !node) return
              const iq = portsOf(spec, node, emittersOf(node.scene_binding?.scenario_id)).out.filter((p) => p.type === 'IQStream')
              if (iq.length === 0) { setHint('观测点只能挂在 IQ 输出口上'); return }
              addTap(n.id, iq[0]!.name)
            }}
            onPaneClick={() => setSel(null)}
            fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} proOptions={{ hideAttribution: false }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
          </div>
          {hint && <div className="canvas-hint" data-canvas-hint onClick={() => setHint(null)}>{hint}</div>}
          {unknownTypes.length > 0 && (
            <div className="canvas-stale" data-unknown-banner>
              组件目录里没有 {unknownTypes.join('、')}
              {droppedEdges > 0 ? `，${droppedEdges} 条连线因此没有画出来` : ''}。
              引擎重建过而应用服务没重启时会这样：重启服务即可刷新目录。
            </div>
          )}
          <ol className="diagram-errors" data-diagram-errors>
            {s.diagram.parseError && <li className="error"><b>json_parse</b> {s.diagram.parseError}</li>}
            {errors.map((e, i) => (
              <li key={i} className="error" onClick={() => e.node_id && setSel({ kind: 'node', id: e.node_id })}>
                <code className="chip">{e.node_id || '—'}</code><code className="chip">{e.port || '—'}</code>
                <b>{e.code}</b> {e.message}
              </li>
            ))}
            {s.diagram.validation?.ok && <li className="ok">校验通过，已提交</li>}
          </ol>
        </div>
      }
      right={
        <ParamPanel
          catalog={catalog} node={selNode} tap={selTap} scenarios={scenarios} devMode={s.ui.devMode}
          onParam={(name, v) => {
            if (!selNode) return
            const params = { ...selNode.params }
            if (v === undefined) delete params[name]; else params[name] = v
            commit({ ...doc, nodes: doc.nodes.map((n) => (n.id === selNode.id ? { ...n, params } : n)) }, `改 ${name}`)
          }}
          onField={(patch) => {
            if (!selNode) return
            let next = doc
            if (patch.id && patch.id !== selNode.id) { next = renameNode(next, selNode.id, patch.id); setSel({ kind: 'node', id: patch.id }) }
            const id = patch.id ?? selNode.id
            next = { ...next, nodes: next.nodes.map((n) => (n.id === id ? { ...n, ...patch, id } : n)) }
            if (patch.scene_binding !== undefined) {
              const pruned = pruneEdges(next, (nid) => {
                const nn = next.nodes.find((x) => x.id === nid)
                if (!nn || !catalog) return null
                const p = portsOf(findComponent(catalog, nn.type), nn, emittersOf(nn.scene_binding?.scenario_id))
                return { in: p.in.map((x) => x.name), out: p.out.map((x) => x.name) }
              })
              if (pruned.removed.length) setHint(`场景绑定改变，已删除 ${pruned.removed.length} 条端口已不存在的连线`)
              next = pruned.doc
            }
            commit(next, '改节点')
          }}
          onTap={(patch) => {
            if (!selTap) return
            const id = patch.id ?? selTap.id
            commit({ ...doc, observation_points: (doc.observation_points ?? []).map((o) => (o.id === selTap.id ? { ...o, ...patch, id } : o)) }, '改观测点')
            if (patch.id) setSel({ kind: 'tap', id })
          }}
        />
      }
    />
  )
}

export function DiagramView() {
  return <ReactFlowProvider><Canvas /></ReactFlowProvider>
}
