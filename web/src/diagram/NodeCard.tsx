// 画布上的节点（09 §6.3）：类别条 + 显示名 + id + 参数摘要 + 端口把手 + 校验徽标。
// 节点宽度固定 200 px，使对齐与吸附可预期；高度随参数摘要行数变化。
// 节点上**只显示校验态**，不显示结果四态——四态属于块与产品（08 报告 §2），节点不是数据产物。

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { CATEGORY_COLOR, PORT_SHAPE, type ComponentSpec, type PortSpec } from '../api/catalog.js'
import type { DiagramNode } from './doc.js'

export interface NodeCardData extends Record<string, unknown> {
  node: DiagramNode
  spec: ComponentSpec | null
  ports: { in: PortSpec[]; out: PortSpec[] }
  summary: string[]
  status: 'unchecked' | 'ok' | 'error'
  errorPorts: string[]
  taps: Array<{ id: string; port: string }>
  /** 点观测点标记打开它的面板；不给则标记不可点。 */
  onTapClick?: (id: string) => void
}

const SHAPE_CLASS = { circle: 'h-circle', diamond: 'h-diamond', square: 'h-square', triangle: 'h-triangle' } as const

function PortHandles({ ports, side, errorPorts }: { ports: PortSpec[]; side: 'in' | 'out'; errorPorts: string[] }) {
  const pos = side === 'in' ? Position.Left : Position.Right
  return (
    <>
      {ports.map((p, i) => (
        <Handle
          key={p.name}
          id={p.name}
          type={side === 'in' ? 'target' : 'source'}
          position={pos}
          className={`rf-handle ${SHAPE_CLASS[PORT_SHAPE[p.type]]}${errorPorts.includes(p.name) ? ' bad' : ''}`}
          style={{ top: 44 + i * 18 }}
          data-port={p.name}
          data-port-type={p.type}
          title={`${p.name} · ${p.type}`}
        />
      ))}
    </>
  )
}

export function NodeCard({ data, selected }: NodeProps) {
  const d = data as NodeCardData
  // 目录里查不到这个组件：**不能装成一张正常卡片**。没有 spec 就没有端口，没有端口
  // React Flow 会把连到它的每一条边静默丢掉——画面上看起来只是「连线少了」，
  // 根本看不出是目录的问题（实测踩到过：九环节链只画出一条连线）。铁律 15。
  const unknown = !d.spec
  const cat = d.spec?.category ?? 'algorithm'
  const color = unknown ? '#b91c1c' : CATEGORY_COLOR[cat]
  const badge = unknown ? '?' : d.status === 'ok' ? '✓' : d.status === 'error' ? '✕' : ''
  return (
    <div
      className={`rf-node${selected ? ' sel' : ''}${d.status === 'error' || unknown ? ' bad' : ''}${unknown ? ' unknown' : ''}`}
      data-node={d.node.id}
      data-status={unknown ? 'unknown' : d.status}
      data-category={cat}
      data-unknown={unknown ? '1' : undefined}
    >
      <div className="rf-cat" style={{ background: color }} />
      <div className="rf-head">
        <span className="rf-catname" style={{ color }}>{d.spec?.display_name ?? d.node.type}</span>
        <span className={`rf-badge ${d.status}`}>{badge}</span>
      </div>
      <div className="rf-label">{d.node.label ?? d.spec?.display_name ?? d.node.type}</div>
      <div className="rf-id">{d.node.id}</div>
      {unknown && (
        <div className="rf-unknown" data-unknown-note>
          组件目录里没有 {d.node.type}：没有端口，连到它的线画不出来。
          若引擎刚重建过，重启应用服务以刷新目录
        </div>
      )}
      {!unknown && d.summary.length > 0 && (
        <div className="rf-summary">{d.summary.slice(0, 2).map((t, i) => <div key={i}>{t}</div>)}</div>
      )}
      <PortHandles ports={d.ports.in} side="in" errorPorts={d.errorPorts} />
      <PortHandles ports={d.ports.out} side="out" errorPorts={d.errorPorts} />
      {d.taps.length > 0 && (
        <div className="rf-taps">
          {d.taps.map((t) => (
            <span key={t.id} className="rf-tap" data-tap={t.id} title={`观测点 ${t.id}（${t.port}）`}
              onClick={(e) => { e.stopPropagation(); d.onTapClick?.(t.id) }}>◉ {t.id}</span>
          ))}
        </div>
      )}
    </div>
  )
}
